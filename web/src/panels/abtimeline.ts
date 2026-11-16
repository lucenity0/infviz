// A/B timeline: both runs on ONE wall-clock axis (seconds since each run's first step).
// Track 1: tokens committed over time, one line per run (A dashed, B solid).
// Tracks 2-3: one bar per engine step, spanning its wall time; height = tokens committed
// that step; red hatching on top = draft tokens rejected that step (discarded work).
// Drag anywhere to scrub the shared clock.
import type { Clock } from '../compare';
import type { InfvizEvent } from '../events';
import { C, TYPE, hatch } from '../tokens';
import { fitCanvas } from '../ui';

const GUTTER = 208;
const RULER = 22;
const PAD_R = 24;

export interface AbRun {
  name: string;
  clock: Clock;
  /** per step: [begin s, end s, tokens committed, drafts rejected] */
  bars: [number, number, number, number][];
  /** cumulative tokens at each step end: [end s, total] */
  cum: [number, number][];
  tokens: number;
}

export function abRun(name: string, events: InfvizEvent[], clock: Clock): AbRun {
  const k = (events.find((e) => e.type === 'config') as { spec_k?: number } | undefined)?.spec_k ?? 0;
  const byStep = new Map<number, [number, number]>();
  for (const e of events) {
    if (e.type === 'token') {
      const v = byStep.get(e.step) ?? [0, 0];
      v[0]++;
      byStep.set(e.step, v);
    } else if (e.type === 'verify') {
      const v = byStep.get(e.step) ?? [0, 0];
      v[1] += k - e.n_accepted;
      byStep.set(e.step, v);
    }
  }
  const bars: AbRun['bars'] = [];
  const cum: AbRun['cum'] = [[0, 0]];
  let total = 0;
  for (const s of clock.steps) {
    const [tok, rej] = byStep.get(s.step) ?? [0, 0];
    bars.push([s.begin - clock.steps[0].begin, s.end - clock.steps[0].begin, tok, rej]);
    total += tok;
    cum.push([s.end - clock.steps[0].begin, total]);
  }
  return { name, clock, bars, cum, tokens: total };
}

export class AbTimeline {
  private canvas: HTMLCanvasElement;
  private x0 = GUTTER;
  private pxPerSec = 1;
  private dragging = false;
  onScrub: (sec: number) => void = () => {};

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="head"><span class="title">Wall clock</span><span class="sub">seconds since each run's first step</span><span class="grow"></span>
        <div class="legend">
          <span class="key lab"><i class="sw ab-a"></i>A</span>
          <span class="key lab"><i class="sw ab-b"></i>B</span>
          <span class="key lab" data-term="discarded"><i class="sw rej"></i>Rejected drafts</span>
        </div></div>
      <div class="plot"><canvas aria-label="Both runs on one time axis: drag to scrub"></canvas></div>`;
    this.canvas = root.querySelector('canvas')!;
    const c = this.canvas;
    const at = (x: number) => Math.max(0, (x - this.x0) / this.pxPerSec);
    c.addEventListener('pointerdown', (e) => {
      if (e.offsetX < GUTTER) return;
      this.dragging = true;
      c.setPointerCapture(e.pointerId);
      this.onScrub(at(e.offsetX));
    });
    c.addEventListener('pointermove', (e) => this.dragging && this.onScrub(at(e.offsetX)));
    c.addEventListener('pointerup', () => (this.dragging = false));
  }

  render(runs: [AbRun, AbRun], sec: number) {
    const { w, h, dpr } = fitCanvas(this.canvas);
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.textBaseline = 'middle';
    const end = Math.max(...runs.map((r) => (r.bars.length ? r.bars[r.bars.length - 1][1] : 0)), 1);
    const plotW = w - GUTTER - PAD_R;
    this.pxPerSec = plotW / end;
    const X = (s: number) => GUTTER + s * this.pxPerSec;

    // layout: ruler, tokens track (half), two step strips
    const avail = h - RULER;
    const tokH = Math.max(60, Math.round(avail * 0.5));
    const stripH = Math.max(28, Math.floor((avail - tokH) / 2));
    const yTok = RULER,
      yA = yTok + tokH,
      yB = yA + stripH;

    // gutter + hairlines
    ctx.fillStyle = C.hair;
    ctx.fillRect(GUTTER - 1, 0, 1, h);
    ctx.fillRect(0, RULER - 1, w, 1);
    ctx.fillRect(0, yA - 1, w, 1);
    ctx.fillRect(0, yB - 1, w, 1);

    // ruler + grid
    const every = end > 30 ? 5 : end > 12 ? 2 : 1;
    ctx.font = `400 ${TYPE.micro}px ${TYPE.mono}`;
    const phx = X(sec);
    for (let t = 0; t <= end + 1e-9; t += every) {
      const x = Math.round(X(t));
      ctx.fillStyle = C.grid;
      ctx.fillRect(x, RULER, 1, h - RULER);
      const lab = `${t} s`;
      const lw = ctx.measureText(lab).width;
      if (x + 4 + lw > phx - 30 && x + 4 < phx + 30) continue;
      ctx.fillStyle = C.ink3;
      ctx.fillText(lab, x + 4, RULER / 2 + 1);
    }

    // labels + live readouts
    const tokensAt = (r: AbRun) => {
      let n = 0;
      for (const [t, c] of r.cum) if (t <= sec) n = c;
      return n;
    };
    this.label(ctx, 'Tokens committed', 16, yTok + 14);
    ctx.font = `400 ${TYPE.small}px ${TYPE.mono}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = C.ink2;
    ctx.fillText(`A ${tokensAt(runs[0])}`, GUTTER - 12, yTok + 34);
    ctx.fillStyle = C.ink;
    ctx.fillText(`B ${tokensAt(runs[1])}`, GUTTER - 12, yTok + 52);
    ctx.textAlign = 'left';
    runs.forEach((r, i) => {
      const y = i === 0 ? yA : yB;
      this.label(ctx, `${i === 0 ? 'A' : 'B'} · steps`, 16, y + stripH / 2);
      ctx.font = `400 ${TYPE.small}px ${TYPE.mono}`;
      ctx.fillStyle = i === 0 ? C.ink2 : C.ink;
      ctx.textAlign = 'right';
      const n = r.bars.filter((b) => b[0] <= sec).length;
      ctx.fillText(`${n}/${r.bars.length}`, GUTTER - 12, y + stripH / 2);
      ctx.textAlign = 'left';
    });

    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, 0, w - GUTTER, h);
    ctx.clip();

    // tokens over time: A dashed ink2, B solid ink; future part faded
    const maxTok = Math.max(...runs.map((r) => r.tokens), 1);
    const Yt = (n: number) => yTok + tokH - 10 - (n / maxTok) * (tokH - 22);
    runs.forEach((r, i) => {
      ctx.strokeStyle = i === 0 ? C.ink2 : C.ink;
      ctx.lineWidth = 2;
      ctx.setLineDash(i === 0 ? [6, 4] : []);
      const line = (pts: [number, number][]) => {
        ctx.beginPath();
        pts.forEach(([t, c], j) => (j ? ctx.lineTo(X(t), Yt(c)) : ctx.moveTo(X(t), Yt(c))));
        ctx.stroke();
      };
      ctx.globalAlpha = 0.3;
      line(r.cum);
      ctx.globalAlpha = 1;
      const past = r.cum.filter(([t]) => t <= sec);
      const nxt = r.cum.find(([t]) => t > sec);
      if (nxt && past.length) {
        const [t0, c0] = past[past.length - 1];
        past.push([sec, c0 + ((nxt[1] - c0) * (sec - t0)) / (nxt[0] - t0)]);
      }
      if (past.length > 1) line(past);
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      // end label
      const [te, ce] = r.cum[r.cum.length - 1];
      ctx.font = `500 ${TYPE.small}px ${TYPE.mono}`;
      ctx.fillStyle = i === 0 ? C.ink2 : C.ink;
      const lab = `${i === 0 ? 'A' : 'B'} done ${te.toFixed(1)} s`;
      const lw = ctx.measureText(lab).width;
      ctx.fillText(lab, Math.min(X(te) - lw / 2, w - PAD_R - lw), Yt(ce) - 12);
    });

    // step strips
    runs.forEach((r, i) => {
      const y = i === 0 ? yA : yB;
      let maxBar = 1;
      for (const b of r.bars) maxBar = Math.max(maxBar, b[2] + b[3]);
      const scale = (stripH - 10) / maxBar;
      const base = y + stripH - 4;
      for (const [b0, b1, tok, rej] of r.bars) {
        const x = X(b0),
          bw = Math.max(1, X(b1) - x - 1);
        const fut = b0 > sec;
        ctx.globalAlpha = fut ? 0.3 : 1;
        ctx.fillStyle = i === 0 ? C.ink3 : C.ink2;
        const th = tok * scale;
        ctx.fillRect(x, base - th, bw, th);
        if (rej) {
          ctx.fillStyle = hatch(ctx, C.discard, dpr);
          ctx.fillRect(x, base - th - rej * scale, bw, rej * scale);
        }
      }
      ctx.globalAlpha = 1;
    });
    ctx.restore();

    // playhead
    const px = Math.round(phx) + 0.5;
    ctx.fillStyle = C.ink;
    ctx.fillRect(px - 0.5, 0, 1, h);
    const label = `${sec.toFixed(2)} s`;
    ctx.font = `500 ${TYPE.micro}px ${TYPE.mono}`;
    const tw = ctx.measureText(label).width + 8;
    const tx = Math.min(w - tw, Math.max(GUTTER, px - tw / 2));
    ctx.fillRect(tx, 2, tw, RULER - 6);
    ctx.fillStyle = C.bg;
    ctx.textAlign = 'center';
    ctx.fillText(label, tx + tw / 2, RULER / 2 - 1);
    ctx.textAlign = 'left';
  }

  private label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
    ctx.font = `500 ${TYPE.micro}px ${TYPE.sans}`;
    ctx.fillStyle = C.ink3;
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '1.2px';
    ctx.fillText(text.toUpperCase(), x, y);
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px';
  }
}
