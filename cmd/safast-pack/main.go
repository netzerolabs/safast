package main

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"mime"
	"os"
	"path/filepath"

	"github.com/netzerolabs/safast/pkg/safast"
)

type outputFrame struct {
	Sequence uint32 `json:"sequence"`
	Frame    string `json:"frame_base64"`
}

func main() {
	blockLen := flag.Int("block-bytes", 1200, "fountain payload bytes per QR frame")
	count := flag.Int("frames", 0, "number of frames to emit; default is ceil(K*1.35)+16")
	flag.Parse()
	if flag.NArg() != 1 {
		log.Fatal("usage: safast-pack [flags] FILE")
	}
	path := flag.Arg(0)
	data, err := os.ReadFile(path)
	if err != nil {
		log.Fatal(err)
	}
	mediaType := mime.TypeByExtension(filepath.Ext(path))
	packed, err := safast.PackFile(filepath.Base(path), mediaType, data)
	if err != nil {
		log.Fatal(err)
	}
	var sid [2]byte
	if _, err := rand.Read(sid[:]); err != nil {
		log.Fatal(err)
	}
	sessionID := uint16(sid[0]) | uint16(sid[1])<<8
	if sessionID == 0 {
		sessionID = 1
	}
	enc, err := safast.NewLTEncoder(packed.Container, *blockLen, sessionID)
	if err != nil {
		log.Fatal(err)
	}
	frames := *count
	if frames <= 0 {
		frames = (enc.K*135+99)/100 + 16
	}
	header := safast.FrameHeader{SessionID: sessionID, BlockCount: uint16(enc.K), BlockLen: uint16(enc.BlockLen), TotalLen: uint32(len(packed.Container)), PayloadFNV: safast.FNV1a(packed.Container)}
	writer := bufio.NewWriter(os.Stdout)
	defer writer.Flush()
	meta := map[string]any{"type": "manifest", "file": filepath.Base(path), "session_id": sessionID, "k": enc.K, "block_len": enc.BlockLen, "container_len": len(packed.Container), "sha256_verified_on_receive": true}
	encodedMeta, _ := json.Marshal(meta)
	fmt.Fprintln(writer, string(encodedMeta))
	for seq := 0; seq < frames; seq++ {
		header.Sequence = uint32(seq)
		frame, err := safast.PackFrame(header, enc.Encode(uint32(seq)))
		if err != nil {
			log.Fatal(err)
		}
		line, _ := json.Marshal(outputFrame{Sequence: uint32(seq), Frame: base64.StdEncoding.EncodeToString(frame)})
		fmt.Fprintln(writer, string(line))
	}
}
