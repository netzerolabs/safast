<div align="center">

# ⚡ SAFAST Optical Transfer

**Truyền file cách ly mạng bằng QR động fountain-coded**  
**Air-gapped file transfer through fountain-coded animated QR frames**

[![License: MIT](https://img.shields.io/badge/License-MIT-16c784.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.23+-00ADD8?logo=go&logoColor=white)](go.mod)
[![Python](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white)](python/pyproject.toml)
[![Web](https://img.shields.io/badge/Web-TypeScript%20%2B%20WASM-3178C6?logo=typescript&logoColor=white)](web/)

`SCREEN → LIGHT → CAMERA` · no shared network · no Bluetooth pairing · no cloud upload

</div>

---

## 🇻🇳 Tiếng Việt

SAFAST biến một file thành chuỗi mã QR nhấp nháy. Máy nhận chỉ cần camera:
thu các frame đọc được theo thứ tự bất kỳ, giải mã LT fountain, ghép lại
container và xác minh SHA-256 trước khi cho tải file.

### Điều SAFAST bảo đảm

- Không cần hai thiết bị cùng Wi‑Fi, Bluetooth hay kết nối trực tiếp.
- Mỗi QR frame tự mô tả bằng header nhị phân 20 byte.
- Mất frame không làm hỏng file; receiver chỉ cần đủ fountain frame độc lập.
- Container giữ tên file, MIME, gzip tùy chọn và SHA‑256 của dữ liệu gốc.
- Browser receiver giải QR bằng nhiều Web Worker chạy ZXing WebAssembly.
- Python CLI có thể dùng OpenCV + `zxing-cpp` để nhận từ camera.
- Go giữ bản triển khai chuẩn cho giao thức, đóng gói, fountain code và server.

> [!WARNING]
> **Không có nghĩa là bí mật.** SAFAST loại bỏ đường truyền mạng, nhưng QR đang
> hiển thị có thể bị bất kỳ camera nào trong tầm nhìn ghi lại. Phiên bản này
> chưa mã hóa đầu-cuối.

### Trạng thái triển khai

| Lớp | Trạng thái | Nội dung |
|---|---|---|
| Go core | ✅ | frame v1, DCF2, gzip có giới hạn, SHA‑256, LT encoder/decoder |
| Go CLI | ✅ | xuất fountain frame dạng NDJSON base64 |
| Go server | ✅ | phục vụ PWA với CSP, COOP/COEP và camera permission policy |
| Python core | ✅ | parser, LT encoder/decoder, DCF2 verifier |
| Python camera | ✅ | multi-worker OpenCV + zxing-cpp receiver |
| Web sender | ✅ | binary QR, ECC L, mask cố định, frame rate tùy chỉnh |
| Web receiver | ✅ | camera, worker pool WASM, FNV + SHA‑256, tải file |
| PWA/offline | ✅ | Vite PWA cache HTML/JS/CSS/WASM sau lần mở đầu |
| Benchmark matrix | 🧪 | cần đo theo từng màn hình, camera và khoảng cách |

### Chạy nhanh

Yêu cầu: Go 1.23+, Node.js 20+, Python 3.10+.

```bash
git clone https://github.com/netzerolabs/safast.git
cd safast

# Kiểm thử Go + Python
make test

# Cài web dependencies, build và chạy server Go
make web-install
make run
# Mở http://localhost:8080
```

Camera trên thiết bị khác thường yêu cầu HTTPS. Khi phát triển trên LAN, dùng
reverse proxy HTTPS hoặc chứng chỉ cục bộ; `localhost` được trình duyệt xem là
secure context.

### Python camera receiver

```bash
cd python
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e '.[camera]'

safast-camera scan --camera 0 --workers 3 --output received
```

### Kiểm thử tương thích Go → Python không cần camera

```bash
go run ./cmd/safast-pack -block-bytes 1100 sample.bin > frames.ndjson
PYTHONPATH=python/src python -m safast.cli decode-ndjson frames.ndjson --output received
cmp sample.bin received/sample.bin
```

### Điều chỉnh hiệu năng

Bắt đầu với `1100 B/frame`, `18 fps`, QR ECC `L`, 3 worker. Sau đó:

1. tăng payload lên 1450 B nếu QR vẫn bắt ổn;
2. tăng 24 fps nếu màn hình và camera không bắt trúng thời điểm chuyển frame;
3. giữ QR chiếm phần lớn màn hình, độ sáng cao, camera vuông góc;
4. khóa focus/exposure khi thiết bị cho phép;
5. giảm payload trước khi tăng ECC — fountain code đã xử lý frame bị mất.

Mức khoảng 128–130 KB/s là kết quả tham khảo của kiến trúc gốc trong điều kiện
thuận lợi, **không phải cam kết cho mọi thiết bị**. Goodput thực tế phụ thuộc QR
version, refresh rate, rolling shutter, ánh sáng, khoảng cách và năng lực WASM.

---

## 🇬🇧 English

SAFAST turns a file into an endless animated QR stream. A receiver camera can
collect distinct frames in any order, peel the LT fountain code, reconstruct
the file container, and verify the original bytes with SHA‑256.

### Security model

SAFAST removes the network transport path; it does not automatically provide
confidentiality. A camera with line of sight can capture the stream. The
receiver validates strict frame dimensions, stream identity, container FNV-1a,
bounded decompression, and SHA‑256 before exposing the file.

### Repository layout

```text
cmd/safast-pack/      Go NDJSON frame generator
cmd/safast-server/    hardened static PWA server
pkg/safast/           canonical Go wire/container/fountain implementation
python/src/safast/    Python decoder and camera CLI
web/                  TypeScript PWA + ZXing WASM worker pool
docs/                 architecture and wire protocol
```

### Protocol summary

```text
original bytes
  └─ DCF2 container: safe filename + MIME + optional gzip + SHA-256
      └─ K source blocks
          └─ LT frame = XOR(random deterministic subset)
              └─ 20-byte frame header + block
                  └─ binary QR, error correction L, pinned mask
```

The receiver accepts any sufficient set of unique frames. Dropped camera frames
increase transfer time but do not change the reconstructed bytes.

See [Protocol](docs/PROTOCOL.md), [Architecture](docs/ARCHITECTURE.md),
[Security](SECURITY.md), and [Contributing](CONTRIBUTING.md).

## Attribution and license

SAFAST is MIT-licensed. Its compatible TypeScript optical core is derived from
[Decimen Optical Transfer](https://github.com/bashalarmistalt/decimen-optical-transfer),
also MIT-licensed. Original copyright and permission text are preserved in
[NOTICE](NOTICE), and derived files carry attribution headers.
