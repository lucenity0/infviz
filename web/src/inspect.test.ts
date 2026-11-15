import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseJsonl } from './events';
import { traceRequest } from './inspect';
import { apply, initialState } from './reducer';

const path = process.env.TRACE ?? resolve(__dirname, '../public/mock.jsonl');
const events = parseJsonl(readFileSync(path, 'utf8'));

describe(`inspect: ${path}`, () => {
  let s = initialState();
  for (const e of events) if (e.type !== 'snapshot') s = apply(s, e);
  const rids = Object.keys(s.reqs).map(Number);

  it('rebuilds every request text and token count the reducer has', () => {
    expect(rids.length).toBeGreaterThan(0);
    for (const rid of rids) {
      const tr = traceRequest(events, events.length, rid);
      const r = s.reqs[rid];
      expect(tr.tokens.map((t) => t.text).join(''), `r${rid} text`).toBe(r.out);
      expect(tr.tokens.length, `r${rid} tokens`).toBe(r.nTokens);
      expect(tr.rounds.length, `r${rid} rounds`).toBe(r.rounds);
    }
  });

  it('attributes tokens consistently with verify events', () => {
    for (const rid of rids) {
      const tr = traceRequest(events, events.length, rid);
      const r = s.reqs[rid];
      const drafted = tr.tokens.filter((t) => t.src === 'draft').length;
      // accepted drafts past an EOS or the length cap are never committed
      expect(drafted, `r${rid}`).toBeLessThanOrEqual(r.accepted);
      // only the finishing round can be cut short, losing at most k accepted drafts
      const k = (events[0] as any).spec_k as number;
      expect(drafted, `r${rid}`).toBeGreaterThanOrEqual(r.accepted - (r.finishStep !== null ? k : 0));
      for (const t of tr.tokens) if (t.rejected !== undefined) expect(t.src).toBe('target');
      const corrections = tr.tokens.filter((t) => t.rejected !== undefined).length;
      expect(corrections).toBeLessThanOrEqual(tr.rounds.filter((x) => x.accepted < x.proposed).length);
    }
  });

  it('is a prefix function of the cursor', () => {
    const rid = rids[0];
    const full = traceRequest(events, events.length, rid);
    const half = traceRequest(events, Math.floor(events.length / 2), rid);
    expect(full.tokens.slice(0, half.tokens.length).map((t) => t.src)).toEqual(half.tokens.map((t) => t.src));
  });
});
