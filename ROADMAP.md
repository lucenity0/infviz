# Roadmap

What comes next for infviz, in the order it will be done. Each item says why it matters and what "done" means.

## A · A measured finding

§4 used to rest on one fp32 anecdote ("66 steps → 37, but 4.3 s → 7.2 s"). It now cites measured sweeps on an M2 Pro and an NVIDIA L4, with a 1.5B and a 7B target.

1. ✓ **Speculation sweep on Apple silicon.** k ∈ {0, 1, 2, 3, 4, 6, 8}, bf16, the 16-request workload, batch sizes 1 and 6, 3 interleaved repeats after warm-up. Record wall-clock, steps, tokens per target pass, acceptance and whether the output matches plain greedy decoding. *Done:* `infviz sweep` exists and its results are committed under `results/sweep/`.
2. ✓ **The same sweep on a GPU.** *(Done on an L4 via the Colab CLI; the notebook itself has still not been run end to end.)* The Colab notebook runs `infviz sweep` on a T4 or L4 and downloads one results file. *Done:* a GPU results file is committed next to the MPS one.
3. ✓ **Break-even figure and a new §4.** A chart generated from the committed results: wall-clock speed-up against k, per device and batch size, with the 1.0 line marked. *Done:* §4 cites the figure, not the anecdote.
4. ✓ **Prior-art check** on trace-driven KV-cache and speculation visualizers, before any "no one does this" claim. *Done:* the README names what exists and what infviz adds.

## B · Debugger upgrades

5. ✓ **Click to inspect a request.** A drawer with the full prompt and response, each token marked by where it came from (accepted from the draft, or the target's own). Derived from `verify` events, no engine change.
6. ✓ **Plain-language explanations.** A live event feed ("step 59: r15 preempted, KV pool full, will recompute") and a hover definition for every term on screen.
7. ✓ **A/B compare, poster mode and GIF export.** Two traces on one wall-clock axis (steps are not comparable across runs) with a B-against-A table; `?poster=1`; `npm run capture` writes a PNG or GIF headlessly.
8. ✓ **Presets and live settings.** One-click scenarios, plus pool size, k, batch and speculation controls that restart the engine from the browser. Reuses the engine-control layer from item 1.

## C · Sharing

9. **Hosted replay and a GIF in the first screen of the README.** The static build replays the bundled trace with no server (and carries no licensed font). Published only with the owner's go-ahead.
10. **A visual key for §2,** replacing the prose legend table with a small labelled image.

## D · Known gaps

11. ✓ **Late join loses prompt text.** Add request metadata to engine snapshots (a protocol addition in `docs/EVENTS.md`).
12. **Light theme.** Its colours are placeholders; validate them like the dark set.
13. **Sampling.** Temperature sampling with the standard speculative acceptance rule; acceptance will differ from greedy.
14. **Never run yet:** the Colab notebook end to end (its sweep ran through the Colab CLI instead) and the Llama / SmolLM2 model path. *(The animated SVGs are confirmed playing on GitHub; the 7B target has run, outside the parity tests.)*

## Deferred

- **A compiled decode path (CUDA graphs).** The sweeps show this engine is host-bound, and a compiled path would likely move the draft/target cost ratio. It is deferred: it would measure a different engine rather than explain this one, the ragged forward pass changes shape every step (static shapes are probably a prerequisite), it would rewrite parity-tested code, and it has no MPS equivalent. Moving the ratio with a larger target model tests the same question without changing the engine.

## How they connect

- Items 1, 7 and 8 share one engine-control layer (build an engine with new settings, reuse loaded weights), built once in item 1.
- Item 5 is frontend only and can land at any time.
- Item 9's GIF comes from item 7's exporter, so 7 comes first.
- Items 11 to 13 are picked up when a task touches that code.
