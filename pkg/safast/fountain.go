package safast

import (
	"errors"
	"math"
)

const (
	ln2          = 0.6931471805599453
	solitonC     = 0.1
	solitonDelta = 0.5
)

func deterministicLog(x float64) float64 {
	e, m := 0, x
	for m >= 1.5 {
		m /= 2
		e++
	}
	for m < 0.75 {
		m *= 2
		e--
	}
	z := (m - 1) / (m + 1)
	z2 := z * z
	term, sum := z, 0.0
	for n := 1; n <= 21; n += 2 {
		sum += term / float64(n)
		term *= z2
	}
	return float64(e)*ln2 + 2*sum
}

func solitonCDF(k int) []float64 {
	cdf := make([]float64, k)
	if k == 1 {
		cdf[0] = 1
		return cdf
	}
	r := math.Max(1, solitonC*deterministicLog(float64(k)/solitonDelta)*math.Sqrt(float64(k)))
	spike := int(math.Ceil(float64(k) / r))
	if spike > k {
		spike = k
	}
	total := 0.0
	for d := 1; d <= k; d++ {
		rho := 1.0 / float64(d*(d-1))
		if d == 1 {
			rho = 1.0 / float64(k)
		}
		tau := 0.0
		if d < spike {
			tau = r / float64(d*k)
		} else if d == spike {
			tau = (r * math.Max(0, deterministicLog(r/solitonDelta))) / float64(k)
		}
		total += rho + tau
		cdf[d-1] = total
	}
	for i := range cdf {
		cdf[i] /= total
	}
	cdf[k-1] = 1
	return cdf
}

type splitmix32 struct{ state uint32 }

func (s *splitmix32) next() uint32 {
	s.state += 0x9e3779b9
	t := s.state ^ (s.state >> 16)
	t *= 0x21f0aaad
	t ^= t >> 15
	t *= 0x735a2d97
	t ^= t >> 15
	return t
}

func frameSeed(sessionID uint16, seq uint32) uint32 {
	h := uint32(sessionID+1)*0x9e3779b1 ^ (seq + 0x85ebca6b)
	h = (h ^ (h >> 13)) * 0xc2b2ae35
	return h ^ (h >> 16)
}

func frameIndices(k int, cdf []float64, sessionID uint16, seq uint32) []int {
	rng := splitmix32{state: frameSeed(sessionID, seq)}
	u := float64(rng.next()) * math.Ldexp(1, -32)
	lo, hi := 0, k-1
	for lo < hi {
		mid := (lo + hi) >> 1
		if cdf[mid] >= u {
			hi = mid
		} else {
			lo = mid + 1
		}
	}
	degree := lo + 1
	if degree > k {
		degree = k
	}
	if degree > k>>3 {
		scratch := make([]int, k)
		for i := range scratch {
			scratch[i] = i
		}
		out := make([]int, degree)
		for i := 0; i < degree; i++ {
			j := i + int(rng.next()%uint32(k-i))
			scratch[i], scratch[j] = scratch[j], scratch[i]
			out[i] = scratch[i]
		}
		return out
	}
	set := make(map[int]struct{}, degree)
	for len(set) < degree {
		set[int(rng.next()%uint32(k))] = struct{}{}
	}
	out := make([]int, 0, degree)
	for i := range set {
		out = append(out, i)
	}
	return out
}

type LTEncoder struct {
	K         int
	BlockLen  int
	SessionID uint16
	blocks    [][]byte
	cdf       []float64
}

func NewLTEncoder(payload []byte, blockLen int, sessionID uint16) (*LTEncoder, error) {
	if len(payload) == 0 || blockLen <= 0 {
		return nil, errors.New("payload and block length must be non-zero")
	}
	k := (len(payload) + blockLen - 1) / blockLen
	if k > 0xffff {
		return nil, errors.New("source block count exceeds uint16 wire limit")
	}
	blocks := make([][]byte, k)
	for i := 0; i < k; i++ {
		blocks[i] = make([]byte, blockLen)
		start := i * blockLen
		end := start + blockLen
		if end > len(payload) {
			end = len(payload)
		}
		copy(blocks[i], payload[start:end])
	}
	return &LTEncoder{K: k, BlockLen: blockLen, SessionID: sessionID, blocks: blocks, cdf: solitonCDF(k)}, nil
}

func (e *LTEncoder) Encode(seq uint32) []byte {
	out := make([]byte, e.BlockLen)
	for _, idx := range frameIndices(e.K, e.cdf, e.SessionID, seq) {
		for i, b := range e.blocks[idx] {
			out[i] ^= b
		}
	}
	return out
}

type pendingFrame struct {
	indices map[int]struct{}
	bytes   []byte
}

type LTDecoder struct {
	K         int
	BlockLen  int
	SessionID uint16
	TotalLen  int
	cdf       []float64
	solved    [][]byte
	byBlock   map[int]map[*pendingFrame]struct{}
	seen      map[uint32]struct{}
	Solved    int
	FramesNew int
	FramesDup int
}

func NewLTDecoder(k, blockLen int, sessionID uint16, totalLen int) (*LTDecoder, error) {
	if k <= 0 || k > 0xffff || blockLen <= 0 || totalLen <= 0 {
		return nil, errors.New("invalid decoder dimensions")
	}
	return &LTDecoder{K: k, BlockLen: blockLen, SessionID: sessionID, TotalLen: totalLen, cdf: solitonCDF(k), solved: make([][]byte, k), byBlock: map[int]map[*pendingFrame]struct{}{}, seen: map[uint32]struct{}{}}, nil
}

func xorInto(dst, src []byte) {
	for i := range dst {
		dst[i] ^= src[i]
	}
}

func (d *LTDecoder) Complete() bool { return d.Solved >= d.K }

func (d *LTDecoder) AddFrame(seq uint32, block []byte) error {
	if len(block) != d.BlockLen {
		return ErrWrongLength
	}
	if _, ok := d.seen[seq]; ok {
		d.FramesDup++
		return nil
	}
	d.seen[seq] = struct{}{}
	d.FramesNew++
	if d.Complete() {
		return nil
	}
	indices := map[int]struct{}{}
	for _, idx := range frameIndices(d.K, d.cdf, d.SessionID, seq) {
		indices[idx] = struct{}{}
	}
	data := append([]byte(nil), block...)
	for idx := range indices {
		if solved := d.solved[idx]; solved != nil {
			xorInto(data, solved)
			delete(indices, idx)
		}
	}
	if len(indices) == 0 {
		return nil
	}
	if len(indices) == 1 {
		for idx := range indices {
			d.resolve(idx, data)
		}
		return nil
	}
	pf := &pendingFrame{indices: indices, bytes: data}
	for idx := range indices {
		if d.byBlock[idx] == nil {
			d.byBlock[idx] = map[*pendingFrame]struct{}{}
		}
		d.byBlock[idx][pf] = struct{}{}
	}
	return nil
}

func (d *LTDecoder) resolve(first int, firstBytes []byte) {
	type item struct {
		idx   int
		bytes []byte
	}
	queue := []item{{first, firstBytes}}
	for len(queue) > 0 {
		last := len(queue) - 1
		cur := queue[last]
		queue = queue[:last]
		if d.solved[cur.idx] != nil {
			continue
		}
		d.solved[cur.idx] = append([]byte(nil), cur.bytes...)
		d.Solved++
		waiting := d.byBlock[cur.idx]
		delete(d.byBlock, cur.idx)
		for pf := range waiting {
			xorInto(pf.bytes, cur.bytes)
			delete(pf.indices, cur.idx)
			if len(pf.indices) == 1 {
				for next := range pf.indices {
					delete(d.byBlock[next], pf)
					if d.solved[next] == nil {
						queue = append(queue, item{next, pf.bytes})
					}
				}
			}
		}
	}
}

func (d *LTDecoder) Assemble() ([]byte, bool) {
	if !d.Complete() {
		return nil, false
	}
	out := make([]byte, d.TotalLen)
	for i, block := range d.solved {
		start := i * d.BlockLen
		if start >= len(out) {
			break
		}
		end := start + d.BlockLen
		if end > len(out) {
			end = len(out)
		}
		copy(out[start:end], block[:end-start])
	}
	return out, true
}
