"""Speculation sweep: wall-clock cost of speculative decoding against k, per batch size.

Every configuration runs the same closed workload: all requests arrive at once, the KV
pools are large enough that nothing is evicted or preempted (checked per run), snapshots
are off, and repeats are interleaved (repeat outer, k inner) so drift spreads evenly.
Each finished run is appended to a JSONL file as one row, so a crash keeps what is done.

    uv run infviz sweep --out ../results/sweep/mps-m2pro-bf16.jsonl
"""
from __future__ import annotations

import json
import platform
import time
from collections import Counter
from pathlib import Path

import torch

from . import loadgen
from .engine import Engine, ModelStore, resolve_model

NEVER = 10**9  # snapshot_every: no snapshots during a timed run


def _sync(device: str) -> None:
    if device == "mps":
        torch.mps.synchronize()
    elif device.startswith("cuda"):
        torch.cuda.synchronize()


def _empty_cache(device: str) -> None:
    if device == "mps":
        torch.mps.empty_cache()
    elif device.startswith("cuda"):
        torch.cuda.empty_cache()


def device_name(device: str) -> str:
    if device.startswith("cuda"):
        return torch.cuda.get_device_name()
    if device == "mps":
        try:
            import subprocess

            return subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"],
                                  capture_output=True, text=True).stdout.strip() or "Apple MPS"
        except OSError:
            return "Apple MPS"
    return platform.processor() or "cpu"


def run_once(a, store: ModelStore, k: int, batch: int, work) -> tuple[dict, list[list[int]]]:
    """Run ``work`` to completion on a fresh engine; return (row, outputs per request)."""
    eng = Engine(
        a.target, a.draft if k > 0 else None, device=a.device, dtype=a.torch_dtype,
        block_size=a.block_size, n_blocks=a.blocks, max_batch=batch, spec_k=k,
        snapshot_every=NEVER, store=store,
    )
    dev = eng.device
    counts: Counter = Counter()
    hist: Counter = Counter()

    def count(ev: dict) -> None:
        counts[ev["type"]] += 1
        if ev["type"] == "verify":
            hist[ev["n_accepted"]] += 1
            counts["accepted"] += ev["n_accepted"]

    eng.em.sinks.append(count)

    phase = {"draft": 0.0, "target": 0.0, "draft_steps": 0}

    def timed(fn, key):
        def wrapper(*args):
            _sync(dev)
            t = time.perf_counter()
            out = fn(*args)
            _sync(dev)
            phase[key] += time.perf_counter() - t
            if key == "draft" and args[0]:
                phase["draft_steps"] += 1  # a step with decode lanes runs k draft passes
            return out
        return wrapper

    eng._draft = timed(eng._draft, "draft")
    eng._target = timed(eng._target, "target")

    rids = [eng.add_request(p, max_new, system=system) for p, max_new, system in work]
    _sync(dev)
    t0 = time.perf_counter()
    steps = 0
    while eng.step():
        steps += 1
    _sync(dev)
    wall = time.perf_counter() - t0

    outputs = [eng.reqs[r].output for r in rids]
    tokens = sum(len(o) for o in outputs)
    rounds = sum(hist.values())
    row = {
        "k": k, "batch": batch,
        "wall_s": round(wall, 4),
        "draft_s": round(phase["draft"], 4),
        "target_s": round(phase["target"], 4),
        "other_s": round(wall - phase["draft"] - phase["target"], 4),
        "steps": steps,
        "draft_passes": phase["draft_steps"] * k,
        "tokens": tokens,
        "tok_per_s": round(tokens / wall, 3),
        # all lanes' tokens per engine step (one batched target pass)
        "tok_per_step": round(tokens / steps, 4),
        # the UI's tok/pass: tokens one lane commits per verify pass = 1 + accepted / rounds
        "tok_per_pass": round(1 + counts["accepted"] / rounds, 4) if rounds else 1.0,
        "rounds": rounds,
        "drafted": rounds * k,
        "accepted": counts["accepted"],
        "acceptance": round(counts["accepted"] / (rounds * k), 4) if rounds and k else None,
        "hist": [hist.get(i, 0) for i in range(k + 1)] if k else [],
        "evictions": counts["block_evict"],
        "preemptions": counts["req_preempt"],
    }
    del eng
    _empty_cache(dev)
    return row, outputs


def main(a) -> None:
    a.torch_dtype = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}[a.dtype]
    ks = [int(x) for x in a.ks.split(",")]
    batches = [int(x) for x in a.batches.split(",")]
    if ks[0] != 0:
        raise SystemExit("--ks must start with 0 (the plain-decoding baseline)")
    store = ModelStore()
    work = loadgen.make_workload(a.n, a.seed)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    probe = Engine(a.target, None, device=a.device, dtype=a.torch_dtype, n_blocks=4, store=store)
    dev = probe.device
    del probe
    meta = {
        "device": dev, "device_name": device_name(dev), "torch": torch.__version__,
        "dtype": a.dtype, "target": a.target, "draft": a.draft, "n_requests": a.n,
        "seed": a.seed, "blocks": a.blocks, "block_size": a.block_size,
        "workload": "closed: all requests arrive at t=0",
    }
    print(f"sweep on {meta['device_name']} ({dev}, {a.dtype}); ks={ks} batches={batches} "
          f"repeats={a.repeats} -> {out}", flush=True)

    # Warm-up: every (batch, k) once on a short workload, discarded.
    warm = [(p, min(m, 16), s) for p, m, s in work[: max(2, min(6, a.n))]]
    for batch in batches:
        for k in ks:
            run_once(a, store, k, batch, warm)
    print("warm-up done", flush=True)

    with out.open("a") as f:
        for rep in range(a.repeats):
            for batch in batches:
                base: list[list[int]] | None = None
                for k in ks:
                    row, outputs = run_once(a, store, k, batch, work)
                    if k == 0:
                        base = outputs
                    same = sum(o == b for o, b in zip(outputs, base)) if base else None
                    row.update(repeat=rep, match_k0=f"{same}/{len(outputs)}", **meta)
                    f.write(json.dumps(row) + "\n")
                    f.flush()
                    print(f"  rep {rep} batch {batch} k {k}: {row['wall_s']:.2f}s "
                          f"{row['tok_per_s']:.1f} tok/s  {row['tok_per_pass']:.2f} tok/pass  "
                          f"draft {row['draft_s']:.2f}s target {row['target_s']:.2f}s  "
                          f"match {row['match_k0']}  evict {row['evictions']} "
                          f"preempt {row['preemptions']}", flush=True)
