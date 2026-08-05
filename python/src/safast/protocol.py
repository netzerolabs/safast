from __future__ import annotations

from dataclasses import dataclass
import struct

HEADER_LEN = 20
_MAGIC = b"\xd1\x0c"
_HEADER = struct.Struct("<2sH I H H I I")


@dataclass(frozen=True, slots=True)
class FrameHeader:
    session_id: int
    sequence: int
    block_count: int
    block_len: int
    total_len: int
    payload_fnv: int

    @property
    def identity(self) -> str:
        return (
            f"{self.session_id}:{self.block_count}:{self.block_len}:"
            f"{self.total_len}:{self.payload_fnv}"
        )


def pack_frame(header: FrameHeader, block: bytes) -> bytes:
    if not (0 < header.session_id <= 0xFFFF):
        raise ValueError("session_id must fit uint16 and be non-zero")
    if not (0 < header.block_count <= 0xFFFF):
        raise ValueError("block_count must fit uint16")
    if not (0 < header.block_len <= 0xFFFF):
        raise ValueError("block_len must fit uint16")
    if header.total_len <= 0:
        raise ValueError("total_len must be positive")
    if len(block) != header.block_len:
        raise ValueError("block length does not match header")
    return _HEADER.pack(
        _MAGIC,
        header.session_id,
        header.sequence & 0xFFFFFFFF,
        header.block_count,
        header.block_len,
        header.total_len & 0xFFFFFFFF,
        header.payload_fnv & 0xFFFFFFFF,
    ) + block


def parse_frame(frame: bytes | bytearray | memoryview) -> tuple[FrameHeader, bytes]:
    raw = bytes(frame)
    if len(raw) <= HEADER_LEN:
        raise ValueError("frame is too short")
    magic, session_id, sequence, block_count, block_len, total_len, payload_fnv = _HEADER.unpack_from(raw)
    if magic != _MAGIC or block_count == 0 or block_len == 0 or total_len == 0:
        raise ValueError("invalid SAFAST frame")
    if len(raw) != HEADER_LEN + block_len:
        raise ValueError("frame length does not match header")
    return (
        FrameHeader(session_id, sequence, block_count, block_len, total_len, payload_fnv),
        raw[HEADER_LEN:],
    )


def fnv1a(data: bytes | bytearray | memoryview) -> int:
    value = 0x811C9DC5
    for byte in data:
        value ^= int(byte)
        value = (value * 0x01000193) & 0xFFFFFFFF
    return value
