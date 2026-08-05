import QRCode from "qrcode";
import { registerSW } from "virtual:pwa-register";
import "./style.css";
import { LTDecoder, LTEncoder } from "./core/fountain";
import { fnv1a, packFile, packFrame, parseFrame, streamIdentity, unpackFile, type FrameHeader } from "./core/protocol";

registerSW({ immediate: true });

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const fileInput = byId<HTMLInputElement>("file");
const blockSelect = byId<HTMLSelectElement>("block");
const fpsSelect = byId<HTMLSelectElement>("fps");
const stopButton = byId<HTMLButtonElement>("stop");
const canvas = byId<HTMLCanvasElement>("qr");
const sendStatus = byId<HTMLDivElement>("send-status");
const cameraButton = byId<HTMLButtonElement>("camera");
const cameraStopButton = byId<HTMLButtonElement>("camera-stop");
const workersSelect = byId<HTMLSelectElement>("workers");
const video = byId<HTMLVideoElement>("video");
const receiveStatus = byId<HTMLDivElement>("receive-status");
const download = byId<HTMLAnchorElement>("download");

for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab,.panel").forEach((node) => node.classList.remove("active"));
    tab.classList.add("active");
    byId<HTMLElement>(tab.dataset.tab!).classList.add("active");
  });
}

let sendGeneration = 0;
let activeObjectUrl: string | null = null;

function renderQr(frame: Uint8Array): { version: number; modules: number } {
  const qr = QRCode.create(
    [{ data: frame, mode: "byte" } as never],
    { errorCorrectionLevel: "L", maskPattern: 4 },
  );
  const margin = 4;
  const moduleCount = qr.modules.size;
  const total = moduleCount + margin * 2;
  const maxPixels = Math.min(620, Math.max(280, window.innerWidth - 72));
  const scale = Math.max(1, Math.floor(maxPixels / total));
  canvas.width = total * scale;
  canvas.height = total * scale;
  const context = canvas.getContext("2d")!;
  context.imageSmoothingEnabled = false;
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "black";
  for (let y = 0; y < moduleCount; y++) {
    for (let x = 0; x < moduleCount; x++) {
      if (qr.modules.data[y * moduleCount + x]) context.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
    }
  }
  return { version: qr.version, modules: moduleCount };
}

async function startSender(file: File): Promise<void> {
  const generation = ++sendGeneration;
  stopButton.disabled = false;
  sendStatus.textContent = `Đang đóng gói ${file.name}…`;
  const source = new Uint8Array(await file.arrayBuffer());
  const packed = await packFile(file.name, file.type, source);
  if (generation !== sendGeneration) return;
  const blockLen = Number(blockSelect.value);
  const fps = Number(fpsSelect.value);
  const sessionId = crypto.getRandomValues(new Uint16Array(1))[0] || 1;
  const fountain = new LTEncoder(packed.container, blockLen, sessionId);
  if (fountain.k > 0xffff) throw new Error("Quá nhiều source block; hãy tăng payload/frame.");
  const baseHeader: FrameHeader = {
    sessionId,
    seq: 0,
    k: fountain.k,
    blockLen,
    totalLen: packed.container.length,
    payloadFnv: fnv1a(packed.container),
  };
  let sequence = 0;
  let nextAt = performance.now();
  let qrVersion = 0;
  const tick = (now: number) => {
    if (generation !== sendGeneration) return;
    requestAnimationFrame(tick);
    if (now < nextAt) return;
    const frame = packFrame({ ...baseHeader, seq: sequence }, fountain.encode(sequence));
    const qr = renderQr(frame);
    qrVersion ||= qr.version;
    sequence++;
    nextAt += 1000 / fps;
    if (now - nextAt > 1000 / fps * 3) nextAt = now + 1000 / fps;
    sendStatus.textContent = [
      `${file.name} · ${(file.size / 1024).toFixed(1)} KiB`,
      `K=${fountain.k} · block=${blockLen} B · QR V${qrVersion} · ECC L · ${fps} fps`,
      `${packed.compression === "gzip" ? `gzip ${packed.transmittedSize} B` : "không nén"} · frame #${sequence}`,
    ].join("\n");
  };
  requestAnimationFrame(tick);
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  void startSender(file).catch((error) => {
    sendStatus.textContent = error instanceof Error ? error.message : String(error);
    stopButton.disabled = true;
  });
});
blockSelect.addEventListener("change", () => { const file = fileInput.files?.[0]; if (file) void startSender(file); });
fpsSelect.addEventListener("change", () => { const file = fileInput.files?.[0]; if (file) void startSender(file); });
stopButton.addEventListener("click", () => {
  sendGeneration++;
  stopButton.disabled = true;
  sendStatus.textContent = "Đã dừng luồng gửi.";
  const context = canvas.getContext("2d")!;
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
});

class DecodeWorkerPool {
  private workers: { worker: Worker; busy: boolean }[] = [];
  private nextId = 0;
  constructor(count: number, private readonly onBytes: (bytes: Uint8Array) => void) {
    for (let index = 0; index < count; index++) {
      const state = { worker: new Worker(new URL("./decode-worker.ts", import.meta.url), { type: "module" }), busy: false };
      state.worker.onmessage = (event: MessageEvent<{ id: number; bytes: Uint8Array | null }>) => {
        state.busy = false;
        if (event.data.bytes) this.onBytes(Uint8Array.from(event.data.bytes));
      };
      this.workers.push(state);
    }
  }
  submit(image: ImageData): boolean {
    const state = this.workers.find((worker) => !worker.busy);
    if (!state) return false;
    state.busy = true;
    state.worker.postMessage({ id: this.nextId++, image }, [image.data.buffer as ArrayBuffer]);
    return true;
  }
  close(): void { for (const state of this.workers) state.worker.terminate(); this.workers = []; }
}

let stream: MediaStream | null = null;
let pool: DecodeWorkerPool | null = null;
let cameraGeneration = 0;
let receiverIdentity: string | null = null;
let decoder: LTDecoder | null = null;
let expectedFNV = 0;
let framesDecoded = 0;
let framesDropped = 0;
let completing = false;

async function acceptFrame(bytes: Uint8Array): Promise<void> {
  const parsed = parseFrame(bytes);
  if (!parsed || completing) return;
  const identity = streamIdentity(parsed.header);
  if (identity !== receiverIdentity) {
    receiverIdentity = identity;
    decoder = new LTDecoder(parsed.header.k, parsed.header.blockLen, parsed.header.sessionId, parsed.header.totalLen);
    expectedFNV = parsed.header.payloadFnv;
    framesDecoded = 0;
    download.hidden = true;
    receiveStatus.textContent = `Đã khóa luồng ${identity}`;
  }
  framesDecoded++;
  decoder!.addFrame(parsed.header.seq, parsed.block);
  const estimate = Math.min(99, decoder!.framesNew / Math.max(1, decoder!.k * 1.15) * 100);
  receiveStatus.textContent = `frames=${decoder!.framesNew} · solved=${decoder!.solvedCount}/${decoder!.k} · ~${estimate.toFixed(1)}% · dropped=${framesDropped}`;
  const container = decoder!.assemble();
  if (!container) return;
  completing = true;
  try {
    if (fnv1a(container) !== expectedFNV) throw new Error("FNV-1a container không khớp.");
    const file = await unpackFile(container);
    if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.type }));
    download.href = activeObjectUrl;
    download.download = file.name;
    download.textContent = `Tải ${file.name}`;
    download.hidden = false;
    receiveStatus.textContent = `Hoàn tất: ${file.name} · ${(file.bytes.length / 1024).toFixed(1)} KiB · SHA-256 hợp lệ.`;
  } catch (error) {
    receiveStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    completing = false;
    receiverIdentity = null;
    decoder = null;
  }
}

async function startCamera(): Promise<void> {
  const generation = ++cameraGeneration;
  download.hidden = true;
  framesDropped = 0;
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  document.querySelector(".camera-wrap")?.classList.add("live");
  cameraButton.disabled = true;
  cameraStopButton.disabled = false;
  pool = new DecodeWorkerPool(Number(workersSelect.value), (bytes) => void acceptFrame(bytes));
  const capture = document.createElement("canvas");
  const context = capture.getContext("2d", { willReadFrequently: true })!;
  let lastCapture = 0;
  const loop = (now: number) => {
    if (generation !== cameraGeneration || !stream || !pool) return;
    requestAnimationFrame(loop);
    if (now - lastCapture < 1000 / 30 || video.videoWidth === 0) return;
    lastCapture = now;
    const maxWidth = 1280;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    capture.width = Math.floor(video.videoWidth * scale);
    capture.height = Math.floor(video.videoHeight * scale);
    context.drawImage(video, 0, 0, capture.width, capture.height);
    const image = context.getImageData(0, 0, capture.width, capture.height);
    if (!pool.submit(image)) framesDropped++;
  };
  receiveStatus.textContent = "Camera đang chạy; đưa QR động vào giữa khung hình.";
  requestAnimationFrame(loop);
}

function stopCamera(): void {
  cameraGeneration++;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  pool?.close();
  pool = null;
  video.srcObject = null;
  cameraButton.disabled = false;
  cameraStopButton.disabled = true;
  document.querySelector(".camera-wrap")?.classList.remove("live");
  receiveStatus.textContent = "Camera đã tắt.";
}

cameraButton.addEventListener("click", () => void startCamera().catch((error) => {
  receiveStatus.textContent = `Không mở được camera: ${error instanceof Error ? error.message : String(error)}. Camera cần HTTPS hoặc localhost.`;
}));
cameraStopButton.addEventListener("click", stopCamera);
workersSelect.addEventListener("change", () => { if (stream) { stopCamera(); void startCamera(); } });
window.addEventListener("beforeunload", () => { stopCamera(); if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl); });
