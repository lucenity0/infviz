"""Workload generator: staggered arrivals, mixed lengths, shared system prompts (prefix hits)."""
from __future__ import annotations

import random
import threading
import time

SYSTEMS = [
    # Long-ish shared system prompts so several full KV blocks are shared between requests.
    "You are a concise senior systems engineer. You explain low-level performance topics "
    "(GPUs, memory hierarchies, caches, schedulers) precisely, with concrete numbers where "
    "possible, and you never pad answers with filler. Prefer short paragraphs and plain words.",
    "You are a friendly tutor for curious students. Answer clearly and warmly, use one simple "
    "analogy when it helps, and keep every answer short enough to read in under a minute. "
    "If a question is ambiguous, pick the most likely meaning and say so briefly.",
    "You are a helpful assistant.",
]

PROMPTS = [
    ("Explain what a KV cache is in two sentences.", 64),
    ("Write a haiku about GPUs.", 40),
    ("List three prime numbers and add them.", 48),
    ("What is the capital of France? Answer in one word.", 12),
    ("Count from one to twenty in words, separated by commas.", 96),
    ("Describe speculative decoding to a five year old.", 120),
    ("Why does batching improve GPU throughput?", 110),
    ("Give me a two-line poem about memory fragmentation.", 48),
    ("What is paged attention? Keep it brief.", 90),
    ("Write the numbers 1 to 30 as digits separated by spaces.", 100),
    ("Name four planets and one fact about each.", 140),
    ("Translate 'the cache is full' into French, Spanish and German.", 60),
    ("What does continuous batching mean in LLM serving?", 120),
    ("Summarize the plot of Romeo and Juliet in three sentences.", 110),
    ("Explain the difference between latency and throughput.", 100),
    ("Write a limerick about a block allocator.", 70),
]


def make_workload(n: int, seed: int = 0):
    rng = random.Random(seed)
    out = []
    for i in range(n):
        p, max_new = PROMPTS[i % len(PROMPTS)] if i < len(PROMPTS) else rng.choice(PROMPTS)
        system = SYSTEMS[rng.choices([0, 1, 2], weights=[5, 4, 1])[0]]
        out.append((p, max_new, system))
    return out


def arrival_steps(n: int, mean_gap: float, seed: int = 0) -> list[int]:
    """Poisson arrivals measured in engine steps (deterministic for recording).
    ``mean_gap <= 0`` means every request arrives at step 0 (a closed workload)."""
    if mean_gap <= 0:
        return [0] * n
    rng = random.Random(seed + 1)
    t, steps = 0.0, []
    for _ in range(n):
        steps.append(int(t))
        t += rng.expovariate(1.0 / mean_gap)
    return steps


def start_live(engine, n: int, rate: float, seed: int | None = None) -> threading.Thread:
    """Background thread submitting ``n`` requests with Poisson arrivals at ``rate`` req/s."""
    seed = seed if seed is not None else int(time.time())
    work = make_workload(n, seed)
    rng = random.Random(seed)

    def run():
        for p, max_new, system in work:
            engine.add_request(p, max_new, system=system)
            engine.wake()
            time.sleep(rng.expovariate(rate))

    th = threading.Thread(target=run, daemon=True)
    th.start()
    return th
