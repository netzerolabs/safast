package safast

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func TestFrameGoldenVector(t *testing.T) {
	h := FrameHeader{SessionID: 0x1234, Sequence: 0x89abcdef, BlockCount: 3, BlockLen: 4, TotalLen: 11, PayloadFNV: 0x78563412}
	frame, err := PackFrame(h, []byte{1, 2, 3, 4})
	if err != nil {
		t.Fatal(err)
	}
	const want = "d10c3412efcdab89030004000b0000001234567801020304"
	if got := hex.EncodeToString(frame); got != want {
		t.Fatalf("golden frame mismatch\n got %s\nwant %s", got, want)
	}
	parsed, block, err := ParseFrame(frame)
	if err != nil || parsed != h || !bytes.Equal(block, []byte{1, 2, 3, 4}) {
		t.Fatalf("round trip failed: %#v %x %v", parsed, block, err)
	}
}

func TestContainerRoundTrip(t *testing.T) {
	payload := bytes.Repeat([]byte("SAFAST optical transfer\n"), 1000)
	packed, err := PackFile("../report.txt", "text/plain", payload)
	if err != nil {
		t.Fatal(err)
	}
	if packed.Compression != "gzip" {
		t.Fatalf("expected gzip, got %s", packed.Compression)
	}
	file, err := UnpackFile(packed.Container)
	if err != nil {
		t.Fatal(err)
	}
	if file.Name != "report.txt" || !bytes.Equal(file.Bytes, payload) {
		t.Fatalf("container round trip mismatch: %q %d", file.Name, len(file.Bytes))
	}
}

func TestFountainRoundTrip(t *testing.T) {
	payload := bytes.Repeat([]byte("0123456789abcdef"), 137)
	enc, err := NewLTEncoder(payload, 128, 0x4242)
	if err != nil {
		t.Fatal(err)
	}
	dec, err := NewLTDecoder(enc.K, enc.BlockLen, enc.SessionID, len(payload))
	if err != nil {
		t.Fatal(err)
	}
	for seq := uint32(0); seq < 10000 && !dec.Complete(); seq++ {
		if seq%7 == 0 {
			continue
		}
		if err := dec.AddFrame(seq, enc.Encode(seq)); err != nil {
			t.Fatal(err)
		}
	}
	got, ok := dec.Assemble()
	if !ok || !bytes.Equal(got, payload) {
		t.Fatalf("fountain decode incomplete: solved=%d/%d frames=%d", dec.Solved, dec.K, dec.FramesNew)
	}
}
