// Derived from decimen-optical-transfer/shared/fountain.ts (MIT).
// Copyright (c) 2026 Evan Crawley. See repository NOTICE.
import { splitmix32 } from "./protocol";

const LN2 = 0.6931471805599453;
function dlog(x: number): number {
  let e = 0, m = x;
  while (m >= 1.5) { m /= 2; e++; }
  while (m < 0.75) { m *= 2; e--; }
  const z = (m - 1) / (m + 1), z2 = z * z;
  let term = z, sum = 0;
  for (let n = 1; n <= 21; n += 2) { sum += term / n; term *= z2; }
  return e * LN2 + 2 * sum;
}
function solitonCdf(k: number): Float64Array {
  const cdf = new Float64Array(k);
  if (k === 1) { cdf[0] = 1; return cdf; }
  const R = Math.max(1, 0.1 * dlog(k / 0.5) * Math.sqrt(k));
  const spike = Math.min(k, Math.ceil(k / R));
  let total = 0;
  for (let d = 1; d <= k; d++) {
    const rho = d === 1 ? 1 / k : 1 / (d * (d - 1));
    const tau = d < spike ? R / (d * k) : d === spike ? (R * Math.max(0, dlog(R / 0.5))) / k : 0;
    total += rho + tau; cdf[d - 1] = total;
  }
  for (let i = 0; i < k; i++) cdf[i] = cdf[i]! / total;
  cdf[k - 1] = 1; return cdf;
}
function frameSeed(sessionId: number, seq: number): number {
  let h = (Math.imul(sessionId + 1, 0x9e3779b1) ^ (seq + 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); return (h ^ (h >>> 16)) | 0;
}
function frameIndices(k: number, cdf: Float64Array, sessionId: number, seq: number): number[] {
  const rnd = splitmix32(frameSeed(sessionId, seq));
  const u = rnd() * 2 ** -32;
  let lo = 0, hi = k - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid]! >= u) hi = mid; else lo = mid + 1; }
  const degree = Math.min(k, lo + 1);
  if (degree > k >> 3) {
    const scratch = new Uint32Array(k); for (let i = 0; i < k; i++) scratch[i] = i;
    const out: number[] = [];
    for (let i = 0; i < degree; i++) { const j = i + (rnd() % (k - i)); [scratch[i], scratch[j]] = [scratch[j]!, scratch[i]!]; out.push(scratch[i]!); }
    return out;
  }
  const set = new Set<number>(); while (set.size < degree) set.add(rnd() % k); return [...set];
}
function xorInto(dst: Uint8Array, src: Uint8Array): void { for (let i = 0; i < dst.length; i++) dst[i] = dst[i]! ^ src[i]!; }

export class LTEncoder {
  readonly k: number; private readonly blocks: Uint8Array[]; private readonly cdf: Float64Array;
  constructor(payload: Uint8Array, readonly blockLen: number, readonly sessionId: number) {
    this.k = Math.max(1, Math.ceil(payload.length / blockLen));
    this.blocks = Array.from({ length: this.k }, (_, index) => {
      const block = new Uint8Array(blockLen); block.set(payload.subarray(index * blockLen, (index + 1) * blockLen)); return block;
    });
    this.cdf = solitonCdf(this.k);
  }
  encode(seq: number): Uint8Array {
    const out = new Uint8Array(this.blockLen);
    for (const index of frameIndices(this.k, this.cdf, this.sessionId, seq)) xorInto(out, this.blocks[index]!);
    return out;
  }
}
interface Pending { indices: Set<number>; bytes: Uint8Array; }
export class LTDecoder {
  private readonly cdf: Float64Array; private readonly solved: (Uint8Array | null)[]; private readonly byBlock = new Map<number, Set<Pending>>(); private readonly seen = new Set<number>();
  solvedCount = 0; framesNew = 0; framesDup = 0;
  constructor(readonly k: number, readonly blockLen: number, readonly sessionId: number, readonly totalLen: number) { this.cdf = solitonCdf(k); this.solved = new Array(k).fill(null); }
  get isComplete(): boolean { return this.solvedCount >= this.k; }
  addFrame(seq: number, block: Uint8Array): void {
    if (this.seen.has(seq)) { this.framesDup++; return; }
    this.seen.add(seq); this.framesNew++;
    if (this.isComplete) return;
    const indices = new Set(frameIndices(this.k, this.cdf, this.sessionId, seq));
    const bytes = Uint8Array.from(block);
    for (const index of [...indices]) { const solved = this.solved[index]; if (solved) { xorInto(bytes, solved); indices.delete(index); } }
    if (indices.size === 0) return;
    if (indices.size === 1) { this.resolve(indices.values().next().value!, bytes); return; }
    const pending = { indices, bytes };
    for (const index of indices) { const waiting = this.byBlock.get(index) ?? new Set<Pending>(); waiting.add(pending); this.byBlock.set(index, waiting); }
  }
  private resolve(first: number, firstBytes: Uint8Array): void {
    const queue: [number, Uint8Array][] = [[first, firstBytes]];
    while (queue.length) {
      const [index, bytes] = queue.pop()!; if (this.solved[index]) continue;
      this.solved[index] = Uint8Array.from(bytes); this.solvedCount++;
      const waiting = this.byBlock.get(index); this.byBlock.delete(index);
      for (const pending of waiting ?? []) { xorInto(pending.bytes, bytes); pending.indices.delete(index); if (pending.indices.size === 1) { const next = pending.indices.values().next().value!; this.byBlock.get(next)?.delete(pending); if (!this.solved[next]) queue.push([next, pending.bytes]); } }
    }
  }
  assemble(): Uint8Array | null {
    if (!this.isComplete) return null;
    const out = new Uint8Array(this.totalLen);
    for (let index = 0; index < this.k; index++) { const start = index * this.blockLen; out.set(this.solved[index]!.subarray(0, Math.min(this.blockLen, this.totalLen - start)), start); }
    return out;
  }
}
