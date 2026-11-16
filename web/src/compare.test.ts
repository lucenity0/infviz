import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseJsonl } from './events';
import { clockOf, outputMatch, posToTime, summarize, timeToPos } from './compare';
import { apply, initialState } from './reducer';

const load = (f: string) => parseJsonl(readFileSync(resolve(__dirname, '../public', f), 'utf8'));
const A = load('ab-plain.jsonl');
const B = load('ab-spec.jsonl');

describe('compare: the bundled A/B pair', () => {
  it('maps time to position monotonically, covering every step', () => {
    for (const ev of [A, B]) {
      const c = clockOf(ev);
      expect(c.steps.length).toBeGreaterThan(10);
      expect(timeToPos(c, -1)).toBe(c.steps[0].step);
      const end = c.steps[c.steps.length - 1].end;
      expect(timeToPos(c, end + 1)).toBe(c.steps[c.steps.length - 1].step + 1);
      let prev = -Infinity;
      for (let t = 0; t <= end; t += end / 997) {
        const p = timeToPos(c, t);
        expect(p).toBeGreaterThanOrEqual(prev);
        prev = p;
      }
    }
  });

  it('round-trips position -> time -> position inside steps', () => {
    const c = clockOf(B);
    for (const s of c.steps.slice(0, 40)) {
      for (const f of [0.1, 0.5, 0.9]) expect(timeToPos(c, posToTime(c, s.step + f))).toBeCloseTo(s.step + f, 6);
    }
  });

  it('summaries agree with the reducer and with each other', () => {
    for (const ev of [A, B]) {
      let s = initialState();
      for (const e of ev) if (e.type !== 'snapshot') s = apply(s, e);
      const sum = summarize(ev, 'x');
      expect(sum.tokens).toBe(Object.values(s.reqs).reduce((n, r) => n + r.nTokens, 0));
      expect(sum.preemptions).toBe(s.counters.preemptions);
      expect(sum.evictions).toBe(s.counters.evictions);
    }
    const a = summarize(A, 'plain'),
      b = summarize(B, 'spec');
    expect(a.k).toBe(0);
    expect(b.k).toBe(4);
    expect(a.tokPerPass).toBeNull();
    expect(b.steps).toBeLessThan(a.steps); // fewer steps ...
    expect(b.seconds).toBeGreaterThan(a.seconds); // ... but not less time on this machine (README §4)
    const m = outputMatch(a, b);
    expect(m.total).toBe(16);
    expect(m.same).toBeLessThanOrEqual(16);
  });
});
