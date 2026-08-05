import { readBarcodes } from "zxing-wasm/reader";

self.onmessage = async (event: MessageEvent<{ id: number; image: ImageData }>) => {
  const { id, image } = event.data;
  try {
    const results = await readBarcodes(image, { formats: ["QRCode"], maxNumberOfSymbols: 1 });
    const result = results.find((item) => item.isValid && item.bytes.length > 0);
    const bytes = result ? Uint8Array.from(result.bytes) : null;
    self.postMessage({ id, bytes }, bytes ? [bytes.buffer] : []);
  } catch {
    self.postMessage({ id, bytes: null });
  }
};
