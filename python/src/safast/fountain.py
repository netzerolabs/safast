from __future__ import annotations

from dataclasses import dataclass, field
import math

_LN2 = 0.6931471805599453
_SOLITON_C = 0.1
_SOLITON_DELTA = 0.5
_MASK32 = 0xFFFFFFFF


def _dlog(value: float) -> float:
    exponent = 0
    mantissa = value
    while mantissa >= 1.5:
        mantissa /= 2.0
        exponent += 1
    while mantissa < 0.75:
        mantissa *= 2.0
        exponent -= 1
    z = (mantissa - 1.0) / (mantissa + 1.0)
    z2 = z * z
    term = z
    total = 0.0
    for n in range(1, 22, 2):
        total += term / n
        term *= z2
    return exponent * _LN2 + 2.0 * total


def _soliton_cdf(k: int) -> list[float]:
    if k <= 0:
        raise ValueError("k must be positive")
    if k == 1:
        return [1.0]
    r = max(1.0, _SOLITON_C * _dlog(k / _SOLITON_DELTA) * math.sqrt(k))
    spike = min(k, math.ceil(k / r))
    cdf: list[float] = []
    total = 0.0
    for degree in range(1, k + 1):
        rho = 1 / k if degree == 1 else 1 / (degree * (degree - 1))
        tau = 0.0
        if degree < spike:
            tau = r / (degree * k)
        elif degree == spike:
            tau = (r * max(0.0, _dlog(r / _SOLITON_DELTA))) / k
        total += rho + tau
        cdf.append(total)
    cdf = [value / total for value in cdf]
    cdf[-1] = 1.0
    return cdf


class _SplitMix32:
    def __init__(self, seed: int) -> None:
        self.state = seed & _MASK32

    def next(self) -> int:
        self.state = (self.state + 0x9E3779B9) & _MASK32
        value = self.state ^ (self.state >> 16)
        value = (value * 0x21F0AAAD) & _MASK32
        value ^= value >> 15
        value = (value * 0x735A2D97) & _MASK32
        value ^= value >> 15
        return value & _MASK32


def _frame_seed(session_id: int, sequence: int) -> int:
    value = (((session_id + 1) * 0x9E3779B1) & _MASK32) ^ ((sequence + 0x85EBCA6B) & _MASK32)
    value = ((value ^ (value >> 13)) * 0xC2B2AE35) & _MASK32
    return (value ^ (value >> 16)) & _MASK32


def _frame_indices(k: int, cdf: list[float], session_id: int, sequence: int) -> list[int]:
    rng = _SplitMix32(_frame_seed(session_id, sequence))
    sample = rng.next() * 2.0**-32
    low, high = 0, k - 1
    while low < high:
        middle = (low + high) >> 1
        if cdf[middle] >= sample:
            high = middle
        else:
            low = middle + 1
    degree = min(k, low + 1)
    if degree > (k >> 3):
        scratch = list(range(k))
        output: list[int] = []
        for index in range(degree):
            swap = index + rng.next() % (k - index)
            scratch[index], scratch[swap] = scratch[swap], scratch[index]
            output.append(scratch[index])
        return output
    selected: set[int] = set()
    while len(selected) < degree:
        selected.add(rng.next() % k)
    return list(selected)


def _xor_into(destination: bytearray, source: bytes | bytearray) -> None:
    for index, value in enumerate(source):
        destination[index] ^= value


class LTEncoder:
    def __init__(self, payload: bytes, block_len: int, session_id: int) -> None:
        if not payload or block_len <= 0:
            raise ValueError("payload and block_len must be non-zero")
        self.block_len = block_len
        self.session_id = session_id
        self.k = max(1, math.ceil(len(payload) / block_len))
        if self.k > 0xFFFF:
            raise ValueError("source block count exceeds uint16 wire limit")
        self._blocks = []
        for index in range(self.k):
            block = payload[index * block_len : (index + 1) * block_len]
            self._blocks.append(block.ljust(block_len, b"\0"))
        self._cdf = _soliton_cdf(self.k)

    def encode(self, sequence: int) -> bytes:
        output = bytearray(self.block_len)
        for index in _frame_indices(self.k, self._cdf, self.session_id, sequence):
            _xor_into(output, self._blocks[index])
        return bytes(output)


@dataclass(eq=False, slots=True)
class _PendingFrame:
    indices: set[int]
    data: bytearray


@dataclass(slots=True)
class LTDecoder:
    k: int
    block_len: int
    session_id: int
    total_len: int
    solved_count: int = 0
    frames_new: int = 0
    frames_duplicate: int = 0
    _cdf: list[float] = field(init=False, repr=False)
    _solved: list[bytes | None] = field(init=False, repr=False)
    _by_block: dict[int, set[_PendingFrame]] = field(init=False, repr=False)
    _seen: set[int] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        if self.k <= 0 or self.k > 0xFFFF or self.block_len <= 0 or self.total_len <= 0:
            raise ValueError("invalid decoder dimensions")
        self._cdf = _soliton_cdf(self.k)
        self._solved = [None] * self.k
        self._by_block = {}
        self._seen = set()

    @property
    def complete(self) -> bool:
        return self.solved_count >= self.k

    def add_frame(self, sequence: int, block: bytes) -> None:
        if len(block) != self.block_len:
            raise ValueError("block length mismatch")
        if sequence in self._seen:
            self.frames_duplicate += 1
            return
        self._seen.add(sequence)
        self.frames_new += 1
        if self.complete:
            return
        indices = set(_frame_indices(self.k, self._cdf, self.session_id, sequence))
        data = bytearray(block)
        for index in tuple(indices):
            solved = self._solved[index]
            if solved is not None:
                _xor_into(data, solved)
                indices.remove(index)
        if not indices:
            return
        if len(indices) == 1:
            self._resolve(next(iter(indices)), data)
            return
        pending = _PendingFrame(indices, data)
        for index in indices:
            self._by_block.setdefault(index, set()).add(pending)

    def _resolve(self, first_index: int, first_data: bytearray) -> None:
        queue: list[tuple[int, bytearray]] = [(first_index, first_data)]
        while queue:
            index, data = queue.pop()
            if self._solved[index] is not None:
                continue
            self._solved[index] = bytes(data)
            self.solved_count += 1
            waiting = self._by_block.pop(index, set())
            for pending in waiting:
                _xor_into(pending.data, data)
                pending.indices.discard(index)
                if len(pending.indices) == 1:
                    next_index = next(iter(pending.indices))
                    self._by_block.get(next_index, set()).discard(pending)
                    if self._solved[next_index] is None:
                        queue.append((next_index, pending.data))

    def assemble(self) -> bytes | None:
        if not self.complete:
            return None
        return b"".join(block for block in self._solved if block is not None)[: self.total_len]
