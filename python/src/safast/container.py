from __future__ import annotations

from dataclasses import dataclass
import gzip
import hashlib
import os
import struct

MAX_FILE_BYTES = 64 * 1024 * 1024
_FILE_MAGIC = b"DCF2"
_FILE_HEADER_LEN = 49


@dataclass(frozen=True, slots=True)
class OpticalFile:
    name: str
    media_type: str
    data: bytes
    sha256: bytes
    compression: str
    transmitted_size: int


def _safe_name(name: str) -> str:
    base = os.path.basename(name.replace("\\", "/"))
    cleaned = "".join(char for char in base if ord(char) >= 32 and ord(char) != 127).strip()
    return "transfer.bin" if cleaned in {"", ".", ".."} else cleaned


def unpack_file(container: bytes) -> OpticalFile:
    if len(container) < _FILE_HEADER_LEN or container[:4] != _FILE_MAGIC:
        raise ValueError("invalid DCF2 container")
    compression = container[4]
    if compression not in (0, 1):
        raise ValueError("unsupported compression")
    name_len, type_len, file_len, transmitted_len = struct.unpack_from("<HHII", container, 5)
    data_offset = _FILE_HEADER_LEN + name_len + type_len
    if (
        file_len <= 0
        or file_len > MAX_FILE_BYTES
        or transmitted_len <= 0
        or transmitted_len > MAX_FILE_BYTES
        or data_offset + transmitted_len != len(container)
    ):
        raise ValueError("container lengths are inconsistent")
    name = _safe_name(container[_FILE_HEADER_LEN : _FILE_HEADER_LEN + name_len].decode("utf-8"))
    media_type = container[_FILE_HEADER_LEN + name_len : data_offset].decode("utf-8") or "application/octet-stream"
    transmitted = container[data_offset:]
    data = gzip.decompress(transmitted) if compression == 1 else transmitted
    if len(data) != file_len:
        raise ValueError("recovered length does not match container")
    expected = container[17:49]
    if hashlib.sha256(data).digest() != expected:
        raise ValueError("SHA-256 verification failed")
    return OpticalFile(name, media_type, data, expected, "gzip" if compression else "none", transmitted_len)
