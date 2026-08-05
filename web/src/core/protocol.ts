// Derived from decimen-optical-transfer/shared/protocol.ts (MIT).
// Copyright (c) 2026 Evan Crawley. See repository NOTICE.

export const HEADER_LEN = 20;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
const FILE_HEADER_LEN = 49;
const FILE_MAGIC = new Uint8Array([0x44, 0x43, 0x46, 0x32]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface FrameHeader {
  sessionId: number;
  seq: number;
  k: number;
  blockLen: number;
  totalLen: number;
  payloadFnv: number;
}

export interface PackedOpticalFile {
  container: Uint8Array;
  compression: "none" | "gzip";
  originalSize: number;
  transmittedSize: number;
}

export interface OpticalFile {
  name: string;
  type: string;
  bytes: Uint8Array;
  sha256: Uint8Array;
  compression: "none" | "gzip";
}

function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "transfer.bin" : cleaned;
}

async function digest(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBytes(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Payload giải nén vượt quá kích thước khai báo.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function isPrecompressed(type: string): boolean {
  const media = type.split(";")[0]!.trim().toLowerCase();
  return media.startsWith("video/") ||
    (/^image\/(jpeg|png|gif|webp|avif|heic|heif)$/.test(media)) ||
    (/^audio\/(mpeg|mp4|aac|ogg|opus|flac)$/.test(media)) ||
    /(zip|gzip|7z|rar|zstd)$/.test(media);
}

export async function packFile(name: string, type: string, bytes: Uint8Array): Promise<PackedOpticalFile> {
  if (bytes.length === 0) throw new Error("File rỗng.");
  if (bytes.length > MAX_FILE_BYTES) throw new Error("File vượt giới hạn 64 MB.");
  const nameBytes = encoder.encode(safeFileName(name));
  const typeBytes = encoder.encode(type || "application/octet-stream");
  if (nameBytes.length > 0xffff || typeBytes.length > 0xffff) throw new Error("Tên file hoặc MIME quá dài.");
  const [sha256, compressed] = await Promise.all([
    digest(bytes),
    bytes.length >= 768 && !isPrecompressed(type) ? gzipBytes(bytes) : Promise.resolve(undefined),
  ]);
  const useGzip = compressed !== undefined && compressed.length + 64 < bytes.length;
  const transmitted = useGzip ? compressed : bytes;
  const out = new Uint8Array(FILE_HEADER_LEN + nameBytes.length + typeBytes.length + transmitted.length);
  const view = new DataView(out.buffer);
  out.set(FILE_MAGIC, 0);
  view.setUint8(4, useGzip ? 1 : 0);
  view.setUint16(5, nameBytes.length, true);
  view.setUint16(7, typeBytes.length, true);
  view.setUint32(9, bytes.length, true);
  view.setUint32(13, transmitted.length, true);
  out.set(sha256, 17);
  out.set(nameBytes, FILE_HEADER_LEN);
  out.set(typeBytes, FILE_HEADER_LEN + nameBytes.length);
  out.set(transmitted, FILE_HEADER_LEN + nameBytes.length + typeBytes.length);
  return { container: out, compression: useGzip ? "gzip" : "none", originalSize: bytes.length, transmittedSize: transmitted.length };
}

export async function unpackFile(container: Uint8Array): Promise<OpticalFile> {
  if (container.length < FILE_HEADER_LEN || !FILE_MAGIC.every((value, index) => container[index] === value)) throw new Error("Container DCF2 không hợp lệ.");
  const view = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const compressionByte = view.getUint8(4);
  if (compressionByte > 1) throw new Error("Kiểu nén không được hỗ trợ.");
  const nameLength = view.getUint16(5, true);
  const typeLength = view.getUint16(7, true);
  const fileLength = view.getUint32(9, true);
  const transmittedLength = view.getUint32(13, true);
  const dataOffset = FILE_HEADER_LEN + nameLength + typeLength;
  if (!fileLength || fileLength > MAX_FILE_BYTES || !transmittedLength || dataOffset + transmittedLength !== container.length) throw new Error("Độ dài container không khớp.");
  const transmitted = container.slice(dataOffset);
  const bytes = compressionByte === 1 ? await gunzipBytes(transmitted, fileLength) : transmitted;
  if (bytes.length !== fileLength) throw new Error("Độ dài file khôi phục không khớp.");
  const sha256 = container.slice(17, 49);
  const actual = await digest(bytes);
  if (!actual.every((value, index) => value === sha256[index])) throw new Error("SHA-256 không khớp.");
  return {
    name: safeFileName(decoder.decode(container.subarray(FILE_HEADER_LEN, FILE_HEADER_LEN + nameLength))),
    type: decoder.decode(container.subarray(FILE_HEADER_LEN + nameLength, dataOffset)) || "application/octet-stream",
    bytes,
    sha256,
    compression: compressionByte === 1 ? "gzip" : "none",
  };
}

export function packFrame(h: FrameHeader, block: Uint8Array): Uint8Array {
  if (block.length !== h.blockLen) throw new Error("Block length mismatch");
  const out = new Uint8Array(HEADER_LEN + block.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, 0xd1); view.setUint8(1, 0x0c);
  view.setUint16(2, h.sessionId, true); view.setUint32(4, h.seq, true);
  view.setUint16(8, h.k, true); view.setUint16(10, h.blockLen, true);
  view.setUint32(12, h.totalLen, true); view.setUint32(16, h.payloadFnv, true);
  out.set(block, HEADER_LEN);
  return out;
}

export function parseFrame(bytes: Uint8Array): { header: FrameHeader; block: Uint8Array } | null {
  if (bytes.length <= HEADER_LEN || bytes[0] !== 0xd1 || bytes[1] !== 0x0c) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = {
    sessionId: view.getUint16(2, true), seq: view.getUint32(4, true), k: view.getUint16(8, true),
    blockLen: view.getUint16(10, true), totalLen: view.getUint32(12, true), payloadFnv: view.getUint32(16, true),
  };
  if (!header.k || !header.blockLen || !header.totalLen || bytes.length !== HEADER_LEN + header.blockLen) return null;
  return { header, block: bytes.subarray(HEADER_LEN) };
}

export function streamIdentity(h: FrameHeader): string {
  return `${h.sessionId}:${h.k}:${h.blockLen}:${h.totalLen}:${h.payloadFnv}`;
}

export function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 0x01000193); }
  return hash >>> 0;
}

export function splitmix32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x9e3779b9) | 0;
    let value = state ^ (state >>> 16);
    value = Math.imul(value, 0x21f0aaad); value ^= value >>> 15;
    value = Math.imul(value, 0x735a2d97); value ^= value >>> 15;
    return value >>> 0;
  };
}
