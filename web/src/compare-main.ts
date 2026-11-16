// Compare page: run A and run B on ONE wall-clock axis. A single shared clock (seconds
// since each run's first step) drives two replay players through timeToPos(); every
// panel still renders purely from (state, pos), so scrubbing is exact on both sides.
import { clockOf, outputMatch, ratio, summarize, timeToPos, type RunSummary } from './compare';
import { parseJsonl, type InfvizEvent } from './events';
import { fontsReady } from './fonts';
import { AbTimeline, abRun, type AbRun } from './panels/abtimeline';
import { KvPanel } from './panels/kv';
import { Player } from './player';
import { showSplash } from './splash';
import { applyTokens } from './tokens';
import { esc, outlined, reduceMotion, shortModel } from './ui';

const q = new URLSearchParams(location.search);
applyTokens(q.get('theme') === 'light' ? 'light' : 'dark');
const poster = q.has('poster');
if (poster) document.documentElement.classList.add('poster');
if (q.get('theme') === 'light') document.querySelector<HTMLAnchorElement>('a[href="./"]')?.setAttribute('href', './?theme=light');

const SPEEDS = [0.25, 0.5, 1, 2, 4];
const $ = (id: string) => document.getElementById(id)!;

function describe(s: RunSummary): string {
  const mode = s.draft ? `speculation, k = ${s.k}` : 'plain decoding';
  return s.temperature > 0 ? `${mode}, T ${s.temperature}` : mode;
}

async function load(url: string): Promise<InfvizEvent[]> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const ev = parseJsonl(await r.text());
  if (ev[0]?.type !== 'config') throw new Error(`${url}: not an infviz trace`);
  return ev;
}

function statsHtml(a: RunSummary, b: RunSummary, device: string): string {
  const m = outputMatch(a, b);
  const f = (v: number | null, d = 2) => (v === null || Number.isNaN(v) ? '—' : v.toFixed(d));
  const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
  const rel = (bv: number, av: number, better: 'up' | 'down') => {
    const r = ratio(bv, av);
    if (!Number.isFinite(r)) return '';
    const good = better === 'up' ? r > 1.005 : r < 0.995;
    const bad = better === 'up' ? r < 0.995 : r > 1.005;
    return `<span class="d ${good ? 'good' : bad ? 'bad' : ''}">${r.toFixed(2)}×</span>`;
  };
  const row = (lab: string, term: string, av: string, bv: string, d = '') =>
    `<tr${term ? ` data-term="${term}"` : ''}><th class="lab">${lab}</th><td class="num">${av}</td><td class="num">${bv}</td><td class="num">${d}</td></tr>`;
  return `
    <div class="head"><span class="title">${outlined('A AGAINST B', 'A against B')}</span><span class="sub">one recording each · ${esc(device)}</span></div>
    <table class="ab">
      <thead><tr><th></th><th class="lab">A · ${esc(describe(a))}</th><th class="lab">B · ${esc(describe(b))}</th><th class="lab">B ÷ A</th></tr></thead>
      <tbody>
        ${row('Wall time', '', `${f(a.seconds)} s`, `${f(b.seconds)} s`, rel(b.seconds, a.seconds, 'down'))}
        ${row('Tokens / s', '', f(a.tokPerSec, 1), f(b.tokPerSec, 1), rel(b.tokPerSec, a.tokPerSec, 'up'))}
        ${row('Engine steps', 'step', String(a.steps), String(b.steps), rel(b.steps, a.steps, 'down'))}
        ${row('Tok / pass', 'tokpass', f(a.tokPerPass ?? 1), f(b.tokPerPass ?? 1))}
        ${row('Draft accepted', 'accepted', pct(a.acceptance), pct(b.acceptance))}
        ${row('Prefix-cache hits', 'prefix', String(a.prefixHits), String(b.prefixHits))}
        ${row('Evictions · preemptions', 'preempt', `${a.evictions} · ${a.preemptions}`, `${b.evictions} · ${b.preemptions}`)}
      </tbody>
    </table>
    <p class="note">${m.same} of ${m.total} responses are identical token for token${m.same < m.total ? ' (bf16 rounding flips near-ties; see README §4)' : ''}. Fewer steps is not less time: compare the first two rows. Colours are assigned per run; click a block to highlight that request on both sides.</p>`;
}

async function main() {
  const splash = poster || q.has('nosplash') ? null : showSplash('two runs · one wall clock');
  try {
    await run();
  } finally {
    splash?.finish();
  }
}

async function run() {
  const fa = q.get('a') ?? 'ab-plain.jsonl';
  const fb = q.get('b') ?? 'ab-spec.jsonl';
  let A: InfvizEvent[], B: InfvizEvent[];
  try {
    [A, B] = await Promise.all([load(fa), load(fb)]);
  } catch (e) {
    const t = $('toast');
    t.textContent = `Could not load the pair: ${e}`;
    t.hidden = false;
    return;
  }
  const sa = summarize(A, fa),
    sb = summarize(B, fb);
  const ca = clockOf(A),
    cb = clockOf(B);
  const pa = new Player(),
    pb = new Player();
  pa.load(A, fa, 'replay');
  pb.load(B, fb, 'replay');
  const runs: [AbRun, AbRun] = [abRun('A', A, ca), abRun('B', B, cb)];
  const end = Math.max(sa.seconds, sb.seconds);

  const kvA = new KvPanel($('kvA'), `A · ${describe(sa)}`);
  const kvB = new KvPanel($('kvB'), `B · ${describe(sb)}`);
  const tl = new AbTimeline($('ctl'));
  const cfgA = A[0] as Extract<InfvizEvent, { type: 'config' }>;
  $('stats').innerHTML = statsHtml(sa, sb, cfgA.device);
  $('cstatus').innerHTML = `
    <div class="seg brand"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="0" y="0" width="6" height="6" fill="currentColor"/><rect x="8" y="0" width="6" height="6" fill="currentColor"/><rect x="0" y="8" width="6" height="6" fill="currentColor"/><rect x="8.5" y="8.5" width="5" height="5" fill="none" stroke="currentColor"/></svg><b>${outlined('infviz')}</b><span class="mode">COMPARE</span></div>
    <div class="seg"><span class="lab">A</span><span class="v ell">${esc(fa)}</span></div>
    <div class="seg"><span class="lab">B</span><span class="v ell">${esc(fb)}</span></div>
    <div class="seg"><span class="lab">Target ← draft</span><span class="v ell"><b>${esc(shortModel(sa.model))}</b> ← ${esc(shortModel(sb.draft))}</span></div>
    <div class="seg"><span class="lab">Same workload</span><span class="v ell">${sa.outputs.size} requests · pool ${sa.blocks} · batch ${sa.maxBatch}</span></div>
    <div class="seg flex"></div>`;

  // ---- the shared clock
  let sec = Math.min(end, Math.max(0, Number(q.get('t')) || 0));
  let playing = !poster && q.has('play'); // opens paused, like the single-run page
  let speed = Math.max(0.25, Math.min(4, Number(q.get('speed')) || 1));
  const stepwise = reduceMotion();
  const seek = (s: number) => {
    sec = Math.max(0, Math.min(end, s));
  };
  tl.onScrub = (s) => {
    playing = false;
    seek(s);
  };

  // transport
  const play = $('c-play');
  const speeds = $('c-speeds');
  const sbtn: HTMLButtonElement[] = [];
  for (const x of SPEEDS) {
    const b = document.createElement('button');
    b.className = 'tbtn';
    b.textContent = `${x}×`;
    b.onclick = () => (speed = x);
    speeds.appendChild(b);
    sbtn.push(b);
  }
  const toggle = () => {
    if (!playing && sec >= end) sec = 0;
    playing = !playing;
  };
  play.onclick = toggle;
  $('c-back').onclick = () => ((playing = false), seek(sec - 0.5));
  $('c-fwd').onclick = () => ((playing = false), seek(sec + 0.5));
  addEventListener('keydown', (e) => {
    if (e.key === ' ') (e.preventDefault(), toggle());
    else if (e.key === 'ArrowLeft') ((playing = false), seek(sec - (e.shiftKey ? 2 : 0.5)));
    else if (e.key === 'ArrowRight') ((playing = false), seek(sec + (e.shiftKey ? 2 : 0.5)));
  });

  const note = $('c-note');
  const PLAY = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.8 10.2 6 3 10.2z"/></svg>';
  const PAUSE = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 2h2v8H3zM7 2h2v8H7z"/></svg>';
  let ui = '';
  function renderAt(s: number) {
    seek(s);
    pa.setPos(timeToPos(ca, sec));
    pb.setPos(timeToPos(cb, sec));
    kvA.render(pa);
    kvB.render(pb);
    tl.render(runs, sec);
    const u = `${playing}|${speed}`;
    if (u !== ui) {
      ui = u;
      play.innerHTML = playing ? PAUSE : PLAY;
      sbtn.forEach((b, i) => b.setAttribute('aria-pressed', String(SPEEDS[i] === speed)));
    }
    const sa_ = Math.max(0, Math.ceil(pa.pos) - 1),
      sb_ = Math.max(0, Math.ceil(pb.pos) - 1);
    note.textContent = `${sec.toFixed(2)} s · A at step ${sa_} of ${sa.steps} · B at step ${sb_} of ${sb.steps}`;
  }

  let last = performance.now();
  let acc = 0;
  function frame(now: number) {
    const dt = Math.min(100, now - last);
    last = now;
    if (playing) {
      const d = (dt / 1000) * speed;
      if (stepwise) {
        acc += d;
        if (acc >= 0.5) {
          seek(sec + acc);
          acc = 0;
        }
      } else seek(sec + d);
      if (sec >= end) playing = false;
    }
    renderAt(sec);
    requestAnimationFrame(frame);
  }
  renderAt(sec);
  requestAnimationFrame(frame);
  await fontsReady;
  (window as unknown as { infviz: unknown }).infviz = { renderAt, end, ready: true, pause: () => (playing = false) };
}

main();
