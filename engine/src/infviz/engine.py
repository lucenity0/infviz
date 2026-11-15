"""Continuous-batching engine with paged KV and greedy speculative decoding.

One ``step()`` = (admit) -> (reserve KV, preempting on pressure) -> (draft k tokens for
decode lanes) -> (one ragged target forward: prefill lanes + verify lanes) -> (accept /
rollback / commit / finish). Every state change is emitted as an event.
"""
from __future__ import annotations

import json
import queue
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

import torch
from tokenizers import Tokenizer

from .events import Emitter
from .kv import BlockPool
from .model import Model, SeqInput

DEFAULT_SYSTEM = "You are a helpful assistant."


def chat_prompt(user: str, system: str = DEFAULT_SYSTEM) -> str:
    return (
        f"<|im_start|>system\n{system}<|im_end|>\n"
        f"<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n"
    )


@dataclass
class Request:
    rid: int
    prompt_text: str
    prompt_ids: list[int]
    max_new: int
    output: list[int] = field(default_factory=list)
    text: str = ""
    prefilled: bool = False
    done: bool = False

    @property
    def all(self) -> list[int]:
        return self.prompt_ids + self.output


def resolve_model(name_or_path: str) -> Path:
    p = Path(name_or_path)
    if p.exists():
        return p
    from huggingface_hub import snapshot_download

    return Path(snapshot_download(name_or_path, allow_patterns=["*.json", "*.safetensors", "*.txt"]))


def default_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class Engine:
    def __init__(
        self,
        target: str,
        draft: str | None = None,
        *,
        device: str | None = None,
        dtype: torch.dtype = torch.bfloat16,
        block_size: int = 16,
        n_blocks: int = 48,
        draft_blocks: int | None = None,
        max_batch: int = 6,
        spec_k: int = 4,
        prefill_budget: int = 1024,
        snapshot_every: int = 8,
        emitter: Emitter | None = None,
    ):
        self.device = device or default_device()
        self.em = emitter or Emitter()
        tpath = resolve_model(target)
        self.target = Model(tpath, self.device, dtype)
        self.draft = Model(resolve_model(draft), self.device, dtype) if draft and spec_k > 0 else None
        self.k = spec_k if self.draft else 0
        self.tok = Tokenizer.from_file(str(tpath / "tokenizer.json"))
        self.eos = self._eos_ids(tpath)
        # argmax only over real tokenizer ids: embedding matrices are often padded (e.g. Qwen2.5-7B
        # has 152064 rows vs 151936 for 0.5B), and padded ids must never be picked or compared.
        self.V = self.tok.get_vocab_size(with_added_tokens=True)
        self.bs, self.max_batch = block_size, max_batch
        self.prefill_budget, self.snapshot_every = prefill_budget, snapshot_every

        self.tpool = BlockPool("target", n_blocks, block_size, self.em)
        self.tcache = self.target.new_cache(n_blocks, block_size)
        if self.draft:
            db = draft_blocks or n_blocks
            self.dpool = BlockPool("draft", db, block_size, self.em)
            self.dcache = self.draft.new_cache(db, block_size)
        else:
            self.dpool = None

        self.reqs: dict[int, Request] = {}
        self.waiting: deque[int] = deque()
        self.running: list[int] = []
        self.finished: list[int] = []
        self.inbox: queue.Queue[Request] = queue.Queue()
        self._rid_lock = threading.Lock()
        self._next_rid = 0
        self.step_delay = 0.0
        self._wake = threading.Event()

        pools = {"target": {"n_blocks": n_blocks}}
        if self.dpool:
            pools["draft"] = {"n_blocks": self.dpool.n}
        self.em.emit(
            "config",
            models={"target": str(target), "draft": str(draft) if self.draft else None},
            device=self.device,
            block_size=block_size,
            pools=pools,
            max_batch=max_batch,
            spec_k=self.k,
            snapshot_every=snapshot_every,
        )
        self.em.emit("snapshot", **self.snapshot())

    # ------------------------------------------------------------------ setup
    @staticmethod
    def _eos_ids(path: Path) -> set[int]:
        ids: set[int] = set()
        for fn in ("generation_config.json", "config.json"):
            f = path / fn
            if f.exists():
                e = json.loads(f.read_text()).get("eos_token_id")
                if isinstance(e, int):
                    ids.add(e)
                elif isinstance(e, list):
                    ids.update(e)
        return ids

    # ------------------------------------------------------------------ API
    def add_request(self, prompt: str, max_new_tokens: int = 128, *, chat: bool = True,
                    system: str = DEFAULT_SYSTEM) -> int:
        """Thread-safe. Returns the request id; the request arrives at the next step."""
        text = chat_prompt(prompt, system) if chat else prompt
        ids = self.tok.encode(text, add_special_tokens=False).ids
        cap = min(self.tpool.n, self.dpool.n if self.dpool else self.tpool.n) * self.bs
        if len(ids) + max_new_tokens + self.k + 1 + self.bs > cap:
            raise ValueError(f"request needs >{cap} KV tokens; raise n_blocks or shorten it")
        with self._rid_lock:
            rid = self._next_rid
            self._next_rid += 1
        self.inbox.put(Request(rid, prompt, ids, max_new_tokens))
        return rid

    def wake(self) -> None:
        self._wake.set()

    def has_work(self) -> bool:
        return bool(self.running or self.waiting or not self.inbox.empty())

    def decode(self, ids: list[int]) -> str:
        return self.tok.decode(ids, skip_special_tokens=False)

    # ------------------------------------------------------------------ step
    def step(self) -> bool:
        self._drain_inbox()
        if not (self.running or self.waiting):
            return False
        self.em.step += 1
        t0 = time.perf_counter()
        self._admit()
        self._reserve()
        prefills = [self.reqs[r] for r in self.running if not self.reqs[r].prefilled]
        decodes = [self.reqs[r] for r in self.running if self.reqs[r].prefilled]
        batch = [
            {"rid": r.rid, "phase": "prefill", "n_tokens": len(r.all) - self.tpool.kv_len(r.rid)}
            for r in prefills
        ] + [{"rid": r.rid, "phase": "decode", "n_tokens": self.k + 1} for r in decodes]
        self.em.emit("step_begin", batch=batch)

        proposals = self._draft(decodes) if self.k else {}
        self._target(prefills, decodes, proposals)

        if self.device == "mps":
            torch.mps.synchronize()
        self.em.emit("step_end", ms=round((time.perf_counter() - t0) * 1000, 2),
                     n_tokens=sum(b["n_tokens"] for b in batch))
        if self.em.step % self.snapshot_every == 0:
            self.em.emit("snapshot", **self.snapshot())
        return True

    def run_until_idle(self, max_steps: int = 100_000) -> None:
        for _ in range(max_steps):
            if not self.step() and self.inbox.empty():
                break
        self.em.emit("snapshot", **self.snapshot())

    # ------------------------------------------------------------------ phases
    def _drain_inbox(self) -> None:
        while True:
            try:
                r = self.inbox.get_nowait()
            except queue.Empty:
                return
            self.reqs[r.rid] = r
            self.waiting.append(r.rid)
            self.em.emit("req_arrive", rid=r.rid, prompt_text=r.prompt_text,
                         prompt_len=len(r.prompt_ids), max_new_tokens=r.max_new)

    def _admit(self) -> None:
        budget = self.prefill_budget
        while self.waiting and len(self.running) < self.max_batch:
            r = self.reqs[self.waiting[0]]
            n = len(r.all)
            need = -(-n // self.bs) + len(self.running)  # + one growth block per running lane
            if self.tpool.available() < need:
                break
            if self.dpool and self.dpool.available() < need:
                break
            if n > budget and budget < self.prefill_budget:
                break
            self.waiting.popleft()
            self.running.append(r.rid)
            self.em.emit("req_admit", rid=r.rid)
            self.tpool.match_prefix(r.rid, r.all, len(r.all) - 1)
            if self.dpool:
                self.dpool.match_prefix(r.rid, r.all, len(r.all) - 1)
            budget -= n

    def _reserve(self) -> None:
        """Make sure every running lane has KV room for this step; preempt newest on failure."""
        i = 0
        while i < len(self.running):
            r = self.reqs[self.running[i]]
            if r.prefilled:
                t_need = self.tpool.kv_len(r.rid) + self.k + 1
                d_need = self.tpool.kv_len(r.rid) + self.k  # draft writes up to T+k-1
            else:
                t_need, d_need = len(r.all), 0
            ok = self.tpool.ensure(r.rid, t_need)
            if ok and self.dpool and d_need:
                ok = self.dpool.ensure(r.rid, d_need)
            if ok:
                i += 1
                continue
            victim = self.running[-1]
            self._preempt(victim)
            if victim == r.rid:
                continue  # r itself gone; same index now points at the next lane (if any)

    def _preempt(self, rid: int) -> None:
        r = self.reqs[rid]
        self.tpool.release(rid)
        if self.dpool:
            self.dpool.release(rid)
        r.prefilled = False
        self.running.remove(rid)
        self.waiting.appendleft(rid)
        self.em.emit("req_preempt", rid=rid, reason="kv_pressure")

    def _draft(self, decodes: list[Request]) -> dict[int, list[int]]:
        props: dict[int, list[int]] = {r.rid: [] for r in decodes}
        if not decodes:
            return props
        for j in range(self.k):
            inputs = []
            for r in decodes:
                start = self.dpool.kv_len(r.rid)
                toks = r.all[start:] if j == 0 else [props[r.rid][-1]]
                inputs.append(SeqInput(toks, start, self.dpool.slots(r.rid, start + len(toks))))
            logits = self.draft.forward(inputs, self.dcache)
            for r, inp, lg in zip(decodes, inputs, logits):
                self.dpool.set_len(r.rid, inp.start_pos + len(inp.tokens))
                props[r.rid].append(int(lg[-1, : self.V].argmax()))
        for r in decodes:
            p = props[r.rid]
            self.em.emit("draft_propose", rid=r.rid, tokens=p, texts=[self.decode([t]) for t in p])
        return props

    def _target(self, prefills: list[Request], decodes: list[Request],
                props: dict[int, list[int]]) -> None:
        lanes = prefills + decodes
        if not lanes:
            return
        inputs = []
        for r in prefills:
            T = self.tpool.kv_len(r.rid)
            inputs.append(SeqInput(r.all[T:], T, self.tpool.slots(r.rid, len(r.all))))
        for r in decodes:
            T = self.tpool.kv_len(r.rid)
            toks = [r.all[-1]] + props.get(r.rid, [])
            inputs.append(SeqInput(toks, T, self.tpool.slots(r.rid, T + len(toks)), all_logits=True))
        logits = self.target.forward(inputs, self.tcache)

        for r, inp, lg in zip(lanes, inputs, logits):
            T = inp.start_pos
            self.tpool.set_len(r.rid, T + len(inp.tokens))
            preds = lg[:, : self.V].argmax(-1).tolist()
            if not r.prefilled:
                r.prefilled = True
                self._commit(r, [preds[-1]])
                continue
            p = props.get(r.rid, [])
            n = 0
            while n < len(p) and p[n] == preds[n]:
                n += 1
            tt = preds[n]
            if self.k:
                self.em.emit("verify", rid=r.rid, n_accepted=n, target_token=tt,
                             target_text=self.decode([tt]))
                self.tpool.set_len(r.rid, T + n + 1)
                self.dpool.set_len(r.rid, min(self.dpool.kv_len(r.rid), T + n + 1))
            self._commit(r, p[:n] + [tt])

    def _commit(self, r: Request, toks: list[int]) -> None:
        for t in toks:
            r.output.append(t)
            full = self.tok.decode(r.output, skip_special_tokens=True)
            delta = "" if full.endswith("�") else full[len(r.text):]
            if delta:
                r.text = full
            self.em.emit("token", rid=r.rid, token=t, text=delta)
            if t in self.eos or len(r.output) >= r.max_new:
                r.done = True
                break
        self.tpool.commit(r.rid, r.all, len(r.all))
        if self.dpool:
            self.dpool.commit(r.rid, r.all, len(r.all))
        if r.done:
            self.tpool.release(r.rid)
            if self.dpool:
                self.dpool.release(r.rid)
            self.running.remove(r.rid)
            self.finished.append(r.rid)
            reason = "eos" if r.output[-1] in self.eos else "length"
            self.em.emit("req_finish", rid=r.rid, reason=reason, output_len=len(r.output))

    # ------------------------------------------------------------------ state
    def snapshot(self) -> dict:
        pools = {"target": self.tpool.snapshot()}
        if self.dpool:
            pools["draft"] = self.dpool.snapshot()
        seqs = {
            str(rid): {"kv_len": self.tpool.kv_len(rid), "n_generated": len(self.reqs[rid].output)}
            for rid in list(self.waiting) + self.running
        }
        return {"pools": pools, "waiting": list(self.waiting), "running": list(self.running),
                "finished": list(self.finished), "seqs": seqs}

    def check(self) -> None:
        self.tpool.check()
        if self.dpool:
            self.dpool.check()
        for rid in self.running:
            r = self.reqs[rid]
            if r.prefilled:
                assert self.tpool.kv_len(rid) == len(r.all) - 1, (rid, self.tpool.kv_len(rid), len(r.all))
