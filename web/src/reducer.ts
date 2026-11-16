// Pure event reducer. State is treated as immutable (copy-on-write with structural
// sharing) so any state object can be kept as a checkpoint and scrubbed back to.
import type {
  BatchEntry,
  BlockState,
  ConfigEvent,
  InfvizEvent,
  PoolName,
  SnapshotEvent,
} from './events';

export const N_SLOTS = 7; // categorical colour slots for live requests
export const SPARK_LEN = 48;
export const GLOBAL_SPARK_LEN = 160;

export interface Block {
  state: BlockState;
  owners: number[];
  filled: number;
  /** logical block index of the last alloc/hit (display only, not in snapshot) */
  idx: number;
}

export interface SpecRound {
  round: number;
  tokens: number[];
  texts: string[];
  /** null until the verify event arrives */
  nAccepted: number | null;
  targetToken: number | null;
  targetText: string | null;
}

export type ReqStatus = 'waiting' | 'running' | 'finished';

export interface ReqInfo {
  rid: number;
  prompt_text: string;
  prompt_len: number;
  max_new_tokens: number;
  status: ReqStatus;
  /** categorical colour slot while alive, -1 if none free / finished */
  slot: number;
  /** last slot held (kept after finish so history keeps its colour), -1 if never had one */
  colorSlot: number;
  arriveStep: number;
  admitSteps: number[];
  preemptSteps: number[];
  finishStep: number | null;
  finishReason: 'eos' | 'length' | null;
  outputLen: number | null;
  out: string;
  nTokens: number;
  /** bumps on each committed token (animation key) */
  tokenSeq: number;
  proposed: number;
  accepted: number;
  rounds: number;
  accHist: number[];
  spec: SpecRound | null;
  /** true when we never saw req_arrive (joined a live stream mid-flight) */
  stub: boolean;
  /** output text that existed when we joined (from a snapshot): its provenance is unknown */
  joinedText: string;
}

export interface RollbackMarker {
  seq: number;
  rid: number;
  pool: PoolName;
  old_len: number;
  new_len: number;
}

export interface State {
  config: ConfigEvent | null;
  pools: { target: Block[]; draft: Block[] | null };
  waiting: number[];
  running: number[];
  finished: number[];
  reqs: Record<number, ReqInfo>;
  /** slot -> rid or -1 */
  slots: number[];
  step: number;
  eventCount: number;
  curBatch: BatchEntry[];
  inStep: boolean;
  lastStepMs: number | null;
  lastStepTokens: number | null;
  rollback: RollbackMarker | null;
  specRoundSeq: number;
  globalAccHist: number[];
  totalProposed: number;
  totalAccepted: number;
  counters: { hits: number; evictions: number; preemptions: number; allocs: number };
  /** event.step of the most recent step_begin */
  stepsSeen: number;
}

export function initialState(): State {
  return {
    config: null,
    pools: { target: [], draft: null },
    waiting: [],
    running: [],
    finished: [],
    reqs: {},
    slots: new Array(N_SLOTS).fill(-1),
    step: 0,
    eventCount: 0,
    curBatch: [],
    inStep: false,
    lastStepMs: null,
    lastStepTokens: null,
    rollback: null,
    specRoundSeq: 0,
    globalAccHist: [],
    totalProposed: 0,
    totalAccepted: 0,
    counters: { hits: 0, evictions: 0, preemptions: 0, allocs: 0 },
    stepsSeen: 0,
  };
}

const FREE_BLOCK: Block = { state: 'free', owners: [], filled: 0, idx: -1 };

function makePool(n: number): Block[] {
  const a: Block[] = new Array(n);
  for (let i = 0; i < n; i++) a[i] = FREE_BLOCK;
  return a;
}

function stubReq(rid: number, step: number): ReqInfo {
  return {
    rid,
    prompt_text: '',
    prompt_len: 0,
    max_new_tokens: 0,
    status: 'waiting',
    slot: -1,
    colorSlot: -1,
    arriveStep: step,
    admitSteps: [],
    preemptSteps: [],
    finishStep: null,
    finishReason: null,
    outputLen: null,
    out: '',
    nTokens: 0,
    tokenSeq: 0,
    proposed: 0,
    accepted: 0,
    rounds: 0,
    accHist: [],
    spec: null,
    stub: true,
    joinedText: '',
  };
}

function pushCap<T>(a: T[], v: T, cap: number): T[] {
  const n = a.length >= cap ? a.slice(a.length - cap + 1) : a.slice();
  n.push(v);
  return n;
}

function withReq(s: State, rid: number, step: number, f: (r: ReqInfo) => Partial<ReqInfo>): State {
  const cur = s.reqs[rid] ?? stubReq(rid, step);
  return { ...s, reqs: { ...s.reqs, [rid]: { ...cur, ...f(cur) } } };
}

function takeSlot(s: State, rid: number): { slots: number[]; slot: number } {
  const have = s.slots.indexOf(rid);
  if (have >= 0) return { slots: s.slots, slot: have };
  const free = s.slots.indexOf(-1);
  if (free < 0) return { slots: s.slots, slot: -1 };
  const slots = s.slots.slice();
  slots[free] = rid;
  return { slots, slot: free };
}

function releaseSlot(slots: number[], rid: number): number[] {
  const i = slots.indexOf(rid);
  if (i < 0) return slots;
  const n = slots.slice();
  n[i] = -1;
  return n;
}

function setBlock(s: State, pool: PoolName, block: number, f: (b: Block) => Block): State {
  const arr = s.pools[pool];
  if (!arr || block < 0 || block >= arr.length) return s;
  const next = arr.slice();
  next[block] = f(arr[block]);
  return { ...s, pools: { ...s.pools, [pool]: next } };
}

function sortedAdd(a: number[], v: number): number[] {
  if (a.includes(v)) return a;
  const n = a.concat(v);
  n.sort((x, y) => x - y);
  return n;
}

export function apply(s: State, ev: InfvizEvent): State {
  const eventCount = s.eventCount + 1;
  const step = ev.step ?? s.step;
  let n: State = s;
  switch (ev.type) {
    case 'config': {
      n = {
        ...initialState(),
        config: ev,
        pools: {
          target: makePool(ev.pools.target.n_blocks),
          draft: ev.pools.draft ? makePool(ev.pools.draft.n_blocks) : null,
        },
      };
      break;
    }
    case 'req_arrive': {
      let slots = s.slots;
      let slot = -1;
      const t = takeSlot(s, ev.rid);
      slots = t.slots;
      slot = t.slot;
      const prev = s.reqs[ev.rid];
      const info: ReqInfo = {
        ...(prev ?? stubReq(ev.rid, step)),
        rid: ev.rid,
        prompt_text: ev.prompt_text,
        prompt_len: ev.prompt_len,
        max_new_tokens: ev.max_new_tokens,
        status: 'waiting',
        slot,
        colorSlot: slot >= 0 ? slot : (prev?.colorSlot ?? -1),
        arriveStep: step,
        stub: false,
      };
      n = {
        ...s,
        slots,
        reqs: { ...s.reqs, [ev.rid]: info },
        waiting: s.waiting.includes(ev.rid) ? s.waiting : [...s.waiting, ev.rid],
      };
      break;
    }
    case 'req_admit': {
      const t = takeSlot(s, ev.rid);
      n = withReq({ ...s, slots: t.slots }, ev.rid, step, (r) => ({
        status: 'running',
        slot: t.slot,
        colorSlot: t.slot >= 0 ? t.slot : r.colorSlot,
        admitSteps: [...r.admitSteps, step],
      }));
      n.waiting = s.waiting.filter((r) => r !== ev.rid);
      n.running = s.running.includes(ev.rid) ? s.running : [...s.running, ev.rid];
      break;
    }
    case 'req_preempt': {
      n = withReq(s, ev.rid, step, (r) => ({
        status: 'waiting',
        preemptSteps: [...r.preemptSteps, step],
        spec: null,
      }));
      n.running = s.running.filter((r) => r !== ev.rid);
      n.waiting = [ev.rid, ...s.waiting.filter((r) => r !== ev.rid)]; // front of queue
      n.counters = { ...s.counters, preemptions: s.counters.preemptions + 1 };
      break;
    }
    case 'req_finish': {
      n = withReq(s, ev.rid, step, () => ({
        status: 'finished',
        finishStep: step,
        finishReason: ev.reason,
        outputLen: ev.output_len,
        slot: -1,
        spec: null,
      }));
      n.slots = releaseSlot(s.slots, ev.rid);
      n.running = s.running.filter((r) => r !== ev.rid);
      n.waiting = s.waiting.filter((r) => r !== ev.rid);
      n.finished = [...s.finished, ev.rid];
      break;
    }
    case 'step_begin': {
      n = { ...s, curBatch: ev.batch, inStep: true, stepsSeen: step };
      break;
    }
    case 'step_end': {
      n = { ...s, inStep: false, lastStepMs: ev.ms, lastStepTokens: ev.n_tokens };
      break;
    }
    case 'block_alloc': {
      n = setBlock(s, ev.pool, ev.block, () => ({
        state: 'used',
        owners: [ev.rid],
        filled: 0,
        idx: ev.idx,
      }));
      if (ev.pool === 'target') n.counters = { ...s.counters, allocs: s.counters.allocs + 1 };
      break;
    }
    case 'block_fill': {
      n = setBlock(s, ev.pool, ev.block, (b) => ({ ...b, filled: ev.filled }));
      break;
    }
    case 'block_hit': {
      n = setBlock(s, ev.pool, ev.block, (b) =>
        b.state === 'cached'
          ? { ...b, state: 'used', owners: [ev.rid], idx: ev.idx }
          : { ...b, state: 'used', owners: sortedAdd(b.owners, ev.rid) },
      );
      if (ev.pool === 'target') n.counters = { ...s.counters, hits: s.counters.hits + 1 };
      break;
    }
    case 'block_release': {
      n = setBlock(s, ev.pool, ev.block, (b) => ({ ...b, owners: b.owners.filter((o) => o !== ev.rid) }));
      break;
    }
    case 'block_cache': {
      n = setBlock(s, ev.pool, ev.block, (b) => ({ ...b, state: 'cached', owners: [] }));
      break;
    }
    case 'block_free': {
      n = setBlock(s, ev.pool, ev.block, () => FREE_BLOCK);
      break;
    }
    case 'block_evict': {
      n = setBlock(s, ev.pool, ev.block, () => FREE_BLOCK);
      if (ev.pool === 'target') n.counters = { ...s.counters, evictions: s.counters.evictions + 1 };
      break;
    }
    case 'kv_rollback': {
      n = {
        ...s,
        rollback: {
          seq: (s.rollback?.seq ?? 0) + 1,
          rid: ev.rid,
          pool: ev.pool,
          old_len: ev.old_len,
          new_len: ev.new_len,
        },
      };
      break;
    }
    case 'draft_propose': {
      const round = s.specRoundSeq + 1;
      n = withReq(s, ev.rid, step, () => ({
        spec: {
          round,
          tokens: ev.tokens,
          texts: ev.texts,
          nAccepted: null,
          targetToken: null,
          targetText: null,
        },
      }));
      n.specRoundSeq = round;
      break;
    }
    case 'verify': {
      const cur = s.reqs[ev.rid];
      const k = cur?.spec?.tokens.length ?? 0;
      const frac = k > 0 ? ev.n_accepted / k : 0;
      n = withReq(s, ev.rid, step, (r) => ({
        proposed: r.proposed + k,
        accepted: r.accepted + ev.n_accepted,
        rounds: r.rounds + 1,
        accHist: k > 0 ? pushCap(r.accHist, frac, SPARK_LEN) : r.accHist,
        spec: r.spec
          ? { ...r.spec, nAccepted: ev.n_accepted, targetToken: ev.target_token, targetText: ev.target_text }
          : {
              round: s.specRoundSeq + 1,
              tokens: [],
              texts: [],
              nAccepted: ev.n_accepted,
              targetToken: ev.target_token,
              targetText: ev.target_text,
            },
      }));
      n.totalProposed = s.totalProposed + k;
      n.totalAccepted = s.totalAccepted + ev.n_accepted;
      if (k > 0) n.globalAccHist = pushCap(s.globalAccHist, frac, GLOBAL_SPARK_LEN);
      break;
    }
    case 'token': {
      n = withReq(s, ev.rid, step, (r) => ({
        out: r.out + ev.text,
        nTokens: r.nTokens + 1,
        tokenSeq: r.tokenSeq + 1,
      }));
      break;
    }
    case 'snapshot': {
      // Live-join hydration only: if nothing but `config` came before, adopt the snapshot.
      // Otherwise the stream's own events are authoritative (honesty invariant).
      if (s.config && s.eventCount <= 1) n = hydrate(s, ev);
      break;
    }
    default:
      return { ...s, eventCount, step: Math.max(s.step, step) };
  }
  if (n === s) n = { ...s };
  n.eventCount = eventCount;
  n.step = Math.max(s.step, step);
  return n;
}

function hydrate(s: State, ev: SnapshotEvent): State {
  const toPool = (p?: { blocks: { state: BlockState; owners: number[]; filled: number }[] }): Block[] | null =>
    p ? p.blocks.map((b) => ({ state: b.state, owners: b.owners.slice(), filled: b.filled, idx: -1 })) : null;
  let n: State = {
    ...s,
    pools: { target: toPool(ev.pools.target) ?? s.pools.target, draft: toPool(ev.pools.draft) },
    waiting: ev.waiting.slice(),
    running: ev.running.slice(),
    finished: ev.finished.slice(),
  };
  const mark = (rids: number[], status: ReqStatus) => {
    for (const rid of rids) {
      const t = status === 'finished' ? { slots: n.slots, slot: -1 } : takeSlot(n, rid);
      const cur = n.reqs[rid] ?? stubReq(rid, ev.step);
      const seq = ev.seqs[String(rid)];
      const meta = ev.reqs?.[String(rid)];
      const known = meta
        ? { prompt_text: meta.prompt_text, prompt_len: meta.prompt_len, max_new_tokens: meta.max_new_tokens, arriveStep: meta.arrive_step, out: meta.out, joinedText: meta.out, stub: false }
        : {};
      n = {
        ...n,
        slots: t.slots,
        reqs: {
          ...n.reqs,
          [rid]: { ...cur, ...known, status, slot: t.slot, colorSlot: t.slot >= 0 ? t.slot : cur.colorSlot, nTokens: seq ? seq.n_generated : cur.nTokens },
        },
      };
    }
  };
  mark(ev.waiting, 'waiting');
  mark(ev.running, 'running');
  mark(ev.finished, 'finished');
  return n;
}

export function replay(events: InfvizEvent[], upTo = events.length): State {
  let s = initialState();
  for (let i = 0; i < upTo; i++) s = apply(s, events[i]);
  return s;
}

/** Blocks of `pool` held by `rid`. */
export function blocksOf(s: State, pool: PoolName, rid: number): number[] {
  const arr = s.pools[pool];
  const out: number[] = [];
  if (!arr) return out;
  for (let i = 0; i < arr.length; i++) if (arr[i].owners.includes(rid)) out.push(i);
  return out;
}

/** Project state to the exact `snapshot` event shape (minus type/step/t). */
export function stateToSnapshot(s: State) {
  const pool = (blocks: Block[]) => ({
    blocks: blocks.map((b) => ({
      state: b.state,
      owners: b.owners.slice().sort((x, y) => x - y),
      filled: b.filled,
    })),
  });
  const pools: { target: ReturnType<typeof pool>; draft?: ReturnType<typeof pool> } = {
    target: pool(s.pools.target),
  };
  if (s.pools.draft) pools.draft = pool(s.pools.draft);

  // kv_len: tokens of the request currently held in the *target* pool = sum of `filled`
  // over target blocks it owns (shared blocks count fully for each owner).
  const kv: Record<number, number> = {};
  for (const b of s.pools.target) for (const o of b.owners) kv[o] = (kv[o] ?? 0) + b.filled;

  const seqs: Record<string, { kv_len: number; n_generated: number }> = {};
  const live = Object.values(s.reqs)
    .filter((r) => r.status !== 'finished')
    .sort((a, b) => a.rid - b.rid);
  for (const r of live) seqs[String(r.rid)] = { kv_len: kv[r.rid] ?? 0, n_generated: r.nTokens };
  return {
    pools,
    waiting: s.waiting.slice(),
    running: s.running.slice(),
    finished: s.finished.slice(),
    seqs,
  };
}

export function poolStats(blocks: Block[] | null) {
  let used = 0,
    cached = 0,
    free = 0;
  if (blocks)
    for (const b of blocks) {
      if (b.state === 'used') used++;
      else if (b.state === 'cached') cached++;
      else free++;
    }
  return { used, cached, free, total: blocks ? blocks.length : 0 };
}
