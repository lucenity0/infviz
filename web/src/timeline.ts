// Append-only index over the event list. Pure function of the events: it adds no data,
// only makes the stream addressable by time.
//
// Time model: playback position `pos` is a fractional engine step. The events of step s
// (all events whose `step` field is s) are laid out over [s, s + MOTION.eventSpan): each
// event i gets a time tau(i). The cursor at `pos` is "every event with tau <= pos", and
// every animation is a function of (pos - tau), so scrubbing in either direction is exact.
import type { BatchEntry, InfvizEvent, PoolName } from './events';
import { MOTION } from './tokens';

export interface KvCounts {
  used: number;
  cached: number;
  free: number;
}

export interface StepRec {
  step: number;
  beginIdx: number;
  endIdx: number; // -1 until step_end seen
  batch: BatchEntry[];
  ms: number | null;
  nTokens: number | null;
  /** committed token events: [rid, eventIdx] */
  tokens: [number, number][];
  /** target-pool occupancy after this step */
  kv: KvCounts | null;
  proposed: number;
  accepted: number;
  rounds: number;
}

type Slot = { state: 'free' | 'used' | 'cached'; filled: number };

export class Timeline {
  steps: StepRec[] = [];
  /** step number -> index into `steps` */
  byStep = new Map<number, number>();
  preempts: number[] = [];
  maxStep = 0;
  maxTokens = 1;
  maxMs = 1;
  nBlocks = 0;
  /** firstIdx[s] = index of the first event with step >= s */
  private firstIdx: number[] = [];
  private nEvents = 0;
  private taus = new Map<number, Float64Array>();
  private evs: InfvizEvent[] = [];
  /** sealed = no more events will arrive (replay): the last group is complete */
  sealed = false;
  /** step of the most recent step_end (live: a group is showable once its step ended) */
  private lastEnded = -1;
  /** block_fill / block_free / block_evict / block_cache: block's filled count before the event */
  prevFilled = new Map<number, number>();
  private pools: Record<string, Slot[]> = {};
  private open: StepRec | null = null;

  reset(events: InfvizEvent[]) {
    this.steps = [];
    this.byStep.clear();
    this.preempts = [];
    this.open = null;
    this.maxStep = 0;
    this.maxTokens = 1;
    this.maxMs = 1;
    this.nBlocks = 0;
    this.firstIdx = [];
    this.nEvents = 0;
    this.taus.clear();
    this.evs = events;
    this.sealed = false;
    this.lastEnded = -1;
    this.prevFilled.clear();
    this.pools = {};
  }

  add(ev: InfvizEvent, idx: number) {
    this.nEvents = idx + 1;
    while (this.firstIdx.length <= ev.step) this.firstIdx.push(idx);
    if (ev.step > this.maxStep) this.maxStep = ev.step;

    switch (ev.type) {
      case 'config':
        this.pools = {};
        for (const [name, p] of Object.entries(ev.pools)) {
          if (p) this.pools[name] = Array.from({ length: p.n_blocks }, () => ({ state: 'free', filled: 0 }));
        }
        this.nBlocks = ev.pools.target.n_blocks;
        break;
      case 'snapshot': {
        // a snapshot closes its step (a late joiner's backlog ends with one, no step_end)
        this.lastEnded = Math.max(this.lastEnded, ev.step);
        // seed from the first snapshot if we joined a live stream mid-flight
        const seen = this.steps.length > 0 || idx > 1;
        if (!seen) {
          for (const [name, p] of Object.entries(ev.pools)) {
            if (p && this.pools[name])
              this.pools[name] = p.blocks.map((b) => ({ state: b.state, filled: b.filled }));
          }
        }
        break;
      }
      case 'step_begin':
        this.open = {
          step: ev.step,
          beginIdx: idx,
          endIdx: -1,
          batch: ev.batch,
          ms: null,
          nTokens: null,
          tokens: [],
          kv: null,
          proposed: 0,
          accepted: 0,
          rounds: 0,
        };
        this.byStep.set(ev.step, this.steps.length);
        this.steps.push(this.open);
        break;
      case 'step_end':
        this.lastEnded = ev.step;
        if (this.open) {
          this.open.endIdx = idx;
          this.open.ms = ev.ms;
          this.open.nTokens = ev.n_tokens;
          this.open.kv = this.counts('target');
          this.maxTokens = Math.max(this.maxTokens, ev.n_tokens);
          this.maxMs = Math.max(this.maxMs, ev.ms);
          this.open = null;
        }
        break;
      case 'req_preempt':
        this.preempts.push(ev.step);
        break;
      case 'token':
        this.open?.tokens.push([ev.rid, idx]);
        break;
      case 'draft_propose':
        if (this.open) this.open.proposed += ev.tokens.length;
        break;
      case 'verify':
        if (this.open) {
          this.open.accepted += ev.n_accepted;
          this.open.rounds++;
        }
        break;
      case 'block_alloc':
      case 'block_hit':
        this.setSlot(ev.pool, ev.block, idx, 'used', null);
        break;
      case 'block_fill':
        this.setSlot(ev.pool, ev.block, idx, null, ev.filled);
        break;
      case 'block_cache':
        this.setSlot(ev.pool, ev.block, idx, 'cached', null);
        break;
      case 'block_free':
      case 'block_evict':
        this.setSlot(ev.pool, ev.block, idx, 'free', 0);
        break;
    }
  }

  private setSlot(pool: PoolName, block: number, idx: number, state: Slot['state'] | null, filled: number | null) {
    const b = this.pools[pool]?.[block];
    if (!b) return;
    this.prevFilled.set(idx, b.filled);
    if (state) b.state = state;
    if (filled !== null) b.filled = filled;
  }

  private counts(pool: string): KvCounts {
    const c = { used: 0, cached: 0, free: 0 };
    for (const b of this.pools[pool] ?? []) c[b.state]++;
    return c;
  }

  // ------------------------------------------------------------------ time model
  /** first event index of group s, and one past its last */
  groupRange(s: number): [number, number] {
    const a = s < this.firstIdx.length ? this.firstIdx[s] : this.nEvents;
    const b = s + 1 < this.firstIdx.length ? this.firstIdx[s + 1] : this.nEvents;
    return [a, b];
  }

  /** highest position the playhead may reach: every complete step group fully settled */
  maxPos(): number {
    if (this.nEvents === 0) return 0;
    // live: the newest group is showable once its step_end has arrived (an idle engine
    // emits nothing more, and we must still show the step's finishes)
    return this.sealed || this.lastEnded === this.maxStep ? this.maxStep + 1 : this.maxStep;
  }

  private groupTaus(s: number): Float64Array {
    const [a, b] = this.groupRange(s);
    const complete = this.sealed || s < this.maxStep; // live: the newest group may still grow
    const cached = this.taus.get(s);
    if (cached && cached.length === b - a) return cached;
    const w = new Float64Array(b - a);
    let total = 0;
    for (let i = a; i < b; i++) {
      let wi = 1;
      const t = this.evs[i].type;
      // the draft "ghost" dwell: a gap between the last proposal and the verify pass
      if (i > a && t !== 'draft_propose' && this.evs[i - 1].type === 'draft_propose') wi += MOTION.specGap * (b - a);
      total += wi;
      w[i - a] = total;
    }
    const tau = new Float64Array(b - a);
    for (let k = 0; k < tau.length; k++) tau[k] = s + MOTION.eventSpan * (w[k] / total);
    if (complete) this.taus.set(s, tau);
    return tau;
  }

  /** playback time of event i */
  tau(i: number): number {
    const s = this.evs[i].step;
    const [a] = this.groupRange(s);
    return this.groupTaus(s)[i - a];
  }

  /** number of events applied at playback position pos */
  cursorAt(pos: number): number {
    if (this.nEvents === 0) return 0;
    if (pos >= this.maxStep + 1) return this.nEvents;
    const s = Math.max(0, Math.floor(pos));
    const [a, b] = this.groupRange(s);
    const tau = this.groupTaus(s);
    let lo = 0,
      hi = b - a;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (tau[m] <= pos) lo = m + 1;
      else hi = m;
    }
    return Math.max(1, a + lo); // the config event is always applied
  }

  rec(step: number): StepRec | undefined {
    const i = this.byStep.get(step);
    return i === undefined ? undefined : this.steps[i];
  }

  /** tokens committed for rid in a step record, counting only events before `cursor` */
  committed(rec: StepRec, rid: number, cursor: number): number {
    let c = 0;
    for (const [r, i] of rec.tokens) if (r === rid && i < cursor) c++;
    return c;
  }
}
