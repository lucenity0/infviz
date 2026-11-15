"""Block-level KV bookkeeping: free list, ref-counted sharing, prefix cache, LRU eviction.

Pure Python, no tensors. Every mutation emits an event (docs/EVENTS.md) so the frontend
can rebuild the exact pool state.
"""
from __future__ import annotations

import heapq
import itertools
from dataclasses import dataclass, field

from .events import Emitter

FREE, USED, CACHED = "free", "used", "cached"


@dataclass
class Block:
    state: str = FREE
    owners: set[int] = field(default_factory=set)
    filled: int = 0
    hash: int | None = None
    last_used: int = 0


@dataclass
class SeqKV:
    table: list[int] = field(default_factory=list)  # logical idx -> physical block
    kv_len: int = 0                                  # tokens with valid KV in this pool


class BlockPool:
    def __init__(self, name: str, n_blocks: int, block_size: int, em: Emitter):
        self.name, self.n, self.bs, self.em = name, n_blocks, block_size, em
        self.blocks = [Block() for _ in range(n_blocks)]
        self.free: list[int] = list(range(n_blocks))  # min-heap: fill the grid top-left first
        heapq.heapify(self.free)
        self.by_hash: dict[int, int] = {}
        self.seqs: dict[int, SeqKV] = {}
        self._clock = itertools.count(1)

    # ------------------------------------------------------------- queries
    def n_free(self) -> int:
        return len(self.free)

    def n_evictable(self) -> int:
        return sum(1 for b in self.blocks if b.state == CACHED)

    def available(self) -> int:
        return self.n_free() + self.n_evictable()

    def blocks_needed(self, rid: int, new_len: int) -> int:
        have = len(self.seqs[rid].table) if rid in self.seqs else 0
        return max(0, -(-new_len // self.bs) - have)

    def kv_len(self, rid: int) -> int:
        return self.seqs[rid].kv_len if rid in self.seqs else 0

    def slots(self, rid: int, upto: int) -> list[int]:
        t, bs = self.seqs[rid].table, self.bs
        return [t[p // bs] * bs + p % bs for p in range(upto)]

    # ------------------------------------------------------------- mutations
    def _emit(self, type_: str, **kw) -> None:
        self.em.emit(type_, pool=self.name, **kw)

    def _take_free(self) -> int | None:
        if not self.free:
            victims = [(b.last_used, i) for i, b in enumerate(self.blocks) if b.state == CACHED]
            if not victims:
                return None
            _, i = min(victims)
            b = self.blocks[i]
            del self.by_hash[b.hash]
            b.state, b.filled, b.hash = FREE, 0, None
            self._emit("block_evict", block=i)
            heapq.heappush(self.free, i)
        return heapq.heappop(self.free)

    def match_prefix(self, rid: int, tokens: list[int], max_tokens: int) -> int:
        """Reuse cached/used full blocks matching ``tokens``' prefix. Returns tokens matched."""
        seq = self.seqs.setdefault(rid, SeqKV())
        assert not seq.table, "match_prefix on a sequence that already has blocks"
        h, matched = None, 0
        while matched + self.bs <= max_tokens:
            h = hash((h, tuple(tokens[matched : matched + self.bs])))
            i = self.by_hash.get(h)
            if i is None:
                break
            b = self.blocks[i]
            b.state = USED
            b.owners.add(rid)
            b.last_used = next(self._clock)
            seq.table.append(i)
            self._emit("block_hit", block=i, rid=rid, idx=len(seq.table) - 1)
            matched += self.bs
        seq.kv_len = matched
        return matched

    def ensure(self, rid: int, new_len: int) -> bool:
        """Allocate blocks so ``rid`` can hold ``new_len`` tokens. False if out of memory
        (blocks allocated so far are kept)."""
        seq = self.seqs.setdefault(rid, SeqKV())
        while len(seq.table) * self.bs < new_len:
            i = self._take_free()
            if i is None:
                return False
            b = self.blocks[i]
            b.state, b.owners, b.filled, b.hash = USED, {rid}, 0, None
            b.last_used = next(self._clock)
            seq.table.append(i)
            self._emit("block_alloc", block=i, rid=rid, idx=len(seq.table) - 1)
        return True

    def set_len(self, rid: int, new_len: int) -> None:
        """Set valid KV length (grow after a write, shrink on rollback). Emits fills/frees."""
        seq = self.seqs[rid]
        old = seq.kv_len
        if new_len < old:
            self.em.emit("kv_rollback", rid=rid, pool=self.name, old_len=old, new_len=new_len)
        seq.kv_len = new_len
        lo, hi = min(old, new_len) // self.bs, -(-max(old, new_len) // self.bs)
        for idx in range(lo, min(hi, len(seq.table))):
            b = self.blocks[seq.table[idx]]
            f = max(0, min(self.bs, new_len - idx * self.bs))
            if b.filled != f and len(b.owners) == 1:
                b.filled = f
                self._emit("block_fill", block=seq.table[idx], filled=f)
        # on rollback, drop now-empty trailing blocks (speculative overshoot)
        keep = -(-new_len // self.bs)
        while new_len < old and len(seq.table) > keep:
            i = seq.table.pop()
            self._release_block(i, rid, can_cache=False)

    def commit(self, rid: int, tokens: list[int], n_committed: int) -> None:
        """Register full blocks of committed tokens in the prefix cache index."""
        seq, h = self.seqs[rid], None
        full = min(n_committed, seq.kv_len) // self.bs
        for idx in range(full):
            h = hash((h, tuple(tokens[idx * self.bs : (idx + 1) * self.bs])))
            b = self.blocks[seq.table[idx]]
            if b.hash is None and h not in self.by_hash:
                b.hash = h
                self.by_hash[h] = seq.table[idx]

    def release(self, rid: int) -> None:
        seq = self.seqs.pop(rid, None)
        if not seq:
            return
        for i in reversed(seq.table):  # tail first => LRU evicts tails before shared heads
            self._release_block(i, rid, can_cache=True)

    def _release_block(self, i: int, rid: int, can_cache: bool) -> None:
        b = self.blocks[i]
        b.owners.discard(rid)
        if b.owners:
            self._emit("block_release", block=i, rid=rid)
        elif can_cache and b.hash is not None and b.filled == self.bs:
            b.state, b.last_used = CACHED, next(self._clock)
            self._emit("block_cache", block=i)
        else:
            if b.hash is not None:
                self.by_hash.pop(b.hash, None)
            b.state, b.filled, b.hash = FREE, 0, None
            heapq.heappush(self.free, i)
            self._emit("block_free", block=i)

    # ------------------------------------------------------------- introspection
    def snapshot(self) -> dict:
        return {
            "blocks": [
                {"state": b.state, "owners": sorted(b.owners), "filled": b.filled} for b in self.blocks
            ]
        }

    def check(self) -> None:
        """Invariants (used by tests)."""
        free = set(self.free)
        assert len(free) == len(self.free), "duplicate in free list"
        for i, b in enumerate(self.blocks):
            assert (i in free) == (b.state == FREE), (i, b)
            if b.state == FREE:
                assert not b.owners and b.filled == 0 and b.hash is None
            if b.state == CACHED:
                assert not b.owners and b.hash is not None and self.by_hash.get(b.hash) == i
            if b.state == USED:
                assert b.owners
        for rid, s in self.seqs.items():
            assert len(s.table) * self.bs >= s.kv_len
            for i in s.table:
                assert rid in self.blocks[i].owners
        for h, i in self.by_hash.items():
            assert self.blocks[i].hash == h
