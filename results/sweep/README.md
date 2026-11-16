# Speculation sweep results

One JSON line per timed run, written by `infviz sweep` (see `engine/src/infviz/sweep.py`). Each row carries the device, dtype, torch version and models, so files from different machines share one schema. `scripts/readme_figures.py breakeven` turns every `*.jsonl` here into `assets/breakeven.svg`.

**Workload.** 16 chat requests (the load generator's prompts, seed 0), all arriving at once; batch sizes 1 and 6; k ∈ {0, 1, 2, 3, 4, 6, 8}; KV pools of 320 blocks, so nothing is evicted or preempted (every row records 0 of each); no snapshots during timed runs. Every (batch, k) pair is warmed up once on a short workload and the warm-up is discarded. Repeats are interleaved: repeat outer, batch, then k.

**Columns.** `wall_s` is the whole run, device-synchronised. `draft_s` and `target_s` time the draft and verify phases with a sync on each side; `target_s` includes committing tokens (detokenising, block bookkeeping). `tok_per_pass` is the UI's number, 1 + accepted / rounds. `match_k0` counts requests whose output equals the k = 0 run of the same repeat.

**Speed-up.** Each k's tokens per second is divided by the k = 0 run of the same repeat and batch size, then the median over repeats is taken.

## `mps-m2pro-bf16.jsonl`

Apple M2 Pro, 16 GB, MPS, bf16, torch 2.15.0, Qwen2.5-1.5B-Instruct ← Qwen2.5-0.5B-Instruct, 2026-11-16.

Run conditions, stated because they affect the spread: an idle `infviz serve` process was holding a second copy of the weights in memory, and during part of the run other work (headless Chrome renders, unit tests) ran on the same machine. Repeat 0 was 5–10% slower than repeats 1 and 2 across the board, for every k, so the paired speed-ups move less than the raw tokens per second. The batch-1 result at k = 2 (0.96–1.02×) is within that noise; batch 6 is slower at every k by far more than the spread.

## `cuda-nvidia-l4-bf16.jsonl`

NVIDIA L4 (24 GB, compute capability 8.9) on a Google Colab VM with a 12-vCPU Intel Xeon @ 2.20 GHz, CUDA, bf16, torch 2.14.1+cu130, Python 3.13, same models and workload, 2026-11-16. Run with the Colab CLI (`colab new --gpu L4`, then `infviz sweep` on the VM); nothing else ran on the VM during the timed repeats. Repeats agree to within about 1%.

Two extra measurements on the same VM, single runs, kept here because §4 relies on them:

- **Per-pass cost tracks layer count.** `infviz sweep --target Qwen/Qwen2.5-0.5B-Instruct --ks 0` ran plain decoding of the draft model alone at 37.5 tok/s (batch 1) and 167.3 tok/s (batch 6). The 1.5B target ran at 31.8 and 141.6, so one 0.5B pass costs about 0.85 of a 1.5B pass. Their layer counts are 24 and 28 (ratio 0.86); their sizes differ by about 3×.
- **The GPU waits on the host.** Sampling `nvidia-smi --query-gpu=utilization.gpu` every 200 ms during a 16-request plain-decoding run at batch 1 gave a median of 49% over the busy samples: about half the time no kernel was running. (That counter is coarse: it reports whether any kernel was active, not how much of the GPU it used.)

## `cuda-nvidia-l4-bf16-7b.jsonl`: prediction, written before the run

The 1.5B sweeps suggest a simple cost model: speed-up ≈ tok/pass × decode step ÷ (k × draft pass + verify step), where the steps and passes are wall-clock per engine step. On the L4 a 0.5B draft pass costs 0.84 of a 1.5B target pass, and the model says that ratio must fall to about 0.5–0.6 before k = 2–4 can break even. A 7B target (same 28 layers, about 15 GB of weights to stream per pass) should raise the target's cost without changing the draft's.

A smoke run on 2026-11-16 (3 requests, one repeat, same L4 VM type) measured: plain decode step 60.7 ms (batch 1) and 62.2 ms (batch 6); draft pass 26.3–26.9 ms; verify step 63.6–65.1 ms. The draft/target ratio fell to about 0.43. Its tok/pass was 2.05 at k = 2 and 2.31 at k = 4, lower than with the 1.5B target.

Predictions for the full sweep (16 requests, k 0–8, batch 1 and 6, three repeats), committed before it runs:

1. k = 1 or k = 2 is the best setting at both batch sizes, at about 1.05–1.15×, and these are the only settings above 1.0×.
2. k = 4 lands near 0.83× and k ≥ 6 below that.
3. With the full run's own tok/pass and per-pass costs plugged in, the cost model is within ±10% of every measured speed-up.
