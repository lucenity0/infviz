"""Correctness tests. The model tests download/load Qwen2.5 0.5B + 1.5B (cached after first run).

Run:  cd engine && uv run pytest -q          (all)
      uv run pytest -q -m "not models"       (pure bookkeeping only, instant)
"""
from __future__ import annotations

import gc
import random

import pytest
import torch

from infviz.events import Emitter
from infviz.kv import BlockPool
from infviz.replay import check_events

TARGET, DRAFT = "Qwen/Qwen2.5-1.5B-Instruct", "Qwen/Qwen2.5-0.5B-Instruct"
DEV = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
PROMPTS = [
    "Explain what a KV cache is in two sentences.",
    "Write a haiku about GPUs.",
    "List three prime numbers and add them.",
    "Count from one to twenty in words.",
    "Describe speculative decoding to a five year old.",
]


# ---------------------------------------------------------------- pure bookkeeping
def test_block_pool_random_ops_keep_invariants_and_replay_exactly():
    em, events = Emitter(), []
    em.sinks.append(events.append)
    em.emit("config", pools={"target": {"n_blocks": 12}})
    pool = BlockPool("target", 12, 4, em)
    rng = random.Random(0)
    prefixes = [[1, 2, 3, 4, 5, 6, 7, 8], [9, 9, 9, 9]]
    toks: dict[int, list[int]] = {}
    for rid in range(60):
        live = list(pool.seqs)
        if live and rng.random() < 0.4:
            pool.release(rng.choice(live))
        else:
            t = rng.choice(prefixes) + [rng.randrange(100) for _ in range(rng.randrange(1, 9))]
            pool.match_prefix(rid, t, len(t) - 1)
            if pool.ensure(rid, len(t)):
                pool.set_len(rid, len(t))
                pool.commit(rid, t, len(t))
                if rng.random() < 0.5:  # speculative overshoot then rollback
                    if pool.ensure(rid, len(t) + 5):
                        pool.set_len(rid, len(t) + 5)
                        pool.set_len(rid, len(t) + rng.randrange(0, 5))
                toks[rid] = t
            else:
                pool.release(rid)
        pool.check()
        if rid % 5 == 0:
            em.emit("snapshot", pools={"target": pool.snapshot()}, waiting=[], running=[], finished=[])
    em.emit("snapshot", pools={"target": pool.snapshot()}, waiting=[], running=[], finished=[])
    assert any(e["type"] == "block_hit" for e in events)
    assert any(e["type"] == "block_evict" for e in events)
    assert check_events(events) >= 12


# ---------------------------------------------------------------- with real models
def _run(spec_k: int, n_blocks: int, max_new: int = 64, stagger: bool = True):
    from infviz.engine import Engine

    em, events = Emitter(), []
    em.sinks.append(events.append)
    eng = Engine(TARGET, DRAFT if spec_k else None, device=DEV, dtype=torch.float32, spec_k=spec_k,
                 n_blocks=n_blocks, draft_blocks=n_blocks, max_batch=4, emitter=em)
    rids, i = [], 0
    while True:
        while i < len(PROMPTS) and (not stagger or eng.em.step % 3 == 0):  # lanes join mid-flight
            rids.append(eng.add_request(PROMPTS[i], max_new))
            i += 1
            if stagger:
                break
        if not eng.step() and i >= len(PROMPTS) and eng.inbox.empty():
            break
        eng.check()
    eng.em.emit("snapshot", **eng.snapshot())
    return {r: eng.reqs[r].output for r in rids}, events, eng


@pytest.mark.models
@pytest.mark.parametrize("model", [DRAFT, TARGET])
def test_paged_forward_matches_transformers_teacher_forced(model):
    from transformers import AutoModelForCausalLM

    from infviz.engine import Engine, resolve_model
    from infviz.model import SeqInput

    eng = Engine(model, None, device=DEV, dtype=torch.float32, spec_k=0, n_blocks=32)
    rid = eng.add_request(PROMPTS[0], 24)
    eng.run_until_idle()
    full = eng.reqs[rid].all
    mine = eng.target.forward([SeqInput(full, 0, list(range(len(full))), all_logits=True)],
                              eng.target.new_cache(8, 16))[0].cpu()
    del eng  # free our copy before loading the HF one (two fp32 1.5B models won't fit in 16 GB)
    gc.collect()
    if DEV == "mps":
        torch.mps.empty_cache()
    hf = AutoModelForCausalLM.from_pretrained(str(resolve_model(model)), dtype=torch.float32).to(DEV)
    with torch.no_grad():
        ref = hf(torch.tensor([full], device=DEV)).logits[0].float().cpu()
    del hf
    gc.collect()
    assert (ref - mine).abs().max() < 1e-2
    assert torch.equal(ref.argmax(-1), mine.argmax(-1))


@pytest.fixture(scope="module")
def baseline():
    return _run(0, 64)[0]


@pytest.mark.models
def test_speculative_is_lossless_batched(baseline):
    out, events, _ = _run(4, 64)
    assert out == baseline
    assert any(e["type"] == "verify" and e["n_accepted"] < 4 for e in events)  # rejections happened
    check_events(events)


@pytest.mark.models
def test_speculative_lossless_under_kv_pressure(baseline):
    # all requests at once into a 12-block pool: forces LRU eviction AND preemption + recompute
    out, events, _ = _run(4, 12, stagger=False)
    assert out == baseline
    assert any(e["type"] == "block_evict" for e in events)
    assert any(e["type"] == "req_preempt" for e in events)
    assert check_events(events) >= 2
