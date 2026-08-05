from __future__ import annotations

import argparse
from concurrent.futures import Future, ThreadPoolExecutor
import base64
import json
from pathlib import Path
import sys
import time
from typing import Any

from .container import unpack_file
from .fountain import LTDecoder
from .protocol import fnv1a, parse_frame


class Receiver:
    def __init__(self, output_dir: Path) -> None:
        self.output_dir = output_dir
        self.identity: str | None = None
        self.decoder: LTDecoder | None = None
        self.expected_fnv = 0

    def accept(self, frame: bytes) -> Path | None:
        header, block = parse_frame(frame)
        if header.identity != self.identity:
            self.identity = header.identity
            self.expected_fnv = header.payload_fnv
            self.decoder = LTDecoder(header.block_count, header.block_len, header.session_id, header.total_len)
            print(
                f"locked stream {header.identity} (K={header.block_count}, block={header.block_len})",
                file=sys.stderr,
            )
        assert self.decoder is not None
        self.decoder.add_frame(header.sequence, block)
        percent = min(99.0, self.decoder.frames_new / max(1, self.decoder.k * 1.15) * 100)
        print(
            f"\rframes={self.decoder.frames_new} solved={self.decoder.solved_count}/{self.decoder.k} ~{percent:5.1f}%",
            end="",
            file=sys.stderr,
            flush=True,
        )
        container = self.decoder.assemble()
        if container is None:
            return None
        if fnv1a(container) != self.expected_fnv:
            raise ValueError("container FNV-1a mismatch")
        optical_file = unpack_file(container)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        destination = self.output_dir / optical_file.name
        destination.write_bytes(optical_file.data)
        print(f"\nverified SHA-256 and wrote {destination}", file=sys.stderr)
        self.identity = None
        self.decoder = None
        return destination


def decode_ndjson(path: Path, output_dir: Path) -> int:
    receiver = Receiver(output_dir)
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            encoded = record.get("frame_base64")
            if not encoded:
                continue
            destination = receiver.accept(base64.b64decode(encoded))
            if destination:
                print(destination)
                return 0
    print("stream ended before the fountain decoder completed", file=sys.stderr)
    return 2


def _decode_image(image: Any) -> bytes | None:
    import zxingcpp

    results = zxingcpp.read_barcodes(image)
    for result in results:
        raw = getattr(result, "bytes", None)
        if raw:
            return bytes(raw)
    return None


def scan_camera(camera: int, output_dir: Path, workers: int) -> int:
    try:
        import cv2
    except ImportError as exc:
        raise SystemExit("install camera extras: pip install 'safast-optical[camera]'") from exc

    capture = cv2.VideoCapture(camera)
    if not capture.isOpened():
        raise SystemExit(f"cannot open camera {camera}")
    receiver = Receiver(output_dir)
    executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="safast-zxing")
    futures: set[Future[bytes | None]] = set()
    last_submit = 0.0
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                continue
            now = time.monotonic()
            if len(futures) < workers and now - last_submit >= 1 / 30:
                futures.add(executor.submit(_decode_image, frame.copy()))
                last_submit = now
            completed = {future for future in futures if future.done()}
            futures -= completed
            for future in completed:
                payload = future.result()
                if payload:
                    destination = receiver.accept(payload)
                    if destination:
                        return 0
            cv2.imshow("SAFAST receiver — press q to quit", frame)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                return 130
    finally:
        capture.release()
        cv2.destroyAllWindows()
        executor.shutdown(wait=False, cancel_futures=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="safast-camera", description="Receive SAFAST animated QR streams")
    sub = parser.add_subparsers(dest="command", required=True)
    camera = sub.add_parser("scan", help="scan animated QR frames from a camera")
    camera.add_argument("--camera", type=int, default=0)
    camera.add_argument("--workers", type=int, default=3)
    camera.add_argument("--output", type=Path, default=Path("received"))
    ndjson = sub.add_parser("decode-ndjson", help="decode frames produced by safast-pack")
    ndjson.add_argument("path", type=Path)
    ndjson.add_argument("--output", type=Path, default=Path("received"))
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.command == "scan":
        raise SystemExit(scan_camera(args.camera, args.output, max(1, args.workers)))
    raise SystemExit(decode_ndjson(args.path, args.output))


if __name__ == "__main__":
    main()
