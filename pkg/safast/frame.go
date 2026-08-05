package safast

import (
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	HeaderLen = 20
	magic0    = 0xd1
	magic1    = 0x0c
)

var (
	ErrInvalidFrame = errors.New("invalid SAFAST optical frame")
	ErrWrongLength  = errors.New("frame length does not match header")
)

type FrameHeader struct {
	SessionID  uint16
	Sequence   uint32
	BlockCount uint16
	BlockLen   uint16
	TotalLen   uint32
	PayloadFNV uint32
}

func PackFrame(h FrameHeader, block []byte) ([]byte, error) {
	if h.BlockCount == 0 || h.BlockLen == 0 || h.TotalLen == 0 {
		return nil, fmt.Errorf("%w: zero-valued dimensions", ErrInvalidFrame)
	}
	if len(block) != int(h.BlockLen) {
		return nil, fmt.Errorf("%w: got %d payload bytes, want %d", ErrWrongLength, len(block), h.BlockLen)
	}
	out := make([]byte, HeaderLen+len(block))
	out[0], out[1] = magic0, magic1
	binary.LittleEndian.PutUint16(out[2:4], h.SessionID)
	binary.LittleEndian.PutUint32(out[4:8], h.Sequence)
	binary.LittleEndian.PutUint16(out[8:10], h.BlockCount)
	binary.LittleEndian.PutUint16(out[10:12], h.BlockLen)
	binary.LittleEndian.PutUint32(out[12:16], h.TotalLen)
	binary.LittleEndian.PutUint32(out[16:20], h.PayloadFNV)
	copy(out[HeaderLen:], block)
	return out, nil
}

func ParseFrame(frame []byte) (FrameHeader, []byte, error) {
	if len(frame) <= HeaderLen || frame[0] != magic0 || frame[1] != magic1 {
		return FrameHeader{}, nil, ErrInvalidFrame
	}
	h := FrameHeader{
		SessionID:  binary.LittleEndian.Uint16(frame[2:4]),
		Sequence:   binary.LittleEndian.Uint32(frame[4:8]),
		BlockCount: binary.LittleEndian.Uint16(frame[8:10]),
		BlockLen:   binary.LittleEndian.Uint16(frame[10:12]),
		TotalLen:   binary.LittleEndian.Uint32(frame[12:16]),
		PayloadFNV: binary.LittleEndian.Uint32(frame[16:20]),
	}
	if h.BlockCount == 0 || h.BlockLen == 0 || h.TotalLen == 0 {
		return FrameHeader{}, nil, ErrInvalidFrame
	}
	if len(frame) != HeaderLen+int(h.BlockLen) {
		return FrameHeader{}, nil, ErrWrongLength
	}
	return h, frame[HeaderLen:], nil
}

func StreamIdentity(h FrameHeader) string {
	return fmt.Sprintf("%d:%d:%d:%d:%d", h.SessionID, h.BlockCount, h.BlockLen, h.TotalLen, h.PayloadFNV)
}

func FNV1a(data []byte) uint32 {
	h := uint32(0x811c9dc5)
	for _, b := range data {
		h ^= uint32(b)
		h *= 0x01000193
	}
	return h
}
