// Per-request provenance, derived from the event stream (no engine change, no reducer
// change). After a `verify {n_accepted: n}` for request r, r's next n committed `token`
// events came from the draft model and the one after that is the target's own token
// (a correction when n < k, a bonus when all k were accepted). Tokens outside a
// speculation round (the first token after prefill, or plain decoding) are the target's.
import type { InfvizEvent } from './events';

export type TokSrc = 'draft' | 'target';

export interface TokRec {
  text: string;
  src: TokSrc;
  step: number;
  /** on a target correction: the draft token it replaced (the first rejected guess) */
  rejected?: string;
  /** on a target token closing a round where all k drafts were accepted */
  bonus?: boolean;
}

export interface RoundRec {
  step: number;
  proposed: number;
  accepted: number;
}

export interface RequestTrace {
  rid: number;
  tokens: TokRec[];
  rounds: RoundRec[];
  /** target-pool prefix blocks reused on admission (summed over re-admissions) */
  prefixHits: number;
  /** draft-pool prefix blocks reused */
  draftPrefixHits: number;
  /** speculative KV positions thrown away by rollbacks, target pool */
  rolledBack: number;
  stepsInBatch: number;
  prefillSteps: number;
}

/** Scan events [0, end) for request `rid`. O(end); call when cursor or selection changes. */
export function traceRequest(events: InfvizEvent[], end: number, rid: number): RequestTrace {
  const tr: RequestTrace = {
    rid,
    tokens: [],
    rounds: [],
    prefixHits: 0,
    draftPrefixHits: 0,
    rolledBack: 0,
    stepsInBatch: 0,
    prefillSteps: 0,
  };
  // sources for the next committed tokens of this request, filled by its verify event
  let queue: Pick<TokRec, 'src' | 'rejected' | 'bonus'>[] = [];
  let proposal: string[] = [];
  const n = Math.min(end, events.length);
  for (let i = 0; i < n; i++) {
    const e = events[i];
    switch (e.type) {
      case 'step_begin': {
        const b = e.batch.find((x) => x.rid === rid);
        if (b) {
          tr.stepsInBatch++;
          if (b.phase === 'prefill') tr.prefillSteps++;
        }
        break;
      }
      case 'draft_propose':
        if (e.rid === rid) proposal = e.texts;
        break;
      case 'verify':
        if (e.rid === rid) {
          const k = proposal.length;
          const a = e.n_accepted;
          tr.rounds.push({ step: e.step, proposed: k, accepted: a });
          queue = Array.from({ length: a }, () => ({ src: 'draft' as const }));
          queue.push(
            a < k ? { src: 'target', rejected: proposal[a] } : { src: 'target', bonus: k > 0 },
          );
          proposal = [];
        }
        break;
      case 'token':
        if (e.rid === rid) {
          const q = queue.shift() ?? { src: 'target' as const };
          tr.tokens.push({ text: e.text, step: e.step, ...q });
        }
        break;
      case 'block_hit':
        if (e.rid === rid) {
          if (e.pool === 'target') tr.prefixHits++;
          else tr.draftPrefixHits++;
        }
        break;
      case 'kv_rollback':
        if (e.rid === rid && e.pool === 'target') tr.rolledBack += Math.max(0, e.old_len - e.new_len);
        break;
      case 'req_preempt':
        if (e.rid === rid) queue = [];
        break;
    }
  }
  return tr;
}
