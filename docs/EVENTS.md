# infviz event protocol (v1)

The engine emits one **append-only stream of JSON events**. The same stream is
written to `traces/*.jsonl` (one event per line) and broadcast over WebSocket
(one event per text message). The frontend must derive *all* state from it.

Every event has:

| field  | type   | meaning                                   |
|--------|--------|-------------------------------------------|
| `type` | string | event type (below)                        |
| `step` | int    | engine step this happened in (0 before the first step) |
| `t`    | float  | seconds since engine start (wall clock)   |

IDs: requests are `rid: int` (0,1,2… in arrival order). Pools are `"target"` and
`"draft"`. Blocks are `block: int` indices `0..n_blocks-1` within a pool.

## Lifecycle of a block

```
free ──alloc──▶ used(owners=[rid], filled=0..block_size)
used ──(last owner releases, block full & hashed)──▶ cached   (event block_cache)
used ──(last owner releases, otherwise)──────────▶ free     (event block_free)
cached ──(another request reuses the prefix)─────▶ used     (event block_hit)
cached ──(allocator needs space, LRU)────────────▶ free     (event block_evict)
used ──(another request shares it)──▶ used, owners += [rid] (event block_hit)
```

A `used` block can have several owners (shared prefix). Ownership release of a
block that still has other owners emits `block_release {pool, block, rid}` and
the block stays `used`.

## Event types

### Setup
- `config` — first event of a session. A live server that rebuilds its engine (new settings
  from the browser) emits a new `config` on the same stream: it starts a **new session**.
  Reducers start over from an empty state, `step` restarts at 0, `t` restarts near 0, and
  request ids restart at 0. The new `config` is followed directly by that session's
  `snapshot`, and no event of the previous session follows it.
  `{models: {target: str, draft: str|null}, device: str, block_size: int,
    pools: {target: {n_blocks: int}, draft?: {n_blocks: int}},
    max_batch: int, spec_k: int, snapshot_every: int, temperature?: float, seed?: int}`
  `temperature` 0 (or absent, in older traces) means greedy decoding. Above 0 the engine
  samples, and `verify.n_accepted` comes from the speculative accept rule (each draft kept
  with probability min(1, p/q)) instead of exact agreement; the events are otherwise the same.

### Requests
- `req_arrive {rid, prompt_text: str, prompt_len: int, max_new_tokens: int}` — enters waiting queue.
- `req_admit {rid}` — moved from waiting into the running batch.
- `req_preempt {rid, reason: "kv_pressure"}` — kicked out of running back to the
  *front* of waiting; all its blocks are released (block_release/free/cache events
  precede this event). Its generated tokens are kept and will be recomputed as prompt.
- `req_finish {rid, reason: "eos"|"length", output_len: int}` — done; its blocks
  are released (events precede this).

### Steps (continuous batching)
- `step_begin {batch: [{rid, phase: "prefill"|"decode", n_tokens: int}]}` — the
  composition of this forward step. `n_tokens` = tokens the *target* computes for
  that request this step (prefill: uncached prompt tokens; decode with spec:
  k+1 verify positions; decode without spec: 1).
- `step_end {ms: float, n_tokens: int}` — wall time of the step and total tokens computed.

### KV blocks (per pool)
- `block_alloc {pool, block, rid, idx}` — free block taken by `rid` as its logical block `idx`.
- `block_fill {pool, block, filled}` — block now holds `filled` valid tokens (absolute, not delta).
- `block_hit {pool, block, rid, idx}` — `rid` reuses an existing cached-or-used block (prefix cache hit) as logical block `idx`.
- `block_release {pool, block, rid}` — `rid` drops ownership; other owners remain.
- `block_cache {pool, block}` — last owner released a full block; it is kept in the prefix cache (state `cached`, owners `[]`, filled unchanged).
- `block_free {pool, block}` — block returns to free list (state `free`, owners `[]`, filled 0).
- `block_evict {pool, block}` — LRU eviction of a cached block (→ `free`, filled 0).
- `kv_rollback {rid, pool, old_len, new_len}` — informational marker: speculative
  KV beyond `new_len` tokens discarded. Any resulting block changes are reported by
  separate `block_fill` / `block_free` events *after* this marker.

### Speculative decoding
- `draft_propose {rid, tokens: int[], texts: str[]}` — draft model's k proposed tokens.
- `verify {rid, n_accepted: int, target_token: int, target_text: str}` — target
  accepted the first `n_accepted` proposed tokens; `target_token` is the target's
  own token at position `n_accepted` (the correction if `n_accepted < k`, the bonus
  token if all accepted). Committed tokens this round = accepted + target_token.

### Output
- `token {rid, token: int, text: str}` — a committed output token (in order).
  With speculation one round emits `n_accepted + 1` of these (possibly fewer if
  EOS / max_new_tokens hits first).

### Snapshots
- `snapshot` — full state *after* all preceding events. Emitted every
  `snapshot_every` steps (after `step_end`) and as the last event of a trace.
  Optional `reqs: {"<rid>": {prompt_text, prompt_len, max_new_tokens, arrive_step, out}}`
  carries the unfinished requests' metadata (`out` = output text committed so far), so a
  browser that joins a live stream late still knows their prompts and text. It is
  **outside** the honesty invariant: reducers use it only to hydrate a late join, and
  traces recorded before it existed simply lack it.
  ```
  {pools: {target: {blocks: [{state: "free"|"used"|"cached", owners: int[], filled: int}]},
           draft?:  {...same...}},
   waiting: int[], running: int[], finished: int[],
   seqs: {"<rid>": {kv_len: int, n_generated: int}}}
  ```
  `owners` sorted ascending. `waiting` in queue order, `running` in admission order,
  `finished` in finish order. `seqs` includes every non-finished request that has arrived;
  `kv_len` = tokens of that request currently held in the *target* pool.

**Honesty invariant:** a reducer that applies every event from the start must
reproduce each `snapshot` exactly (pools, waiting/running/finished). Tests enforce this.

## Live transport
- `GET ws://<host>:8000/ws` — on connect the server sends the `config` event, then
  the latest `snapshot`, then every subsequent event live.
- `POST /api/requests {prompt: str, max_new_tokens?: int}` → `{rid}`
- `POST /api/load {n: int, rate: float}` — starts the built-in load generator (Poisson arrivals, `rate` req/s).
- `POST /api/speed {step_delay: float}` — seconds of sleep between engine steps (makes live mode watchable).
- `GET /api/config` → `{settings: {blocks, max_batch, speculation, spec_k}, draft_available, limits, floors, step_delay, epoch}`.
  `floors[k]` is the smallest pool (blocks) in which every built-in load-generator request fits at that k.
- `POST /api/config {blocks: int, max_batch: int, speculation: bool, spec_k?: int}` — rebuild the engine
  between two steps with these settings (loaded weights are reused). Replies after the new
  session's `config` has been emitted; 400 with a reason if the settings are out of range or the
  pool is below the floor. Load bursts started before the rebuild stop.
