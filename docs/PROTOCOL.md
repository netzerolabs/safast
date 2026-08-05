# SAFAST wire protocol v1

## QR frame

All integer fields are little-endian. Each QR contains exactly one binary frame.

| Offset | Type | Field |
|---:|---|---|
| 0 | `u8[2]` | magic `D1 0C` |
| 2 | `u16` | random non-zero session ID |
| 4 | `u32` | fountain sequence number |
| 8 | `u16` | source block count `K` |
| 10 | `u16` | fountain block length |
| 12 | `u32` | complete DCF2 container length |
| 16 | `u32` | FNV-1a of complete DCF2 container |
| 20 | bytes | LT-coded block |

The stream identity is every invariant header field:
`sessionId:K:blockLen:totalLen:payloadFnv`.

## LT fountain layer

Sequence number and session ID seed a 32-bit deterministic generator. The
frame degree comes from a robust-soliton CDF. The frame payload is the XOR of
the selected source blocks. The decoder accepts unique frames in any order and
uses peeling elimination. Camera loss is treated as erasure rather than a
request for retransmission.

The logarithm used while constructing the CDF is deliberately implemented from
specified floating-point operations. Replacing it with a platform `log()` can
silently change a CDF boundary and break cross-runtime compatibility.

## DCF2 file container

| Offset | Type | Field |
|---:|---|---|
| 0 | `u8[4]` | ASCII `DCF2` |
| 4 | `u8` | compression: `0` none, `1` gzip |
| 5 | `u16` | filename UTF-8 length |
| 7 | `u16` | MIME UTF-8 length |
| 9 | `u32` | original file length |
| 13 | `u32` | transmitted payload length |
| 17 | `u8[32]` | SHA-256 of original bytes |
| 49 | bytes | filename, MIME, payload |

Filename input is reduced to a safe basename on both sides. Gzip is used only
when it saves at least 64 bytes. Receiver decompression is bounded.

## QR parameters

The browser sender pins error correction to level L and a fixed mask. The
fountain layer handles missing frames; QR ECC handles corruption inside an
individual frame. A frame that does not decode is discarded.
