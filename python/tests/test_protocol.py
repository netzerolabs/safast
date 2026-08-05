from safast.fountain import LTDecoder, LTEncoder
from safast.protocol import FrameHeader, pack_frame, parse_frame


def test_frame_golden_vector() -> None:
    header = FrameHeader(0x1234, 0x89ABCDEF, 3, 4, 11, 0x78563412)
    frame = pack_frame(header, b"\x01\x02\x03\x04")
    assert frame.hex() == "d10c3412efcdab89030004000b0000001234567801020304"
    assert parse_frame(frame) == (header, b"\x01\x02\x03\x04")


def test_fountain_round_trip_with_drops() -> None:
    payload = b"0123456789abcdef" * 137
    encoder = LTEncoder(payload, 128, 0x4242)
    decoder = LTDecoder(encoder.k, encoder.block_len, encoder.session_id, len(payload))
    for sequence in range(10000):
        if sequence % 7 == 0:
            continue
        decoder.add_frame(sequence, encoder.encode(sequence))
        if decoder.complete:
            break
    assert decoder.assemble() == payload
