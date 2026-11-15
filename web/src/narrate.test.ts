import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseJsonl } from './events';
import { list, narrateStep } from './narrate';
import { Timeline } from './timeline';

const path = process.env.TRACE ?? resolve(__dirname, '../public/mock.jsonl');
const events = parseJsonl(readFileSync(path, 'utf8'));
const cfg = events[0] as any;

describe(`narrate: ${path}`, () => {
  const tl = new Timeline();
  tl.reset(events);
  events.forEach((e, i) => tl.add(e, i));
  tl.sealed = true;

  it('lists ids in plain English', () => {
    expect(list([1])).toBe('r1');
    expect(list([1, 2])).toBe('r1 and r2');
    expect(list([1, 2, 3])).toBe('r1, r2 and r3');
  });

  it('says something about every step that ran, and mentions every preemption and finish', () => {
    let pre = 0, fin = 0;
    for (const rec of tl.steps) {
      const [a, b] = tl.groupRange(rec.step);
      const st = narrateStep(events, a, b, cfg.block_size, cfg.spec_k);
      expect(st.lines.length, `step ${rec.step}`).toBeGreaterThan(0);
      for (const l of st.lines) expect(l.text).not.toMatch(/undefined|NaN/);
      pre += st.lines.filter((l) => l.kind === 'preempt').length;
      fin += st.lines.filter((l) => l.kind === 'finish').length;
    }
    expect(pre).toBe(events.filter((e) => e.type === 'req_preempt').length);
    expect(fin).toBe(events.filter((e) => e.type === 'req_finish').length);
  });

  it('counts accepted drafts exactly', () => {
    for (const rec of tl.steps) {
      const [a, b] = tl.groupRange(rec.step);
      const st = narrateStep(events, a, b, cfg.block_size, cfg.spec_k);
      const spec = st.lines.find((l) => l.kind === 'spec');
      if (spec) expect(spec.text).toContain(`kept ${rec.accepted},`);
    }
  });
});
