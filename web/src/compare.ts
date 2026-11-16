// A/B comparison of two traces on one wall-clock axis.
//
// Steps are not comparable across runs (speculation takes far fewer, slower steps), so
// the shared clock is SECONDS since each run's first step_begin. timeToPos() maps that
// clock onto each trace's own fractional step position, so each side still renders
// through the ordinary Player / panels. Pure functions; no DOM.
import type { InfvizEvent } from './events';

export interface RunSummary {
  label: string;
  model: string;
  draft: string | null;
  k: number;
  blocks: number;
  maxBatch: number;
  steps: number;
  /** seconds from the first step_begin to the last step_end */
  seconds: number;
  tokens: number;
  tokPerSec: number;
  tokPerPass: number | null;
  acceptance: number | null;
  prefixHits: number;
  evictions: number;
  preemptions: number;
  rollbacks: number;
  /** committed token ids per rid, for output-match counting */
  outputs: Map<number, number[]>;
}

/** step boundaries in run-relative seconds: begin[s], end[s] for every step that ran */
export interface Clock {
  t0: number;
  steps: { step: number; begin: number; end: number }[];
}

export function clockOf(events: InfvizEvent[]): Clock {
  let t0: number | null = null;
  const steps: Clock['steps'] = [];
  let open: { step: number; begin: number } | null = null;
  for (const e of events) {
    if (e.type === 'step_begin') {
      if (t0 === null) t0 = e.t;
      open = { step: e.step, begin: e.t - t0 };
    } else if (e.type === 'step_end' && open && t0 !== null) {
      steps.push({ ...open, end: e.t - t0 });
      open = null;
    }
  }
  return { t0: t0 ?? 0, steps };
}

/**
 * Player position (fractional step, see timeline.ts) at run-relative time `sec`.
 * During step s (begin..end) the position runs s .. s+1 linearly; between steps it
 * rests at the end of the previous step. Before the first step: its start.
 */
export function timeToPos(c: Clock, sec: number): number {
  const st = c.steps;
  if (!st.length) return 0;
  if (sec <= st[0].begin) return st[0].step;
  let lo = 0,
    hi = st.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (st[m].begin <= sec) lo = m;
    else hi = m - 1;
  }
  const s = st[lo];
  if (sec >= s.end) return s.step + 1;
  const f = s.end > s.begin ? (sec - s.begin) / (s.end - s.begin) : 1;
  return s.step + f;
}

/** inverse of timeToPos at step boundaries: run-relative seconds at position `pos` */
export function posToTime(c: Clock, pos: number): number {
  const st = c.steps;
  if (!st.length) return 0;
  const s = Math.floor(pos);
  const i = st.findIndex((x) => x.step === s);
  if (i < 0) return pos < st[0].step ? 0 : st[st.length - 1].end;
  const f = pos - s;
  return st[i].begin + f * (st[i].end - st[i].begin);
}

export function summarize(events: InfvizEvent[], label: string): RunSummary {
  const cfg = events.find((e) => e.type === 'config');
  const c = clockOf(events);
  const outputs = new Map<number, number[]>();
  let tokens = 0,
    rounds = 0,
    accepted = 0,
    proposed = 0,
    hits = 0,
    evictions = 0,
    preemptions = 0,
    rollbacks = 0;
  const k = cfg?.type === 'config' ? cfg.spec_k : 0;
  for (const e of events) {
    switch (e.type) {
      case 'token': {
        tokens++;
        const o = outputs.get(e.rid);
        if (o) o.push(e.token);
        else outputs.set(e.rid, [e.token]);
        break;
      }
      case 'verify':
        rounds++;
        accepted += e.n_accepted;
        proposed += k;
        break;
      case 'block_hit':
        if (e.pool === 'target') hits++;
        break;
      case 'block_evict':
        if (e.pool === 'target') evictions++;
        break;
      case 'req_preempt':
        preemptions++;
        break;
      case 'kv_rollback':
        if (e.pool === 'target') rollbacks++;
        break;
    }
  }
  const seconds = c.steps.length ? c.steps[c.steps.length - 1].end - c.steps[0].begin : 0;
  return {
    label,
    model: cfg?.type === 'config' ? cfg.models.target : '?',
    draft: cfg?.type === 'config' ? cfg.models.draft : null,
    k,
    blocks: cfg?.type === 'config' ? cfg.pools.target.n_blocks : 0,
    maxBatch: cfg?.type === 'config' ? cfg.max_batch : 0,
    steps: c.steps.length,
    seconds,
    tokens,
    tokPerSec: seconds > 0 ? tokens / seconds : 0,
    tokPerPass: rounds ? 1 + accepted / rounds : null,
    acceptance: proposed ? accepted / proposed : null,
    prefixHits: hits,
    evictions,
    preemptions,
    rollbacks,
    outputs,
  };
}

/** requests whose committed output is identical in both runs, out of those in both */
export function outputMatch(a: RunSummary, b: RunSummary): { same: number; total: number } {
  let same = 0,
    total = 0;
  for (const [rid, o] of a.outputs) {
    const p = b.outputs.get(rid);
    if (!p) continue;
    total++;
    if (o.length === p.length && o.every((t, i) => t === p[i])) same++;
  }
  return { same, total };
}

/** b relative to a, as a ratio (1.0 = equal) */
export const ratio = (b: number, a: number) => (a > 0 ? b / a : NaN);
