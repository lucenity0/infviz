// Types mirroring docs/EVENTS.md (v1). Single source of truth for the stream.

export type PoolName = 'target' | 'draft';
export type BlockState = 'free' | 'used' | 'cached';
export type Phase = 'prefill' | 'decode';

interface Base {
  /** engine step this happened in (0 before the first step) */
  step: number;
  /** seconds since engine start (wall clock) */
  t: number;
}

export interface ConfigEvent extends Base {
  type: 'config';
  models: { target: string; draft: string | null };
  device: string;
  block_size: number;
  pools: { target: { n_blocks: number }; draft?: { n_blocks: number } };
  max_batch: number;
  spec_k: number;
  snapshot_every: number;
}

export interface ReqArriveEvent extends Base {
  type: 'req_arrive';
  rid: number;
  prompt_text: string;
  prompt_len: number;
  max_new_tokens: number;
}
export interface ReqAdmitEvent extends Base {
  type: 'req_admit';
  rid: number;
}
export interface ReqPreemptEvent extends Base {
  type: 'req_preempt';
  rid: number;
  reason: 'kv_pressure';
}
export interface ReqFinishEvent extends Base {
  type: 'req_finish';
  rid: number;
  reason: 'eos' | 'length';
  output_len: number;
}

export interface BatchEntry {
  rid: number;
  phase: Phase;
  n_tokens: number;
}
export interface StepBeginEvent extends Base {
  type: 'step_begin';
  batch: BatchEntry[];
}
export interface StepEndEvent extends Base {
  type: 'step_end';
  ms: number;
  n_tokens: number;
}

export interface BlockAllocEvent extends Base {
  type: 'block_alloc';
  pool: PoolName;
  block: number;
  rid: number;
  idx: number;
}
export interface BlockFillEvent extends Base {
  type: 'block_fill';
  pool: PoolName;
  block: number;
  filled: number;
}
export interface BlockHitEvent extends Base {
  type: 'block_hit';
  pool: PoolName;
  block: number;
  rid: number;
  idx: number;
}
export interface BlockReleaseEvent extends Base {
  type: 'block_release';
  pool: PoolName;
  block: number;
  rid: number;
}
export interface BlockCacheEvent extends Base {
  type: 'block_cache';
  pool: PoolName;
  block: number;
}
export interface BlockFreeEvent extends Base {
  type: 'block_free';
  pool: PoolName;
  block: number;
}
export interface BlockEvictEvent extends Base {
  type: 'block_evict';
  pool: PoolName;
  block: number;
}
export interface KvRollbackEvent extends Base {
  type: 'kv_rollback';
  rid: number;
  pool: PoolName;
  old_len: number;
  new_len: number;
}

export interface DraftProposeEvent extends Base {
  type: 'draft_propose';
  rid: number;
  tokens: number[];
  texts: string[];
}
export interface VerifyEvent extends Base {
  type: 'verify';
  rid: number;
  n_accepted: number;
  target_token: number;
  target_text: string;
}
export interface TokenEvent extends Base {
  type: 'token';
  rid: number;
  token: number;
  text: string;
}

export interface SnapshotBlock {
  state: BlockState;
  owners: number[];
  filled: number;
}
export interface SnapshotPool {
  blocks: SnapshotBlock[];
}
export interface SnapshotEvent extends Base {
  type: 'snapshot';
  pools: { target: SnapshotPool; draft?: SnapshotPool };
  waiting: number[];
  running: number[];
  finished: number[];
  seqs: Record<string, { kv_len: number; n_generated: number }>;
  /** unfinished requests' metadata, for a late joiner. Optional (older traces lack it) and
   *  outside the honesty invariant. `out` = the output text committed so far. */
  reqs?: Record<string, { prompt_text: string; prompt_len: number; max_new_tokens: number; arrive_step: number; out: string }>;
}

export type InfvizEvent =
  | ConfigEvent
  | ReqArriveEvent
  | ReqAdmitEvent
  | ReqPreemptEvent
  | ReqFinishEvent
  | StepBeginEvent
  | StepEndEvent
  | BlockAllocEvent
  | BlockFillEvent
  | BlockHitEvent
  | BlockReleaseEvent
  | BlockCacheEvent
  | BlockFreeEvent
  | BlockEvictEvent
  | KvRollbackEvent
  | DraftProposeEvent
  | VerifyEvent
  | TokenEvent
  | SnapshotEvent;

export type EventType = InfvizEvent['type'];

/** Parse a .jsonl trace; blank/garbled lines are skipped. */
export function parseJsonl(text: string): InfvizEvent[] {
  const out: InfvizEvent[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o.type === 'string') out.push(o as InfvizEvent);
    } catch {
      /* skip */
    }
  }
  return out;
}
