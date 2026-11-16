import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseJsonl, type SnapshotEvent } from './events';
import { apply, initialState, stateToSnapshot, type State } from './reducer';

const path = process.env.TRACE ?? resolve(__dirname, '../public/mock.jsonl');
const events = parseJsonl(readFileSync(path, 'utf8'));
const snaps = events.map((e, i) => [e, i] as const).filter(([e]) => e.type === 'snapshot' && e.step > 0);
const hasMeta = snaps.some(([e]) => (e as SnapshotEvent).reqs);

const replay = (evs: typeof events): State => evs.reduce((s, e) => apply(s, e), initialState());

describe(`late join: ${path}`, () => {
  it.runIf(hasMeta)('joining at any snapshot ends in the same request state as watching from the start', () => {
    const full = replay(events.filter((e) => e.type !== 'snapshot'));
    expect(snaps.length).toBeGreaterThan(2);
    for (const [snap, i] of snaps) {
      // what the live server sends a late joiner: config, the last snapshot, then every later event
      const late = replay([events[0], snap, ...events.slice(i + 1)]);
      const at = snap as SnapshotEvent;
      const tracked = new Set([...at.waiting, ...at.running]);
      for (const e of events.slice(i + 1)) if (e.type === 'req_arrive') tracked.add(e.rid);
      for (const rid of tracked) {
        const a = late.reqs[rid],
          b = full.reqs[rid];
        const pick = (r: typeof a) => ({ p: r.prompt_text, pl: r.prompt_len, mx: r.max_new_tokens, out: r.out, n: r.nTokens, st: r.status, ar: r.arriveStep, stub: r.stub });
        expect(pick(a), `r${rid} joined at step ${snap.step}`).toEqual(pick(b));
      }
      expect(stateToSnapshot(late).pools).toEqual(stateToSnapshot(full).pools);
    }
  });

  it('the request metadata is optional: a trace without it still hydrates queues and pools', () => {
    const [snap, i] = snaps[Math.floor(snaps.length / 2)];
    const bare = { ...(snap as SnapshotEvent) };
    delete bare.reqs;
    const late = replay([events[0], bare, ...events.slice(i + 1)]);
    const full = replay(events.filter((e) => e.type !== 'snapshot'));
    expect(stateToSnapshot(late).pools).toEqual(stateToSnapshot(full).pools);
  });
});
