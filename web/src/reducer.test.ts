import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseJsonl } from './events';
import { apply, initialState, stateToSnapshot } from './reducer';

const path = process.env.TRACE ?? resolve(__dirname, '../public/mock.jsonl');
const events = parseJsonl(readFileSync(path, 'utf8'));
const isMock = events[0]?.type === 'config' && (events[0] as any).models.target === 'mock';

describe(`honesty: ${path}`, () => {
  it('starts with config and ends with a snapshot', () => {
    expect(events[0].type).toBe('config');
    expect(events[events.length - 1].type).toBe('snapshot');
  });

  it('steps are non-decreasing', () => {
    for (let i = 1; i < events.length; i++) expect(events[i].step).toBeGreaterThanOrEqual(events[i - 1].step);
  });

  it('reducer reproduces every snapshot (pools, queues, seqs)', () => {
    let s = initialState();
    let n = 0;
    for (const ev of events) {
      if (ev.type === 'snapshot') {
        const want = { pools: ev.pools, waiting: ev.waiting, running: ev.running, finished: ev.finished, seqs: ev.seqs };
        expect(stateToSnapshot(s), `snapshot #${n} at step ${ev.step}`).toEqual(want);
        n++;
      } else s = apply(s, ev);
    }
    expect(n).toBeGreaterThan(0);
  });

  it('is pure: earlier states are not mutated by later events', () => {
    let s = initialState();
    const checkpoints: { i: number; json: string; st: typeof s }[] = [];
    events.forEach((ev, i) => {
      s = apply(s, ev);
      if (i % 97 === 0) checkpoints.push({ i, st: s, json: JSON.stringify(s) });
    });
    for (const c of checkpoints) expect(JSON.stringify(c.st)).toBe(c.json);
  });

  it.runIf(isMock)('mock trace contains the scenarios it promises', () => {
    const types = new Set(events.map((e) => e.type));
    for (const t of ['block_evict', 'req_preempt', 'kv_rollback', 'block_cache', 'draft_propose', 'verify', 'token'])
      expect(types.has(t as any), t).toBe(true);
    // a hit on a used block and a hit on a cached block
    let s = initialState();
    let hitUsed = false,
      hitCached = false;
    for (const ev of events) {
      if (ev.type === 'block_hit') {
        const st = s.pools[ev.pool]![ev.block].state;
        if (st === 'used') hitUsed = true;
        if (st === 'cached') hitCached = true;
      }
      s = apply(s, ev);
    }
    expect(hitUsed).toBe(true);
    expect(hitCached).toBe(true);
    const snaps = events.filter((e) => e.type === 'snapshot');
    expect(snaps.length).toBeGreaterThan(5);
    const cfg = events[0] as any;
    expect(cfg.block_size).toBe(16);
    expect(cfg.spec_k).toBe(4);
  });
});
