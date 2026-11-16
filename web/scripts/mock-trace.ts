// Synthetic, schema-conformant trace generator (writes public/mock.jsonl).
// This is an independent mini inference engine (allocator, prefix cache, LRU, scheduler,
// speculative decoder). It maintains its own state and writes snapshots from that state,
// NOT via src/reducer.ts, so the honesty test is a real cross-check.
//
//   npx tsx scripts/mock-trace.ts [out.jsonl]
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const B = 16; // block_size
const N_TARGET = 48;
const N_DRAFT = 36;
const MAX_BATCH = 6;
const K = 4;
const SNAP_EVERY = 8;

// ---------- deterministic rng ----------
let seed = 20260719;
function rnd(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---------- tiny tokenizer ----------
function tokenize(text: string): string[] {
  const raw = text.match(/\n+|\s?[A-Za-z0-9'_-]+|[^\sA-Za-z0-9'_-]/g) ?? [];
  const out: string[] = [];
  for (const p of raw) {
    const m = /^(\s?)([A-Za-z0-9'_-]{9,})$/.exec(p);
    if (m) {
      const cut = Math.ceil(m[2].length * 0.55);
      out.push(m[1] + m[2].slice(0, cut), m[2].slice(cut));
    } else out.push(p);
  }
  return out;
}
function tokId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return 3 + ((h >>> 0) % 31990);
}
const EOS_ID = 2;
const VOCAB_WRONG = [' the', ' a', ' of', ' and', ',', '.', ' to', ' in', ' is', ' that', ' it', ' for', ' with', ' on'];

// ---------- content ----------
const SYS = [
  'You are Atlas, a precise and friendly assistant for an engineering team. Answer in clear plain English, keep explanations short, prefer concrete examples over theory, and say so when you are unsure.',
  'You are a senior systems tutor. Explain ideas step by step, use small numbers in examples, avoid jargon unless you define it, and always end with one practical takeaway the reader can use today.',
  'You are a concise code-review bot. Point out the single most important issue first, quote the relevant line, propose a minimal fix, and never rewrite code that is already correct.',
];
const QA: { sys: number; q: string; a: string; maxNew: number; p: number }[] = [
  { sys: 0, q: 'What is a KV cache and why does it matter?', a: 'A KV cache stores the key and value vectors that attention computed for earlier tokens, so the model never recomputes them. Each new token only needs one fresh query against the cached keys, which turns a quadratic cost into a linear one per step. The price is memory: the cache grows with every token of every request.', maxNew: 80, p: 0.74 },
  { sys: 0, q: 'Explain continuous batching in two sentences.', a: 'Continuous batching lets the server add and remove requests at every decoding step instead of waiting for a whole batch to finish. The GPU stays busy because a finished sequence immediately frees its slot for a waiting one.', maxNew: 64, p: 0.66 },
  { sys: 1, q: 'Why are paged attention blocks useful?', a: 'Paged blocks split each sequence into fixed size pages that can live anywhere in memory. There is no need to reserve a huge contiguous region up front, so fragmentation almost disappears. Shared prefixes can even point at the very same pages, which saves memory and prefill time.', maxNew: 70, p: 0.7 },
  { sys: 0, q: 'Write a haiku about latency.', a: 'Tokens drip like rain, each step a small heartbeat wait, the cursor blinks on.', maxNew: 40, p: 0.35 },
  { sys: 2, q: 'def mean(xs): return sum(xs) / len(xs)', a: 'The issue is an empty list: len(xs) is zero, so this raises ZeroDivisionError. Minimal fix: return 0.0 if not xs else sum(xs) / len(xs). The rest of the function is fine and should stay as it is.', maxNew: 56, p: 0.88 },
  { sys: 1, q: 'How does speculative decoding speed things up?', a: 'A small draft model guesses several tokens ahead, and the large model checks all of them in a single forward pass. Every guess that matches is accepted for free, and the first miss is replaced by the large model own token. The output is identical, you simply pay for fewer large steps. Takeaway: speedups depend on how often the draft agrees.', maxNew: 96, p: 0.62 },
  { sys: 1, q: 'What happens when the cache runs out of blocks?', a: 'The scheduler first evicts cached blocks that nobody owns, oldest first. If that is not enough it preempts a running request, releases its blocks and puts it back at the front of the queue. Its tokens are kept and recomputed later as part of the prompt.', maxNew: 64, p: 0.58 },
  { sys: 2, q: 'for i in range(len(items)): print(items[i])', a: 'This works but fights the language. Iterate directly: for item in items: print(item). Use enumerate only if you also need the index.', maxNew: 44, p: 0.9 },
  { sys: 0, q: 'Give me three tips for writing a good commit message.', a: 'Start with a short imperative summary under fifty characters. Use the body to explain why the change was needed, not what the diff already shows. Reference the issue or ticket so the history stays searchable months later.', maxNew: 60, p: 0.72 },
  { sys: 1, q: 'Why does prefill cost more than decode per step?', a: 'Prefill processes every prompt token at once, so a single step carries hundreds of positions and is limited by raw compute. Decode carries one token per sequence and is limited by memory bandwidth instead, which is why batching many sequences helps so much.', maxNew: 28, p: 0.64 },
  { sys: 2, q: 'x = [] ; x = x + [1] inside a loop of ten thousand iterations', a: 'Each concatenation copies the whole list, so ten thousand appends cost roughly fifty million element copies. Use x.append(1) and the loop becomes linear.', maxNew: 48, p: 0.84 },
  { sys: 0, q: 'Summarise why prefix caching saves money.', a: 'Many requests start with the same system prompt. When the server keeps the finished blocks for that prefix, a new request reuses them instead of recomputing, so prefill work and time to first token both shrink. Only the unique tail of the prompt is computed.', maxNew: 72, p: 0.69 },
  { sys: 1, q: 'What does acceptance rate tell me?', a: 'It is the fraction of drafted tokens the large model agreed with. A high rate means the draft model predicts well and each verify step yields several tokens. A low rate means most drafts are thrown away and the extra work barely pays off.', maxNew: 66, p: 0.52 },
];
// arrival steps (staggered)
const ARRIVE = [0, 1, 2, 4, 5, 7, 9, 11, 14, 19, 27, 38, 50];

// ---------- engine model ----------
type BState = 'free' | 'used' | 'cached';
interface PBlock { state: BState; owners: number[]; filled: number }
const events: any[] = [];
let stepNo = 0;
let tWall = 0;
function emit(type: string, fields: Record<string, unknown>) {
  events.push({ type, step: stepNo, t: Math.round(tWall * 1e4) / 1e4, ...fields });
}

class Pool {
  blocks: PBlock[] = [];
  hashOf: (number | null)[] = [];
  lru: number[] = []; // cached blocks, oldest first (target only)
  constructor(public name: 'target' | 'draft', public n: number, public caching: boolean) {
    for (let i = 0; i < n; i++) {
      this.blocks.push({ state: 'free', owners: [], filled: 0 });
      this.hashOf.push(null);
    }
  }
  freeCount() { return this.blocks.filter((b) => b.state === 'free').length; }
  availableCount() { return this.freeCount() + this.lru.length; }
  alloc(rid: number, idx: number): number | -1 {
    let b = this.blocks.findIndex((x) => x.state === 'free');
    if (b < 0) {
      if (!this.lru.length) return -1;
      b = this.lru.shift()!; // LRU eviction
      this.unhash(b);
      this.blocks[b] = { state: 'free', owners: [], filled: 0 };
      emit('block_evict', { pool: this.name, block: b });
      evictions++;
    }
    this.blocks[b] = { state: 'used', owners: [rid], filled: 0 };
    emit('block_alloc', { pool: this.name, block: b, rid, idx });
    return b;
  }
  unhash(b: number) {
    const h = this.hashOf[b];
    if (h !== null) { if (table.get(h) === b) table.delete(h); this.hashOf[b] = null; }
  }
  fill(b: number, filled: number) {
    if (this.blocks[b].filled === filled) return;
    this.blocks[b].filled = filled;
    emit('block_fill', { pool: this.name, block: b, filled });
  }
  /** rid drops its ownership of b */
  release(b: number, rid: number) {
    const bl = this.blocks[b];
    const others = bl.owners.filter((o) => o !== rid);
    if (others.length) {
      bl.owners = others;
      emit('block_release', { pool: this.name, block: b, rid });
      return;
    }
    if (this.caching && bl.filled === B && this.hashOf[b] !== null) {
      bl.owners = [];
      bl.state = 'cached';
      this.lru.push(b);
      emit('block_cache', { pool: this.name, block: b });
    } else {
      this.unhash(b);
      this.blocks[b] = { state: 'free', owners: [], filled: 0 };
      emit('block_free', { pool: this.name, block: b });
    }
  }
  hit(b: number, rid: number, idx: number) {
    const bl = this.blocks[b];
    if (bl.state === 'cached') {
      this.lru = this.lru.filter((x) => x !== b);
      bl.state = 'used';
      bl.owners = [rid];
    } else {
      bl.owners = [...bl.owners, rid].sort((x, y) => x - y);
    }
    emit('block_hit', { pool: this.name, block: b, rid, idx });
  }
}
const table = new Map<number, number>(); // content hash -> target block
let evictions = 0;
const T = new Pool('target', N_TARGET, true);
const D = new Pool('draft', N_DRAFT, false);

interface Req {
  rid: number; arriveStep: number; promptText: string; promptIds: number[]; script: string[];
  maxNew: number; p: number;
  seq: number[]; gen: number; kv: number; dkv: number; tb: number[]; db: number[];
  status: 'future' | 'waiting' | 'running' | 'finished';
  needsPrefill: boolean; admitOrder: number;
  out: string; arrivedAt: number;
}
const reqs: Req[] = QA.map((qa, i) => {
  const promptText = SYS[qa.sys] + '\n\nUser: ' + qa.q + '\nAssistant:';
  const ids = tokenize(promptText).map(tokId);
  return {
    rid: i, arriveStep: ARRIVE[i], promptText, promptIds: ids, script: tokenize(' ' + qa.a),
    maxNew: qa.maxNew, p: qa.p, seq: ids.slice(), gen: 0, kv: 0, dkv: 0, tb: [], db: [],
    status: 'future', needsPrefill: true, admitOrder: 0, out: '', arrivedAt: 0,
  };
});
let waiting: Req[] = [];
let running: Req[] = [];
let finished: number[] = [];
let admitCounter = 0;

function chainHashes(r: Req, nFull: number): number[] {
  const out: number[] = [];
  let h = 17;
  for (let i = 0; i < nFull; i++) {
    for (let j = 0; j < B; j++) h = (Math.imul(h ^ r.seq[i * B + j], 16777619) + j) | 0;
    h = (h ^ (h >>> 13)) | 0;
    out.push(h);
  }
  return out;
}
function registerFull(r: Req) {
  const nFull = Math.min(Math.floor(r.kv / B), r.tb.length);
  const hs = chainHashes(r, nFull);
  for (let i = 0; i < nFull; i++) {
    const b = r.tb[i];
    if (T.blocks[b].filled === B && T.hashOf[b] === null && !table.has(hs[i])) {
      table.set(hs[i], b);
      T.hashOf[b] = hs[i];
    }
  }
}
function releaseAll(r: Req) {
  registerFull(r);
  for (const b of r.tb) T.release(b, r.rid);
  for (const b of r.db) D.release(b, r.rid);
  r.tb = []; r.db = []; r.kv = 0; r.dkv = 0;
}
function preempt(r: Req) {
  releaseAll(r);
  running = running.filter((x) => x !== r);
  r.status = 'waiting';
  r.needsPrefill = true;
  waiting.unshift(r);
  emit('req_preempt', { rid: r.rid, reason: 'kv_pressure' });
  preemptions++;
}
let preemptions = 0;

/** grow target/draft capacity to hold `tokens` positions; false if out of blocks */
function ensure(pool: Pool, list: number[], r: Req, tokens: number): boolean {
  const need = Math.ceil(tokens / B);
  while (list.length < need) {
    const b = pool.alloc(r.rid, list.length);
    if (b < 0) return false;
    list.push(b);
  }
  return true;
}
/** make the first `len` positions of this seq present in `pool` (fill events); drop blocks beyond */
function setLen(pool: Pool, list: number[], r: Req, len: number) {
  const nb = Math.ceil(len / B);
  for (let i = 0; i < nb; i++) {
    const want = Math.min(B, len - i * B);
    const b = list[i];
    // shared prefix-hit blocks are full already and not ours to touch
    if (pool.blocks[b].owners.length > 1 && pool.blocks[b].filled >= want) continue;
    pool.fill(b, want);
  }
  while (list.length > nb) pool.release(list.pop()!, r.rid);
}

function hitsFor(r: Req): number[] {
  const nFull = Math.floor(r.seq.length / B);
  const hs = chainHashes(r, nFull);
  const hits: number[] = [];
  for (let i = 0; i < nFull; i++) {
    const b = table.get(hs[i]);
    if (b === undefined) break;
    hits.push(b);
  }
  while (hits.length * B >= r.seq.length) hits.pop(); // always compute >= 1 token
  return hits;
}

function tryAdmit(r: Req): boolean {
  const hits = hitsFor(r);
  const nBlocks = Math.ceil(r.seq.length / B);
  const hitCached = hits.filter((b) => T.blocks[b].state === 'cached').length;
  const availT = T.availableCount() - hitCached;
  const reserve = 0;
  if (availT < nBlocks - hits.length + reserve) return false;
  if (D.freeCount() < nBlocks) return false;
  emit('req_admit', { rid: r.rid });
  waiting = waiting.filter((x) => x !== r);
  r.status = 'running'; r.admitOrder = ++admitCounter;
  running.push(r);
  hits.forEach((b, i) => { T.hit(b, r.rid, i); r.tb.push(b); });
  r.kv = hits.length * B; // tokens already present
  ensure(T, r.tb, r, r.seq.length);
  ensure(D, r.db, r, r.seq.length);
  return true;
}

// ---------- main loop ----------
const hist = new Map<number, number>();
function snapshot() {
  const pool = (p: Pool) => ({ blocks: p.blocks.map((b) => ({ state: b.state, owners: b.owners.slice().sort((a, c) => a - c), filled: b.filled })) });
  const seqs: Record<string, { kv_len: number; n_generated: number }> = {};
  const meta: Record<string, { prompt_text: string; prompt_len: number; max_new_tokens: number; arrive_step: number; out: string }> = {};
  for (const r of reqs)
    if (r.status === 'waiting' || r.status === 'running') {
      seqs[String(r.rid)] = { kv_len: r.kv, n_generated: r.gen };
      meta[String(r.rid)] = { prompt_text: r.promptText, prompt_len: r.promptIds.length, max_new_tokens: r.maxNew, arrive_step: r.arrivedAt, out: r.out };
    }
  emit('snapshot', {
    pools: { target: pool(T), draft: pool(D) },
    waiting: waiting.map((r) => r.rid),
    running: running.map((r) => r.rid),
    finished: finished.slice(),
    seqs,
    reqs: meta,
  });
}

emit('config', {
  models: { target: 'mock', draft: 'mock-draft' }, device: 'synthetic', block_size: B,
  pools: { target: { n_blocks: N_TARGET }, draft: { n_blocks: N_DRAFT } },
  max_batch: MAX_BATCH, spec_k: K, snapshot_every: SNAP_EVERY,
});

function commitToken(r: Req, text: string) {
  r.seq.push(tokId(text));
  r.gen++;
  r.out += text;
  emit('token', { rid: r.rid, token: tokId(text), text });
}
function finish(r: Req, reason: 'eos' | 'length') {
  releaseAll(r);
  running = running.filter((x) => x !== r);
  r.status = 'finished';
  finished.push(r.rid);
  emit('req_finish', { rid: r.rid, reason, output_len: r.gen });
}

let guard = 0;
while (reqs.some((r) => r.status !== 'finished') && guard++ < 5000) {
  stepNo++;
  tWall += 0.002;
  // idle fast-forward to next arrival
  if (!running.length && !waiting.length) {
    const next = reqs.find((r) => r.status === 'future');
    if (next && next.arriveStep > stepNo) stepNo = next.arriveStep;
  }
  for (const r of reqs) {
    if (r.status === 'future' && r.arriveStep <= stepNo) {
      r.status = 'waiting';
      r.arrivedAt = stepNo;
      waiting.push(r);
      emit('req_arrive', { rid: r.rid, prompt_text: r.promptText, prompt_len: r.promptIds.length, max_new_tokens: r.maxNew });
    }
  }
  // capacity for running decoders; preempt newest if out of blocks
  let preemptedNow = false;
  for (const r of running.slice()) {
    if (r.status !== 'running' || r.needsPrefill) continue;
    for (;;) {
      const okT = ensure(T, r.tb, r, r.kv + K + 1);
      const okD = okT && ensure(D, r.db, r, r.kv + K + 1);
      if (okT && okD) break;
      const victim = running.slice().sort((a, b) => b.admitOrder - a.admitOrder)[0];
      preempt(victim);
      preemptedNow = true;
      if (victim === r) break;
    }
  }
  // admission
  if (!preemptedNow) {
    while (running.length < MAX_BATCH && waiting.length) {
      if (!tryAdmit(waiting[0])) break;
    }
  }
  if (!running.length) continue;

  const batch = running.map((r) => (r.needsPrefill
    ? { rid: r.rid, phase: 'prefill', n_tokens: r.seq.length - r.kv }
    : { rid: r.rid, phase: 'decode', n_tokens: K + 1 }));
  emit('step_begin', { batch });
  const totalTok = batch.reduce((s, b) => s + b.n_tokens, 0);

  for (const entry of batch) {
    const r = reqs[entry.rid];
    if (r.status !== 'running') continue;
    if (entry.phase === 'prefill') {
      setLen(T, r.tb, r, r.seq.length);
      setLen(D, r.db, r, r.seq.length);
      r.kv = r.seq.length; r.dkv = r.seq.length;
      r.needsPrefill = false;
      registerFull(r);
      emitNextTokens(r, 0, true);
    } else {
      specRound(r);
    }
  }
  const ms = Math.round((14 + totalTok * 0.42 + rnd() * 6) * 100) / 100;
  tWall += ms / 1000;
  emit('step_end', { ms, n_tokens: totalTok });
  hist.set(stepNo, totalTok);
  if (stepNo % SNAP_EVERY === 0) snapshot();
}
snapshot();

/** prefill: sample one token from the target (no speculation). */
function emitNextTokens(r: Req, _a: number, _prefill: boolean) {
  const word = r.script[r.gen];
  if (word === undefined) { finish(r, 'eos'); return; }
  commitToken(r, word);
  if (r.gen >= r.maxNew) finish(r, 'length');
}

function specRound(r: Req) {
  const kv0 = r.kv;
  // draft catches up and proposes K tokens
  const proposed: string[] = [];
  const truth: (string | undefined)[] = [];
  for (let j = 0; j < K; j++) truth.push(r.script[r.gen + j]);
  let ok = true;
  for (let j = 0; j < K; j++) {
    const tr = truth[j];
    if (ok && tr !== undefined && rnd() < r.p) proposed.push(tr);
    else {
      ok = false;
      let w = VOCAB_WRONG[Math.floor(rnd() * VOCAB_WRONG.length)];
      if (w === tr) w = ' also';
      proposed.push(w);
    }
  }
  emit('draft_propose', { rid: r.rid, tokens: proposed.map(tokId), texts: proposed });
  setLen(D, r.db, r, kv0 + K);
  r.dkv = kv0 + K;
  // target verifies K+1 positions
  setLen(T, r.tb, r, kv0 + K + 1);
  let a = 0;
  while (a < K && proposed[a] === truth[a] && truth[a] !== undefined) a++;
  const tgt = r.script[r.gen + a]; // undefined -> EOS
  emit('verify', { rid: r.rid, n_accepted: a, target_token: tgt === undefined ? EOS_ID : tokId(tgt), target_text: tgt === undefined ? '</s>' : tgt });
  const newLen = kv0 + 1 + a;
  if (newLen < kv0 + K + 1) {
    emit('kv_rollback', { rid: r.rid, pool: 'target', old_len: kv0 + K + 1, new_len: newLen });
    setLen(T, r.tb, r, newLen);
  }
  const dNew = Math.min(kv0 + K, newLen);
  if (dNew < kv0 + K) {
    emit('kv_rollback', { rid: r.rid, pool: 'draft', old_len: kv0 + K, new_len: dNew });
    setLen(D, r.db, r, dNew);
  }
  r.kv = newLen; r.dkv = dNew;
  // commit tokens (accepted, then target token), stopping at EOS / max_new
  let done: 'eos' | 'length' | null = null;
  for (let j = 0; j < a; j++) {
    commitToken(r, proposed[j]);
    if (r.gen >= r.maxNew) { done = 'length'; break; }
  }
  if (!done) {
    if (tgt === undefined) done = 'eos';
    else { commitToken(r, tgt); if (r.gen >= r.maxNew) done = 'length'; }
  }
  registerFull(r);
  if (done) finish(r, done);
}

// ---------- output ----------
const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? resolve(here, '../public/mock.jsonl');
writeFileSync(out, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
const counts: Record<string, number> = {};
for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
console.log(`wrote ${events.length} events, ${stepNo} steps -> ${out}`);
console.log(counts, { evictions, preemptions });
