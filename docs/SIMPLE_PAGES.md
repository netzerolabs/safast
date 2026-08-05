# SAFAST simple sender and receiver pages

SAFAST keeps the full single-page application at the site root and also builds
two focused URLs for users who only need one side of the optical link:

- `/generator/` — sender only;
- `/scanner/` — camera receiver only.

On GitHub Pages these resolve to:

- `https://netzerolabs.github.io/safast/generator/`
- `https://netzerolabs.github.io/safast/scanner/`

## One side, one readable HTML

The page-specific UI, state management, camera loop and sender/receiver
orchestration are written directly in:

- `web/generator/index.html`
- `web/scanner/index.html`

The pages intentionally import the shared, tested primitives from
`web/src/core/` instead of copying or inventing another wire protocol. This
keeps the pages readable while preserving compatibility with the Go, Python and
main TypeScript implementations.

No runtime CDN is used. Vite bundles the npm dependencies and ZXing worker into
the deployed application, and the PWA service worker caches the generated
HTML/JS/CSS/WASM assets.

## Sender profiles

| Profile | Fountain block | Display rate | Intended use |
|---|---:|---:|---|
| Lite | 250 B | 10 fps | older cameras, weak CPUs, longer distance, small files |
| Reliable | 700 B | 12 fps | difficult lighting or moderate camera quality |
| Balanced | 1100 B | 18 fps | default modern phone/laptop setup |
| Fast | 1450 B | 24 fps | bright display, good camera and stable alignment |

Lite remains an LT fountain stream. It is not the older fragile design where
each numbered chunk is shown only once. A missed QR therefore increases the
transfer time instead of permanently losing one required chunk.

Because the frame header stores `K` as an unsigned 16-bit integer, very small
blocks cannot represent arbitrarily large uncompressed containers. The Lite UI
is recommended for files below roughly 8 MB and reports a clear error when a
selected profile would exceed the protocol block-count limit.

## Scanner profiles

| Profile | Capture width | Capture rate | Workers |
|---|---:|---:|---:|
| Lite | 720 px | 12 fps | 1 |
| Balanced | 1280 px | 24 fps | 3 |
| Fast | 1600 px | 30 fps | 4 |

The scanner accepts frames from every sender profile. Its profile controls only
camera capture and decode load; it does not change the SAFAST wire format.

## Build output

`web/vite.config.ts` declares three HTML inputs:

```text
index.html
 generator/index.html
 scanner/index.html
```

Run:

```bash
cd web
npm install
npm run build
```

The corresponding static routes are emitted under `web/dist/` and are included
in the same GitHub Pages artifact as the main application.
