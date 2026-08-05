package safast

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"mime"
	"path/filepath"
	"strings"
	"unicode"
)

const (
	MaxFileBytes  = 64 * 1024 * 1024
	fileHeaderLen = 49
)

var fileMagic = [4]byte{'D', 'C', 'F', '2'}

var (
	ErrInvalidContainer = errors.New("invalid SAFAST file container")
	ErrChecksum         = errors.New("SHA-256 verification failed")
)

type PackedFile struct {
	Container       []byte
	Compression     string
	OriginalSize    int
	TransmittedSize int
}

type OpticalFile struct {
	Name            string
	MediaType       string
	Bytes           []byte
	SHA256          [32]byte
	Compression     string
	TransmittedSize int
}

func safeFileName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." {
		return "transfer.bin"
	}
	return name
}

func shouldTryGzip(mediaType string, size int) bool {
	if size < 768 {
		return false
	}
	mt, _, _ := mime.ParseMediaType(mediaType)
	mt = strings.ToLower(mt)
	if strings.HasPrefix(mt, "video/") {
		return false
	}
	if strings.HasPrefix(mt, "image/") && mt != "image/bmp" && mt != "image/svg+xml" && mt != "image/tiff" {
		return false
	}
	if strings.HasPrefix(mt, "audio/") && mt != "audio/wav" && mt != "audio/x-wav" && mt != "audio/aiff" {
		return false
	}
	for _, suffix := range []string{"zip", "gzip", "x-7z-compressed", "x-rar-compressed", "zstd"} {
		if strings.HasSuffix(mt, suffix) {
			return false
		}
	}
	return true
}

func PackFile(name, mediaType string, data []byte) (PackedFile, error) {
	if len(data) == 0 {
		return PackedFile{}, errors.New("cannot pack an empty file")
	}
	if len(data) > MaxFileBytes {
		return PackedFile{}, fmt.Errorf("file exceeds %d-byte limit", MaxFileBytes)
	}
	name = safeFileName(name)
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}
	nameBytes, typeBytes := []byte(name), []byte(mediaType)
	if len(nameBytes) > 0xffff || len(typeBytes) > 0xffff {
		return PackedFile{}, errors.New("file name or media type is too long")
	}

	transmitted := data
	compression := byte(0)
	compressionName := "none"
	if shouldTryGzip(mediaType, len(data)) {
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestSpeed)
		if _, err := zw.Write(data); err != nil {
			return PackedFile{}, err
		}
		if err := zw.Close(); err != nil {
			return PackedFile{}, err
		}
		if buf.Len()+64 < len(data) {
			transmitted = append([]byte(nil), buf.Bytes()...)
			compression = 1
			compressionName = "gzip"
		}
	}

	out := make([]byte, fileHeaderLen+len(nameBytes)+len(typeBytes)+len(transmitted))
	copy(out[:4], fileMagic[:])
	out[4] = compression
	binary.LittleEndian.PutUint16(out[5:7], uint16(len(nameBytes)))
	binary.LittleEndian.PutUint16(out[7:9], uint16(len(typeBytes)))
	binary.LittleEndian.PutUint32(out[9:13], uint32(len(data)))
	binary.LittleEndian.PutUint32(out[13:17], uint32(len(transmitted)))
	sum := sha256.Sum256(data)
	copy(out[17:49], sum[:])
	off := fileHeaderLen
	copy(out[off:], nameBytes)
	off += len(nameBytes)
	copy(out[off:], typeBytes)
	off += len(typeBytes)
	copy(out[off:], transmitted)
	return PackedFile{out, compressionName, len(data), len(transmitted)}, nil
}

func UnpackFile(container []byte) (OpticalFile, error) {
	if len(container) < fileHeaderLen || !bytes.Equal(container[:4], fileMagic[:]) {
		return OpticalFile{}, ErrInvalidContainer
	}
	compression := container[4]
	if compression > 1 {
		return OpticalFile{}, fmt.Errorf("%w: unsupported compression", ErrInvalidContainer)
	}
	nameLen := int(binary.LittleEndian.Uint16(container[5:7]))
	typeLen := int(binary.LittleEndian.Uint16(container[7:9]))
	fileLen := int(binary.LittleEndian.Uint32(container[9:13]))
	transmittedLen := int(binary.LittleEndian.Uint32(container[13:17]))
	dataOffset := fileHeaderLen + nameLen + typeLen
	if fileLen <= 0 || fileLen > MaxFileBytes || transmittedLen <= 0 || transmittedLen > MaxFileBytes || dataOffset+transmittedLen != len(container) {
		return OpticalFile{}, fmt.Errorf("%w: inconsistent lengths", ErrInvalidContainer)
	}
	name := safeFileName(string(container[fileHeaderLen : fileHeaderLen+nameLen]))
	mediaType := string(container[fileHeaderLen+nameLen : dataOffset])
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}
	payload := container[dataOffset:]
	data := payload
	compressionName := "none"
	if compression == 1 {
		compressionName = "gzip"
		zr, err := gzip.NewReader(bytes.NewReader(payload))
		if err != nil {
			return OpticalFile{}, fmt.Errorf("%w: %v", ErrInvalidContainer, err)
		}
		decompressed, err := io.ReadAll(io.LimitReader(zr, int64(fileLen)+1))
		closeErr := zr.Close()
		if err != nil {
			return OpticalFile{}, err
		}
		if closeErr != nil {
			return OpticalFile{}, closeErr
		}
		if len(decompressed) != fileLen {
			return OpticalFile{}, fmt.Errorf("%w: decompressed length mismatch", ErrInvalidContainer)
		}
		data = decompressed
	} else if len(data) != fileLen {
		return OpticalFile{}, fmt.Errorf("%w: file length mismatch", ErrInvalidContainer)
	}
	var expected [32]byte
	copy(expected[:], container[17:49])
	actual := sha256.Sum256(data)
	if actual != expected {
		return OpticalFile{}, ErrChecksum
	}
	return OpticalFile{name, mediaType, append([]byte(nil), data...), expected, compressionName, transmittedLen}, nil
}
