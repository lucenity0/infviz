<p align="center">
  <img src="assets/hero.svg" alt="infviz replaying a recorded engine trace: the target KV cache filling block by block in request colours, a step counter, each running lane's latest speculation round with accepted and rejected draft tokens, and the request lanes under one playhead." width="100%">
</p>

An LLM inference server spends most of its life on bookkeeping you never see. It hands out memory in blocks, shares the prompt prefixes that requests have in common, squeezes new requests into a batch that is already running, and lets a small model guess tokens that a big model then accepts or throws away. **Production servers mostly report this as aggregates**: a counter for accepted drafts, a percentage for cache use. (vLLM can also export raw KV-block events, keyed by content hash rather than by request.) You rarely get to watch a single block or a single rejected token.

infviz is a small, honest inference engine that **emits every one of those decisions as an event**, plus a debugger that rebuilds the engine's state from those events and lets you scrub through it step by step, live or from a recorded trace.

> **The short version.** On Qwen2.5-1.5B with a 0.5B draft model, the engine runs paged attention, prefix caching, continuous batching and speculative decoding. In fp32 its output is verified token for token against Hugging Face transformers and against plain greedy decoding. Every number on screen is rebuilt from events, and a test checks that rebuild against the engine's own snapshots. It is a tool for seeing and explaining serving, not a production profiler.

**[The idea](#1--the-idea)** · **[What you see](#2--what-you-see)** · **[A real run](#3--a-real-run)** · **[Limits](#4--where-it-does-not-help)** · **[Run it](#5--run-it)** · **[Repository map](#7--repository-map)**

---

### §1 · The idea

<p align="center">
  <img src="assets/architecture.svg" alt="Architecture, animated through one engine step: requests in, schedule, draft, verify and commit over the block pools and the paged KV cache; every state change goes through the emitter to a WebSocket or a trace file; in the browser a source, player, timeline, reducer and panels rebuild it. Each box names its source file." width="100%">
</p>

- **Why a new engine.** llama.cpp's server exposes `/metrics` counters and slot status, with no per-block KV occupancy, no eviction events and no per-token accept or reject. Drawing those would mean inventing them, so infviz runs its own engine on real weights instead.
- **Paged KV cache.** Each model's KV cache is a fixed pool of 16-token blocks. Requests address it through a block table, full blocks are hashed so later requests can reuse a shared prefix, finished blocks stay cached until the least recently used one is evicted, and under memory pressure the newest request is preempted and recomputed.
- **Continuous batching.** Every engine step admits waiting requests, prefills new ones and decodes running ones in a single ragged forward pass, so requests join and leave mid-flight.
- **Speculative decoding.** The draft model proposes k = 4 tokens per lane, and the target verifies all of them in one pass. The engine keeps the accepted prefix plus one token of the target's own, and rolls back the rest of the KV cache in both pools.
- **One event stream.** Every state change is an event ([`docs/EVENTS.md`](docs/EVENTS.md)), sent over a WebSocket or written to a `.jsonl` trace. The web app's reducer is a pure function of those events. Every animation is a function of the playhead position, so scrubbing backwards plays it backwards.

**Related tools.** Several projects show parts of this picture. [vllm-internals-viz](https://github.com/richajoy/vllm-internals-viz) replays vLLM's own scheduler and block pool in the browser, checked against real vLLM traces, with a scripted model instead of attention. [vllm-internals](https://github.com/marcotrinelli/vllm-internals) and [kvstat](https://github.com/samuelkim7/kvstat) record a real vLLM server, rebuilding block placement from its API and metrics or reading its KV-event stream. [SpeculatoViz](https://github.com/samy19980109/Visualize-Speculative-Decoding) and LM Studio colour tokens by draft acceptance, without the cache or the batch, and teaching simulators such as [paged-attention-visualizer](https://github.com/amanichopra/paged-attention-visualizer) animate paged attention with no model. infviz's angle is the combination: real weights, with per-request KV ownership, batching, and per-token acceptance with KV rollback in one event stream that a test checks against the engine's own snapshots.

---

### §2 · What you see

<p align="center">
  <img src="assets/ui-dark.png" alt="The infviz debugger mid-step: KV cache pools with shared-prefix blocks and rolled-back cells, speculation lanes with accepted and rejected drafts, and the timeline with one playhead." width="100%">
</p>

| Panel | What it shows | How to read it |
|---|---|---|
| **KV cache** | Both block pools at the playhead | colour = owned by that request · stacked grey = prompt prefix shared by several requests · dark grey = cached for reuse · empty = free · red hatching = speculative KV discarded · dissolving = evicted |
| **Speculative decoding** | The headline number and each running lane's latest round | **tok/pass** = tokens committed per target forward pass (plain decoding is 1.00; not a speed-up, see §4) · dashed = draft guess · solid = accepted · hatched red = first rejection · outlined = the target's own token |
| **Timeline** | The whole run on one step axis, one playhead | step time · KV occupancy · accepted vs rejected drafts per step · a lane per request: dotted = waiting, block = prefill, ticks = tokens committed, × = preempted |
| **Events** | The engine's last steps in plain language, newest first; the current step also runs along the transport bar | "r15 was preempted: the KV pool ran out of free blocks…" · click a step to jump to it · hover any label for a definition |
| **Inspector** | One request, opened by clicking it in the timeline, a speculation lane or a KV block | its prompt and response, each token marked as drafted and accepted or the target's own, rejected guesses on demand, prefix reuse, acceptance and KV rolled back · its blocks stay bright in the KV grid · Esc closes |
| **Transport** | Playback, and in live mode the engine controls | space plays, ←/→ steps, L follows live · start a load burst, slow the engine, send your own prompt |

Colour carries data and nothing else. The seven request hues are validated for colour-blind separation and contrast, **red has exactly one meaning (work that was thrown away)**, and accepted versus rejected is solid versus hatched, so it survives a grayscale screenshot.

---

### §3 · A real run

The bundled trace ([`web/public/demo.jsonl`](web/public/demo.jsonl)) is one recorded run on an M2 Pro (MPS, bf16): 16 requests arriving at random, a deliberately small 40-block pool, at most 6 requests in the batch, and k = 4.

| What happened | Count |
|---|---|
| Engine steps · tokens committed | 83 · 828 |
| Draft tokens accepted | 548 of 1,148 (47.7%) |
| Tokens committed per target verify pass | **2.91** |
| Speculation rounds by tokens accepted, 0 / 1 / 2 / 3 / 4 | 82 / 66 / 26 / 22 / 91 |
| Prefix-cache hits (target pool) | 42 blocks |
| LRU evictions · preemptions · KV rollbacks | 39 · 1 · 370 |
| Median step time | 188 ms |

The acceptance histogram has two peaks, at **0 and at all 4**. The draft model is either right about the whole continuation, as in counting, lists and formatting, or wrong from the first token. Averages hide that shape, and the speculation panel shows it one round at a time.

---

### §4 · Where it does not help

<p align="center">
  <img src="assets/breakeven.svg" alt="Wall-clock speed-up of speculative decoding over plain decoding on an M2 Pro in bf16, for k from 0 to 8 at batch sizes 1 and 6. At batch 1 the best point, k 2, sits at break-even (0.97 times); at batch 6 every k is slower, down to 0.47 times at k 8. Below, milliseconds per committed token split into verify and draft passes: draft time grows with k faster than verify time falls." width="100%">
</p>

- **Fewer passes is not less time, on this machine.** On an M2 Pro (bf16), speculation did not pay. At batch 1 the best setting, k = 2, was indistinguishable from break-even (0.97×, 0.96–1.02× over three repeats); every other k was slower. At batch 6 every k was clearly slower, down to 0.47× at k = 8, even though k = 4 commits 2.9 tokens per verify pass. Two measured costs line up with this. A 0.5B draft pass took about half as long as a 1.5B target pass (16–20 ms against 33.5 ms at batch 1), not the third its size suggests; passes this small are probably dominated by kernel launches and Python-side work rather than by reading weights. And at batch 6, one engine step that verifies k + 1 tokens per lane took 94 ms at k = 4, against 46 ms for a plain decode step (both include this engine's Python bookkeeping). This is why the headline number is labelled tok/pass, not speed-up. The sweep is `infviz sweep`, and the raw rows and run conditions are in [`results/sweep/`](results/sweep); a GPU run through the Colab notebook is next.
- **It debugs this engine, not yours.** infviz reads its own event protocol. It will not attach to vLLM or llama.cpp, and it will not profile a production server.
- **Small models, greedy only.** Qwen2.5 0.5B → 1.5B, with no temperature or sampling yet. Acceptance under sampling will differ.
- **"Lossless" is proven in fp32.** In fp32, speculative output is identical to plain greedy decoding (tests below). In bf16, the default, they diverge: in the sweep, 4 to 8 of the 16 responses differed from plain greedy decoding somewhere, with the same count on every repeat. The likely cause is that a pass over k + 1 tokens rounds differently from one-token decoding, which flips near-ties.
- **Joining late loses prompts.** A browser that connects mid-run gets the cache state from a snapshot, but not the prompt text of requests that were already running.

---

### §5 · Run it

```bash
cd engine && uv sync --extra test        # torch, safetensors, tokenizers, fastapi; Python 3.11+
uv run infviz serve                      # live engine + WebSocket on :8000 (first run downloads ~4 GB of Qwen2.5)

cd web && npm install && npm run dev     # http://localhost:5173
```

Click **Start load** in the transport bar, or type a prompt and **Send**. Without an engine, the page replays the bundled trace, and `npm run build` produces a static site that does the same with no server.

```bash
uv run infviz record --out ../traces/run.jsonl -n 24 --blocks 40     # record a run headless
uv run infviz check ../traces/run.jsonl                              # honesty check on any trace
uv run infviz sweep --out ../results/sweep/mine.jsonl                # time speculation against k (about 25 min)
```

Drop any `.jsonl` onto the page, or open `?trace=<url>`. Deep links take `?step=45` or a fractional `?pos=30.6`, plus `&play=1` and `&speed=4`. Knobs that make things visible: `--blocks` (smaller means more eviction and preemption), `--max-batch`, `--spec-k`, `--draft none`, `--step-delay`.

**On a GPU.** [`notebooks/record_on_colab.ipynb`](notebooks/record_on_colab.ipynb) runs the speculation sweep on a Colab GPU, and can record a heavier run (optionally with a 7B target) for local replay.

---

### §6 · Verify it

```bash
cd engine && uv run pytest -q            # needs the model weights
cd web && npx vitest run && TRACE=public/demo.jsonl npx vitest run
```

- **Model parity.** The paged forward pass matches Hugging Face transformers on both models (logits within 1e-4, identical argmax at every position).
- **Speculation is lossless.** In fp32, speculative output equals plain greedy output token for token, batched with staggered arrivals and again under a 12-block pool that forces eviction **and** preemption with recompute.
- **The allocator keeps its books.** Random allocate, share, roll back and release sequences hold every invariant: no double ownership, free + used + cached = total, and the hash index stays consistent.
- **The picture is the engine.** A Python reducer and the TypeScript reducer must each reproduce every engine snapshot exactly. CI runs this check and the web build on every push.

---

### §7 · Repository map

| Path | What it holds |
|---|---|
| [`engine/`](engine) | The Python package `infviz`: model (`model.py`), block allocator (`kv.py`), scheduler and speculation (`engine.py`), live server, load generator, CLI, reference reducer (`replay.py`), tests |
| [`web/`](web) | The debugger: Vite + TypeScript, Canvas 2D, no framework. `src/tokens.ts` holds every colour, size and motion value |
| [`docs/EVENTS.md`](docs/EVENTS.md) | The event protocol both halves agree on |
| [`notebooks/`](notebooks) | The speculation sweep and trace recording on a Colab GPU |
| [`results/sweep/`](results/sweep) | Raw sweep rows, one JSON line per run, with device, dtype and torch version |
| [`scripts/readme_figures.py`](scripts/readme_figures.py) | Regenerates the hero (a replay of the demo trace), the architecture diagram and the break-even chart (from `results/sweep/`) |
| [`assets/`](assets) | `hero.svg`, `architecture.svg` (animated), `breakeven.svg` and the UI screenshot |
| [`traces/`](traces) | Your recordings (git-ignored) |

---

### §8 · Credits

Built by **S Nafees**. Models: [Qwen2.5-0.5B-Instruct and Qwen2.5-1.5B-Instruct](https://huggingface.co/Qwen) (Apache 2.0). Numbers and tokens are set in Geist Mono and the fallback sans is Inter Tight; both are OFL and installed from npm.

**Font restriction.** The display and label face, **Brutal Milk No 3**, is a commercially licensed Envato font. It is **not in this repository and may not be redistributed**. To see the UI as designed, you need your own licence for it: place the variable font at `web/public/fonts/licensed/brutal-milk-var.woff2`, which git ignores. Without it, every place that uses it **falls back to Inter Tight automatically**, and nothing else changes. `npm run build` strips the folder from `web/dist/` automatically, and CI fails if the font is ever tracked by git or found in a build, so a deployed site never carries it. The README figures embed only the OFL fonts.

**License:** [MIT](LICENSE) for the code. The model weights and the Brutal Milk typeface keep their own licences and are not part of this repository.

---

<sub>**P.S.** The hero is not a video. `scripts/readme_figures.py` replays the bundled trace through the same reducer the tests check and writes every frame as SVG animation. Even the README is rebuilt from events, and with animation off it rests on step 45, the same state the app shows at `?step=45`.</sub>
