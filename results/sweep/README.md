# Speculation sweep results

One JSON line per timed run, written by `infviz sweep` (see `engine/src/infviz/sweep.py`). Each row carries the device, dtype, torch version and models, so files from different machines share one schema. `scripts/readme_figures.py breakeven` turns every `*.jsonl` here into `assets/breakeven.svg`.

**Workload.** 16 chat requests (the load generator's prompts, seed 0), all arriving at once; batch sizes 1 and 6; k ∈ {0, 1, 2, 3, 4, 6, 8}; KV pools of 320 blocks, so nothing is evicted or preempted (every row records 0 of each); no snapshots during timed runs. Every (batch, k) pair is warmed up once on a short workload and the warm-up is discarded. Repeats are interleaved: repeat outer, batch, then k.

**Columns.** `wall_s` is the whole run, device-synchronised. `draft_s` and `target_s` time the draft and verify phases with a sync on each side; `target_s` includes committing tokens (detokenising, block bookkeeping). `tok_per_pass` is the UI's number, 1 + accepted / rounds. `match_k0` counts requests whose output equals the k = 0 run of the same repeat.

**Speed-up.** Each k's tokens per second is divided by the k = 0 run of the same repeat and batch size, then the median over repeats is taken.

## `mps-m2pro-bf16.jsonl`

Apple M2 Pro, 16 GB, MPS, bf16, torch 2.15.0, Qwen2.5-1.5B-Instruct ← Qwen2.5-0.5B-Instruct, 2026-11-16.

Run conditions, stated because they affect the spread: an idle `infviz serve` process was holding a second copy of the weights in memory, and during part of the run other work (headless Chrome renders, unit tests) ran on the same machine. Repeat 0 was 5–10% slower than repeats 1 and 2 across the board, for every k, so the paired speed-ups move less than the raw tokens per second. The batch-1 result at k = 2 (0.96–1.02×) is within that noise; batch 6 is slower at every k by far more than the spread.
