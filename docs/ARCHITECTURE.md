# Architecture

```text
File / bytes
   │
   ├─ DCF2 pack: filename + MIME + optional gzip + SHA-256
   │
   ├─ split into K fixed source blocks
   │
   ├─ LT fountain encoder ── endless binary frames
   │
   └─ QR L / fixed mask ── screen photons ── camera
                                             │
                              browser WASM workers or Python zxing-cpp
                                             │
                              strict frame parser + stream lock
                                             │
                              LT peeling decoder
                                             │
                              FNV container check
                                             │
                              DCF2 unpack + bounded gunzip + SHA-256
                                             │
                                         verified file
```

## Components

- `pkg/safast`: canonical Go frame, DCF2 and fountain implementation.
- `cmd/safast-pack`: emits base64 NDJSON frames for interoperability tests,
  automation and future QR renderers.
- `cmd/safast-server`: static production server with camera permissions and
  cross-origin isolation headers.
- `python/src/safast`: protocol-compatible decoder and multi-threaded camera CLI.
- `web`: Vite PWA, binary QR sender, camera receiver and ZXing WASM worker pool.

## Performance controls

Goodput is primarily controlled by block size, QR version, displayed frame rate,
monitor refresh rate, shutter/exposure, camera focus, optical distance and the
number of decode workers. The reference architecture has demonstrated roughly
128–130 KB/s in favorable phone-to-phone experiments; this repository does not
claim that number for every device and includes no fabricated benchmark.
