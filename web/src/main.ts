import QRCode from "qrcode";
import { registerSW } from "virtual:pwa-register";
import "./style.css";
import { LTDecoder, LTEncoder } from "./core/fountain";
import {
  fnv1a,
  packFile,
  packFrame,
  parseFrame,
  streamIdentity,
  unpackFile,
  type FrameHeader,
} from "./core/protocol";

registerSW({ immediate: true });

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const LITE_RECOMMENDED_BYTES = 8 * 1024 * 1024;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}`);
  return element as T;
};

const fileInput = byId<HTMLInputElement>("file");
const senderProfileSelect = byId<HTMLSelectElement>("sender-profile");
const senderProfileNote = byId<HTMLElement>("sender-profile-note");
const blockSelect = byId<HTMLSelectElement>("block");
const fpsSelect = byId<HTMLSelectElement>("fps");
const stopButton = byId<HTMLButtonElement>("stop");
const canvas = byId<HTMLCanvasElement>("qr");
const sendStatus = byId<HTMLElement>("send-status");

const cameraButton = byId<HTMLButtonElement>("camera");
const cameraStopButton = byId<HTMLButtonElement>("camera-stop");
const receiverProfileSelect = byId<HTMLSelectElement>("receiver-profile");
const receiverProfileNote = byId<HTMLElement>("receiver-profile-note");
const workersSelect = byId<HTMLSelectElement>("workers");
const video = byId<HTMLVideoElement>("video");
const receiveStatus = byId<HTMLElement>("receive-status");
const download = byId<HTMLAnchorElement>("download");

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

type PanelName = "home" | "send" | "receive";
const panelNames: PanelName[] = ["home", "send", "receive"];

function isPanelName(value: string): value is PanelName {
  return panelNames.includes(value as PanelName);
}

function openPanel(name: PanelName, updateHash = true, scroll = false): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab[data-tab]")) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }

  for (const panelName of panelNames) {
    const panel = byId<HTMLElement>(panelName);
    const active = panelName === name;
    panel.classList.toggle("active", active);
    panel.toggleAttribute("hidden", !active);
  }

  if (updateHash) {
    const target = name === "home" ? `${location.pathname}${location.search}` : `#${name}`;
    history.replaceState(null, "", target);
  }
  if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
}

for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab[data-tab]")) {
  tab.addEventListener("click", () => {
    const name = tab.dataset.tab ?? "home";
    if (isPanelName(name)) openPanel(name, true, true);
  });
}

for (const control of document.querySelectorAll<HTMLElement>("[data-open-tab]")) {
  control.addEventListener("click", () => {
    const name = control.dataset.openTab ?? "home";
    if (isPanelName(name)) openPanel(name, true, true);
  });
}

document.querySelector<HTMLElement>("[data-home]")?.addEventListener("click", () => {
  openPanel("home", true, true);
});

window.addEventListener("hashchange", () => {
  const name = location.hash.slice(1);
  openPanel(isPanelName(name) ? name : "home", false);
});

const initialPanel = location.hash.slice(1);
openPanel(isPanelName(initialPanel) ? initialPanel : "home", false);

// ---------------------------------------------------------------------------
// Sender profiles and animated QR output
// ---------------------------------------------------------------------------

const SENDER_PROFILES = {
  lite: {
    label: "Lite",
    block: 250,
    fps: 10,
    note: "Lite giảm mật độ QR và tải giải mã; phù hợp camera cũ, CPU yếu và file nhỏ dưới khoảng 8 MB.",
  },
  reliable: {
    label: "Reliable",
    block: 700,
    fps: 12,
    note: "Reliable ưu tiên xác suất quét trong ánh sáng khó, khoảng cách xa hoặc camera trung bình.",
  },
  balanced: {
    label: "Balanced",
    block: 1100,
    fps: 18,
    note: "Balanced phù hợp với phần lớn điện thoại và laptop hiện đại.",
  },
  fast: {
    label: "Fast",
    block: 1450,
    fps: 24,
    note: "Fast cần màn hình sáng, camera tốt, giữ máy ổn định và QR chiếm phần lớn khung hình.",
  },
} as const;

type SenderProfileName = keyof typeof SENDER_PROFILES;

function isSenderProfileName(value: string): value is SenderProfileName {
  return value in SENDER_PROFILES;
}

function updateSenderProfileNote(): void {
  const name = senderProfileSelect.value;
  if (isSenderProfileName(name)) {
    senderProfileNote.textContent = SENDER_PROFILES[name].note;
    return;
  }
  senderProfileNote.textContent = `Tùy chỉnh: ${blockSelect.value} B mỗi frame · ${fpsSelect.value} fps. Giảm payload trước khi tăng QR ECC.`;
}

function applySenderProfile(name: SenderProfileName): void {
  const profile = SENDER_PROFILES[name];
  blockSelect.value = String(profile.block);
  fpsSelect.value = String(profile.fps);
  updateSenderProfileNote();
}

function syncSenderProfileFromAdvanced(): void {
  const block = Number(blockSelect.value);
  const fps = Number(fpsSelect.value);
  const match = Object.entries(SENDER_PROFILES).find(([, profile]) => profile.block === block && profile.fps === fps);
  senderProfileSelect.value = match?.[0] ?? "custom";
  updateSenderProfileNote();
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

  const context = canvas.getContext("2d");
  if (!context) throw new Error("Không tạo được canvas QR.");
  context.imageSmoothingEnabled = false;
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "black";

  for (let y = 0; y < moduleCount; y++) {
    for (let x = 0; x < moduleCount; x++) {
      if (qr.modules.data[y * moduleCount + x]) {
        context.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
      }
    }
  }
  return { version: qr.version, modules: moduleCount };
}

async function startSender(file: File): Promise<void> {
  if (file.size > MAX_FILE_BYTES) throw new Error("File vượt giới hạn 64 MB của ứng dụng Web.");

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
  if (fountain.k > 0xffff) {
    throw new Error("Profile tạo quá nhiều source block; hãy tăng payload/frame hoặc chọn file nhỏ hơn.");
  }

  const baseHeader: FrameHeader = {
    sessionId,
    seq: 0,
    k: fountain.k,
    blockLen,
    totalLen: packed.container.length,
    payloadFnv: fnv1a(packed.container),
  };

  const selectedProfile = senderProfileSelect.value;
  const profileLabel = isSenderProfileName(selectedProfile)
    ? SENDER_PROFILES[selectedProfile].label
    : "Custom";
  const liteWarning = selectedProfile === "lite" && file.size > LITE_RECOMMENDED_BYTES
    ? " · khuyến nghị đổi Reliable/Balanced vì file vượt 8 MB"
    : "";

  let sequence = 0;
  let nextAt = performance.now();
  let qrVersion = 0;

  const tick = (now: number): void => {
    if (generation !== sendGeneration) return;
    requestAnimationFrame(tick);
    if (now < nextAt) return;

    const frame = packFrame({ ...baseHeader, seq: sequence }, fountain.encode(sequence));
    const qr = renderQr(frame);
    qrVersion ||= qr.version;
    sequence++;
    nextAt += 1000 / fps;
    if (now - nextAt > (1000 / fps) * 3) nextAt = now + 1000 / fps;

    sendStatus.textContent = [
      `${file.name} · ${(file.size / 1024).toFixed(1)} KiB · profile ${profileLabel}${liteWarning}`,
      `K=${fountain.k} · block=${blockLen} B · QR V${qrVersion} · ECC L · mask 4 · ${fps} fps`,
      `${packed.compression === "gzip" ? `gzip ${packed.transmittedSize} B` : "không nén"} · frame #${sequence} · session ${sessionId}`,
    ].join("\n");
  };

  requestAnimationFrame(tick);
}

function restartSenderIfReady(): void {
  const file = fileInput.files?.[0];
  if (!file) return;
  void startSender(file).catch((error: unknown) => {
    sendStatus.textContent = error instanceof Error ? error.message : String(error);
    stopButton.disabled = true;
  });
}

fileInput.addEventListener("change", restartSenderIfReady);

senderProfileSelect.addEventListener("change", () => {
  const name = senderProfileSelect.value;
  if (isSenderProfileName(name)) applySenderProfile(name);
  else updateSenderProfileNote();
  restartSenderIfReady();
});

blockSelect.addEventListener("change", () => {
  syncSenderProfileFromAdvanced();
  restartSenderIfReady();
});

fpsSelect.addEventListener("change", () => {
  syncSenderProfileFromAdvanced();
  restartSenderIfReady();
});

stopButton.addEventListener("click", () => {
  sendGeneration++;
  stopButton.disabled = true;
  sendStatus.textContent = "Đã dừng luồng gửi.";
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
});

updateSenderProfileNote();

// ---------------------------------------------------------------------------
// Receiver profiles, worker pool and integrity verification
// ---------------------------------------------------------------------------

const RECEIVER_PROFILES = {
  lite: {
    label: "Lite",
    maxWidth: 720,
    captureFps: 12,
    workers: 1,
    idealWidth: 1280,
    note: "Lite capture tối đa 720 px ở 12 fps và dùng 1 worker; phù hợp CPU yếu hoặc camera cũ.",
  },
  balanced: {
    label: "Balanced",
    maxWidth: 1280,
    captureFps: 24,
    workers: 3,
    idealWidth: 1920,
    note: "Balanced capture tối đa 1280 px ở 24 fps và dùng 3 worker giải QR.",
  },
  fast: {
    label: "Fast",
    maxWidth: 1600,
    captureFps: 30,
    workers: 4,
    idealWidth: 2560,
    note: "Fast capture tối đa 1600 px ở 30 fps và dùng 4 worker; cần thiết bị mạnh và đủ sáng.",
  },
} as const;

type ReceiverProfileName = keyof typeof RECEIVER_PROFILES;
type ReceiverSettings = {
  label: string;
  maxWidth: number;
  captureFps: number;
  workers: number;
  idealWidth: number;
  note: string;
};

function isReceiverProfileName(value: string): value is ReceiverProfileName {
  return value in RECEIVER_PROFILES;
}

function customReceiverSettings(): ReceiverSettings {
  const workers = Number(workersSelect.value);
  if (workers <= 1) {
    return { label: "Custom Lite", maxWidth: 720, captureFps: 12, workers: 1, idealWidth: 1280, note: "Tùy chỉnh 1 worker: 720 px · 12 fps." };
  }
  if (workers === 2) {
    return { label: "Custom", maxWidth: 960, captureFps: 18, workers: 2, idealWidth: 1600, note: "Tùy chỉnh 2 worker: 960 px · 18 fps." };
  }
  if (workers === 3) {
    return { label: "Custom", maxWidth: 1280, captureFps: 24, workers: 3, idealWidth: 1920, note: "Tùy chỉnh 3 worker: 1280 px · 24 fps." };
  }
  return { label: "Custom Fast", maxWidth: 1600, captureFps: 30, workers: 4, idealWidth: 2560, note: "Tùy chỉnh 4 worker: 1600 px · 30 fps." };
}

function currentReceiverSettings(): ReceiverSettings {
  const name = receiverProfileSelect.value;
  return isReceiverProfileName(name) ? RECEIVER_PROFILES[name] : customReceiverSettings();
}

function updateReceiverProfileNote(): void {
  receiverProfileNote.textContent = currentReceiverSettings().note;
}

class DecodeWorkerPool {
  private workers: { worker: Worker; busy: boolean }[] = [];
  private nextId = 0;

  constructor(count: number, private readonly onBytes: (bytes: Uint8Array) => void) {
    for (let index = 0; index < count; index++) {
      const state = {
        worker: new Worker(new URL("./decode-worker.ts", import.meta.url), { type: "module" }),
        busy: false,
      };
      state.worker.onmessage = (event: MessageEvent<{ id: number; bytes: Uint8Array | null }>) => {
        state.busy = false;
        if (event.data.bytes) this.onBytes(Uint8Array.from(event.data.bytes));
      };
      state.worker.onerror = () => {
        state.busy = false;
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

  close(): void {
    for (const state of this.workers) state.worker.terminate();
    this.workers = [];
  }
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
let activeReceiverLabel = "Balanced";

async function acceptFrame(bytes: Uint8Array): Promise<void> {
  try {
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
    const estimate = Math.min(99, (decoder!.framesNew / Math.max(1, decoder!.k * 1.15)) * 100);
    receiveStatus.textContent = [
      `profile=${activeReceiverLabel} · decoded=${framesDecoded} · unique=${decoder!.framesNew} · dropped=${framesDropped}`,
      `solved=${decoder!.solvedCount}/${decoder!.k} · estimate=${estimate.toFixed(1)}% · block=${parsed.header.blockLen} B`,
    ].join("\n");

    const container = decoder!.assemble();
    if (!container) return;

    completing = true;
    if (fnv1a(container) !== expectedFNV) throw new Error("FNV-1a container không khớp.");
    const file = await unpackFile(container);

    if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.type }));
    download.href = activeObjectUrl;
    download.download = file.name;
    download.textContent = `Tải ${file.name}`;
    download.hidden = false;
    receiveStatus.textContent = `Hoàn tất: ${file.name} · ${(file.bytes.length / 1024).toFixed(1)} KiB · FNV-1a và SHA-256 hợp lệ.`;
  } catch (error: unknown) {
    receiveStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    if (completing) {
      completing = false;
      receiverIdentity = null;
      decoder = null;
    }
  }
}

async function startCamera(): Promise<void> {
  const settings = currentReceiverSettings();
  const generation = ++cameraGeneration;
  activeReceiverLabel = settings.label;
  download.hidden = true;
  framesDropped = 0;
  framesDecoded = 0;
  cameraButton.disabled = true;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: settings.idealWidth },
        height: { ideal: Math.round((settings.idealWidth * 9) / 16) },
        frameRate: { ideal: settings.captureFps, max: 30 },
      },
      audio: false,
    });
  } catch (error) {
    cameraButton.disabled = false;
    throw error;
  }

  video.srcObject = stream;
  await video.play();
  document.querySelector(".camera-wrap")?.classList.add("live");
  cameraStopButton.disabled = false;

  pool = new DecodeWorkerPool(settings.workers, (bytes) => {
    void acceptFrame(bytes);
  });

  const capture = document.createElement("canvas");
  const context = capture.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Không tạo được canvas camera.");

  let lastCapture = 0;
  const loop = (now: number): void => {
    if (generation !== cameraGeneration || !stream || !pool) return;
    requestAnimationFrame(loop);
    if (now - lastCapture < 1000 / settings.captureFps || video.videoWidth === 0) return;
    lastCapture = now;

    const scale = Math.min(1, settings.maxWidth / video.videoWidth);
    capture.width = Math.max(1, Math.floor(video.videoWidth * scale));
    capture.height = Math.max(1, Math.floor(video.videoHeight * scale));
    context.drawImage(video, 0, 0, capture.width, capture.height);
    const image = context.getImageData(0, 0, capture.width, capture.height);
    if (!pool.submit(image)) framesDropped++;
  };

  receiveStatus.textContent = `${settings.label}: camera ${settings.maxWidth} px · ${settings.captureFps} fps · ${settings.workers} worker. Đưa toàn bộ QR vào giữa khung hình.`;
  requestAnimationFrame(loop);
}

function stopCamera(message = "Camera đã tắt."): void {
  cameraGeneration++;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  pool?.close();
  pool = null;
  video.srcObject = null;
  cameraButton.disabled = false;
  cameraStopButton.disabled = true;
  receiverIdentity = null;
  decoder = null;
  completing = false;
  document.querySelector(".camera-wrap")?.classList.remove("live");
  receiveStatus.textContent = message;
}

async function restartCameraIfActive(): Promise<void> {
  if (!stream) return;
  stopCamera("Đang áp dụng profile camera…");
  await startCamera();
}

cameraButton.addEventListener("click", () => {
  void startCamera().catch((error: unknown) => {
    stopCamera(`Không mở được camera: ${error instanceof Error ? error.message : String(error)}. Camera cần HTTPS hoặc localhost.`);
  });
});

cameraStopButton.addEventListener("click", () => stopCamera());

receiverProfileSelect.addEventListener("change", () => {
  const name = receiverProfileSelect.value;
  if (isReceiverProfileName(name)) workersSelect.value = String(RECEIVER_PROFILES[name].workers);
  updateReceiverProfileNote();
  void restartCameraIfActive().catch((error: unknown) => {
    stopCamera(error instanceof Error ? error.message : String(error));
  });
});

workersSelect.addEventListener("change", () => {
  receiverProfileSelect.value = "custom";
  updateReceiverProfileNote();
  void restartCameraIfActive().catch((error: unknown) => {
    stopCamera(error instanceof Error ? error.message : String(error));
  });
});

updateReceiverProfileNote();

window.addEventListener("beforeunload", () => {
  stopCamera();
  if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
});
