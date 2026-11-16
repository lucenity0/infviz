"""infviz CLI: serve (live), record (trace file), check (honesty check on a trace)."""
from __future__ import annotations

import argparse
import time

import torch

DTYPES = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}


def engine_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--target", default="Qwen/Qwen2.5-1.5B-Instruct")
    p.add_argument("--draft", default="Qwen/Qwen2.5-0.5B-Instruct", help="'none' disables speculation")
    p.add_argument("--device", default=None)
    p.add_argument("--dtype", default="bf16", choices=DTYPES)
    p.add_argument("--block-size", type=int, default=16)
    p.add_argument("--blocks", type=int, default=56, help="target KV pool size (blocks)")
    p.add_argument("--draft-blocks", type=int, default=None)
    p.add_argument("--max-batch", type=int, default=6)
    p.add_argument("--spec-k", type=int, default=4)
    p.add_argument("--snapshot-every", type=int, default=8)


def build_engine(a, emitter=None, store=None):
    from .engine import Engine

    return Engine(
        a.target,
        None if a.draft == "none" else a.draft,
        device=a.device,
        dtype=DTYPES[a.dtype],
        block_size=a.block_size,
        n_blocks=a.blocks,
        draft_blocks=a.draft_blocks,
        max_batch=a.max_batch,
        spec_k=0 if a.draft == "none" else a.spec_k,
        snapshot_every=a.snapshot_every,
        emitter=emitter,
        store=store,
    )


def cmd_serve(a) -> None:
    import uvicorn

    from .engine import Engine, ModelStore
    from .server import EngineHost, create_app

    store = ModelStore()
    draft = None if a.draft == "none" else a.draft

    def factory(st: dict, em):
        spec = st["speculation"] and draft is not None
        return Engine(
            a.target, draft if spec else None, device=a.device, dtype=DTYPES[a.dtype],
            block_size=a.block_size, n_blocks=st["blocks"], draft_blocks=a.draft_blocks,
            max_batch=st["max_batch"], spec_k=st["spec_k"] if spec else 0,
            snapshot_every=a.snapshot_every, emitter=em, store=store,
        )

    settings = {"blocks": a.blocks, "max_batch": a.max_batch,
                "speculation": draft is not None, "spec_k": a.spec_k if draft else 0}
    host = EngineHost(factory, settings, draft_available=draft is not None, step_delay=a.step_delay)
    print(f"infviz: engine ready on {host.engine.device}; ws://{a.host}:{a.port}/ws")
    uvicorn.run(create_app(host), host=a.host, port=a.port, log_level="warning")


def cmd_record(a) -> None:
    from . import loadgen
    from .events import Emitter, JsonlSink
    from .replay import main as check

    from .engine import ModelStore

    store = ModelStore()
    work = loadgen.make_workload(a.n, a.seed)
    if a.warmup:
        # a short discarded run first, so kernel compilation and caches don't land in the trace
        warm = build_engine(a, None, store)
        for p, max_new, system in work[: min(6, a.n)]:
            warm.add_request(p, min(max_new, 16), system=system)
        while warm.step():
            pass
        del warm
    em = Emitter()
    sink = JsonlSink(a.out)
    em.sinks.append(sink)
    eng = build_engine(a, em, store)
    arrivals = loadgen.arrival_steps(a.n, a.mean_gap, a.seed)
    t0, i = time.time(), 0
    while True:
        while i < len(work) and arrivals[i] <= eng.em.step:
            p, max_new, system = work[i]
            eng.add_request(p, max_new, system=system)
            i += 1
        progressed = eng.step()
        if not progressed and i >= len(work):
            break
        if not progressed:  # idle gap before the next arrival: advance the clock
            eng.em.step += 1
        if eng.em.step % 20 == 0:
            print(f"  step {eng.em.step}  running={len(eng.running)} waiting={len(eng.waiting)} "
                  f"done={len(eng.finished)}/{a.n}", flush=True)
    eng.em.emit("snapshot", **eng.snapshot())
    sink.close()
    print(f"recorded {eng.em.step} steps in {time.time() - t0:.1f}s -> {a.out}")
    check(a.out)


def cmd_sweep(a) -> None:
    from .sweep import main as sweep

    sweep(a)


def cmd_check(a) -> None:
    from .replay import main as check

    check(a.trace)


def main() -> None:
    ap = argparse.ArgumentParser(prog="infviz")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("serve", help="run the live engine + websocket server")
    engine_args(s)
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8000)
    s.add_argument("--step-delay", type=float, default=0.15, help="seconds between steps (watchability)")
    s.set_defaults(fn=cmd_serve)

    r = sub.add_parser("record", help="run a workload headless and write a JSONL trace")
    engine_args(r)
    r.add_argument("--out", default="../traces/demo.jsonl")
    r.add_argument("-n", type=int, default=16, help="number of requests")
    r.add_argument("--mean-gap", type=float, default=4.0, help="mean steps between arrivals (0: all at once)")
    r.add_argument("--seed", type=int, default=0)
    r.add_argument("--no-warmup", dest="warmup", action="store_false",
                   help="skip the discarded warm-up run before recording")
    r.set_defaults(fn=cmd_record)

    w = sub.add_parser("sweep", help="time speculative decoding against k and batch size")
    w.add_argument("--target", default="Qwen/Qwen2.5-1.5B-Instruct")
    w.add_argument("--draft", default="Qwen/Qwen2.5-0.5B-Instruct")
    w.add_argument("--device", default=None)
    w.add_argument("--dtype", default="bf16", choices=DTYPES)
    w.add_argument("--block-size", type=int, default=16)
    w.add_argument("--blocks", type=int, default=320, help="per pool; large so nothing is evicted")
    w.add_argument("--ks", default="0,1,2,3,4,6,8", help="comma list, must start with 0")
    w.add_argument("--batches", default="1,6", help="max batch sizes, comma list")
    w.add_argument("--repeats", type=int, default=3)
    w.add_argument("-n", type=int, default=16, help="number of requests")
    w.add_argument("--seed", type=int, default=0)
    w.add_argument("--out", default="../results/sweep/sweep.jsonl")
    w.set_defaults(fn=cmd_sweep)

    c = sub.add_parser("check", help="verify a trace's snapshots are reproducible from its events")
    c.add_argument("trace")
    c.set_defaults(fn=cmd_check)

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
