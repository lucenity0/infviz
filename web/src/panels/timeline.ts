// The shared time axis. One canvas, one x-scale (engine steps), one playhead cutting
// through every track:
//   ruler       step numbers
//   STEP TIME   wall ms per engine step
//   KV TARGET   used / cached blocks after each step (pool occupancy)
//   SPECULATION accepted (solid) vs rejected (hatched) draft tokens per step
//   lanes       one row per request: waiting (dotted), prefill (block), decode ticks
//               (height = tokens committed that step), preempt (×), finish (cap)
// Drag anywhere to scrub. Replay shows the whole trace faintly ahead of the playhead.
import type { Player } from '../player';
import { selection } from '../select';
import type { ReqInfo, State } from '../reducer';
import type { StepRec } from '../timeline';
import { C, hatch, reqColor, rgba, TYPE } from '../tokens';
import { esc, fitCanvas, fitText, outlined, snippet, tip } from '../ui';

const GUTTER = 208; // label column
const RULER = 22;
const TRACK = 30;
const LANE = 18;
const PAD_R = 16;
const MIN_PX_PER_STEP = 6;
const FINISHED_SHOWN = 4;

interface Row {
  kind: 'lane' | 'more';
  rid: number;
  more?: number;
}

export class TimelinePanel {
  private canvas: HTMLCanvasElement;
  private sub: HTMLElement;
  private overlay: HTMLElement;
  private player: Player | null = null;
  private x0 = 0;
  private pxPerStep = 8;
  private s0 = 0; // first visible step
  private rows: Row[] = [];
  private lanesTop = 0;
  private scrollY = 0;
  private dragging = false;
  private hoverY = -1;
  private showAllFinished = false;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="head">
        <span class="title" data-term="batch">${outlined('TIMELINE', 'Timeline')}</span><span class="sub" data-sub></span>
        <span class="grow"></span>
        <div class="legend">
          <span class="key lab" data-term="waiting"><i class="sw lane-wait"></i>Waiting</span>
          <span class="key lab" data-term="prefill"><i class="sw lane-pre"></i>Prefill</span>
          <span class="key lab" data-term="decode"><i class="sw lane-dec"></i>Decode</span>
          <span class="key lab" data-term="accepted"><i class="sw acc"></i>Accepted</span>
          <span class="key lab" data-term="reject"><i class="sw rej"></i>Rejected / preempted</span>
        </div>
      </div>
      <div class="plot"><canvas aria-label="Timeline: drag to scrub"></canvas><div class="state" data-overlay hidden></div></div>`;
    this.canvas = root.querySelector('canvas')!;
    this.sub = root.querySelector('[data-sub]')!;
    this.overlay = root.querySelector('[data-overlay]')!;
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (e.offsetX < GUTTER) return this.clickGutter(e.offsetY);
      this.dragging = true;
      c.setPointerCapture(e.pointerId);
      this.scrubTo(e.offsetX);
    });
    c.addEventListener('pointermove', (e) => {
      this.hoverY = e.offsetY;
      c.style.cursor = e.offsetX < GUTTER && e.offsetY >= this.lanesTop ? 'pointer' : '';
      if (this.dragging) this.scrubTo(e.offsetX);
      else this.hoverTip(e);
    });
    c.addEventListener('pointerup', () => (this.dragging = false));
    c.addEventListener('pointerleave', () => {
      this.hoverY = -1;
      tip.hide();
    });
    c.addEventListener(
      'wheel',
      (e) => {
        if (e.offsetY < this.lanesTop) return;
        this.scrollY = Math.max(0, this.scrollY + e.deltaY);
        e.preventDefault();
      },
      { passive: false },
    );
  }

  private scrubTo(x: number) {
    const p = this.player;
    if (!p) return;
    p.seek(this.s0 + (x - this.x0) / this.pxPerStep);
  }

  private clickGutter(y: number) {
    const i = Math.floor((y - this.lanesTop + this.scrollY) / LANE);
    const row = this.rows[i];
    if (row?.kind === 'more') this.showAllFinished = !this.showAllFinished;
    else if (row?.kind === 'lane') selection.toggle(row.rid);
  }

  private buildRows(s: State) {
    const rows: Row[] = [];
    const fin = s.finished.slice().reverse();
    const shownFin = this.showAllFinished ? fin : fin.slice(0, FINISHED_SHOWN);
    for (const rid of s.running) rows.push({ kind: 'lane', rid });
    for (const rid of s.waiting) rows.push({ kind: 'lane', rid });
    for (const rid of shownFin) rows.push({ kind: 'lane', rid });
    if (fin.length > FINISHED_SHOWN)
      rows.push({ kind: 'more', rid: -1, more: this.showAllFinished ? -1 : fin.length - FINISHED_SHOWN });
    this.rows = rows;
  }

  render(player: Player) {
    this.player = player;
    const s = player.state;
    const { w, h, dpr } = fitCanvas(this.canvas);
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const tl = player.timeline;
    // the axis starts at the first recorded step (a live join may begin mid-run)
    const first = tl.steps.length ? Math.max(0, tl.steps[0].step - 1) : 0;
    const total = Math.max(tl.maxStep + 1, first + 24);
    const span = total - first;
    const plotW = w - GUTTER - PAD_R;
    this.x0 = GUTTER;
    // fit the whole run if it fits; otherwise a window that keeps the playhead at 75%
    if (plotW / span >= MIN_PX_PER_STEP) {
      this.pxPerStep = plotW / span;
      this.s0 = first;
    } else {
      this.pxPerStep = MIN_PX_PER_STEP;
      const vis = plotW / MIN_PX_PER_STEP;
      this.s0 = Math.max(first, Math.min(total - vis, player.pos - vis * 0.75));
    }
    const X = (step: number) => this.x0 + (step - this.s0) * this.pxPerStep;
    const pos = player.pos;
    const sw = this.pxPerStep;
    this.sub.textContent = `${Math.max(0, Math.ceil(pos) - 1)} / ${tl.maxStep} steps`;
    this.overlay.hidden = tl.steps.length > 0 || !s.config;
    if (!this.overlay.hidden && !this.overlay.innerHTML)
      this.overlay.innerHTML = `<div class="card"><div class="msg">No engine steps yet</div><div class="hint">Steps appear here as the scheduler runs.</div></div>`;

    ctx.font = `400 ${TYPE.small}px ${TYPE.mono}`;
    ctx.textBaseline = 'middle';

    // ---- gutter + hairlines
    ctx.fillStyle = C.hair;
    ctx.fillRect(GUTTER - 1, 0, 1, h);
    let y = RULER;
    const tracks = [
      { label: 'Step time', key: 'ms' },
      { label: 'KV target', key: 'kv' },
      { label: 'Speculation', key: 'spec' },
    ] as const;
    const curRec = tl.rec(Math.max(0, Math.ceil(pos) - 1));
    ctx.fillRect(0, RULER - 1, w, 1);
    for (const t of tracks) {
      this.microLabel(ctx, t.label, 16, y + TRACK / 2);
      ctx.fillStyle = C.ink2;
      ctx.textAlign = 'right';
      ctx.font = `400 ${TYPE.small}px ${TYPE.mono}`;
      ctx.fillText(this.trackValue(t.key, curRec, tl.nBlocks), GUTTER - 12, y + TRACK / 2);
      ctx.textAlign = 'left';
      y += TRACK;
      ctx.fillStyle = C.hair;
      ctx.fillRect(0, y - 1, w, 1);
    }
    this.lanesTop = y;

    // ---- ruler
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, 0, w - GUTTER, h);
    ctx.clip();
    const every = sw >= 18 ? 5 : sw >= 9 ? 10 : 20;
    ctx.font = `400 ${TYPE.micro}px ${TYPE.mono}`;
    const phx = X(pos);
    for (let st = Math.ceil(this.s0 / every) * every; st <= total; st += every) {
      const x = X(st);
      ctx.fillStyle = C.grid;
      if (tl.steps.length) ctx.fillRect(Math.round(x), RULER, 1, h - RULER); // no grid under the empty-state card
      const lw = ctx.measureText(String(st)).width;
      if (x + 4 + lw > phx - 22 && x + 4 < phx + 22) continue; // never under the playhead tag
      ctx.fillStyle = C.ink3;
      ctx.fillText(String(st), Math.round(x) + 4, RULER / 2 + 1);
    }

    // ---- tracks
    const k = s.config?.spec_k || 1;
    let maxProp = 1;
    for (const r of tl.steps) maxProp = Math.max(maxProp, r.proposed);
    const pr = this.trackY(0);
    for (const rec of tl.steps) {
      const x = X(rec.step);
      if (x + sw < GUTTER || x > w) continue;
      const future = rec.step + 1 > pos;
      if (future && player.mode === 'live') continue;
      ctx.globalAlpha = future ? 0.22 : 1;
      const bw = Math.max(1, sw - (sw > 4 ? 1 : 0));
      // step time
      if (rec.ms !== null) {
        const hh = Math.max(1, ((TRACK - 8) * rec.ms) / tl.maxMs);
        ctx.fillStyle = C.ink3;
        ctx.fillRect(x, pr + TRACK - 4 - hh, bw, hh);
      }
      // kv occupancy
      if (rec.kv) {
        const n = tl.nBlocks || 1;
        const base = this.trackY(1) + TRACK - 4,
          span = TRACK - 8;
        const hu = (span * rec.kv.used) / n,
          hc = (span * rec.kv.cached) / n;
        ctx.fillStyle = C.ink2;
        ctx.fillRect(x, base - hu, bw, hu);
        ctx.fillStyle = C.cached;
        ctx.fillRect(x, base - hu - hc, bw, hc);
      }
      // speculation
      if (rec.proposed > 0) {
        const base = this.trackY(2) + TRACK - 4,
          span = TRACK - 8;
        const ha = (span * rec.accepted) / maxProp,
          hr = (span * (rec.proposed - rec.accepted)) / maxProp;
        ctx.fillStyle = C.ink;
        ctx.fillRect(x, base - ha, bw, ha);
        ctx.fillStyle = hatch(ctx, C.discard, dpr, 3);
        ctx.fillRect(x, base - ha - hr, bw, hr);
      }
      ctx.globalAlpha = 1;
    }
    void k;

    // ---- lanes
    this.buildRows(s);
    const maxScroll = Math.max(0, this.rows.length * LANE - (h - this.lanesTop));
    this.scrollY = Math.min(this.scrollY, maxScroll);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, this.lanesTop, w, h - this.lanesTop);
    ctx.clip();
    this.rows.forEach((row, i) => {
      const ly = this.lanesTop + i * LANE - this.scrollY;
      if (ly + LANE < this.lanesTop || ly > h) return;
      if (row.kind === 'more') {
        ctx.font = `500 ${TYPE.micro}px ${TYPE.sans}`;
        ctx.fillStyle = C.ink3;
        ctx.fillText(
          row.more! < 0 ? 'COLLAPSE FINISHED' : `+ ${row.more} EARLIER FINISHED`,
          16,
          ly + LANE / 2,
        );
        return;
      }
      this.lane(ctx, s, s.reqs[row.rid], ly, X, w, pos, player, dpr);
    });
    ctx.restore();

    // ---- playhead: one line through ruler, tracks and lanes
    const px = Math.round(X(pos)) + 0.5;
    if (px >= GUTTER && px <= w) {
      ctx.fillStyle = C.ink;
      ctx.fillRect(px - 0.5, 0, 1, h);
      const label = `${Math.max(0, Math.ceil(pos) - 1)}`;
      ctx.font = `500 ${TYPE.micro}px ${TYPE.mono}`;
      const tw = ctx.measureText(label).width + 8;
      const tx = Math.min(w - tw, Math.max(GUTTER, px - tw / 2));
      ctx.fillRect(tx, 2, tw, RULER - 6);
      ctx.fillStyle = C.bg;
      ctx.textAlign = 'center';
      ctx.fillText(label, tx + tw / 2, RULER / 2 - 1);
      ctx.textAlign = 'left';
    }
  }

  private trackY(i: number) {
    return RULER + i * TRACK;
  }

  private trackValue(key: 'ms' | 'kv' | 'spec', rec: StepRec | undefined, n: number): string {
    if (!rec) return '—';
    if (key === 'ms') return rec.ms === null ? '—' : `${rec.ms.toFixed(0)} ms`;
    if (key === 'kv') return rec.kv ? `${rec.kv.used + rec.kv.cached}/${n}` : '—';
    return rec.proposed ? `${rec.accepted}/${rec.proposed}` : '—';
  }

  private microLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
    ctx.font = `500 ${TYPE.micro}px ${TYPE.sans}`;
    ctx.fillStyle = C.ink3;
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '1.2px';
    ctx.fillText(text.toUpperCase(), x, y);
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px';
  }

  private lane(
    ctx: CanvasRenderingContext2D,
    s: State,
    r: ReqInfo | undefined,
    ly: number,
    X: (s: number) => number,
    w: number,
    pos: number,
    player: Player,
    dpr: number,
  ) {
    if (!r) return;
    const hue = reqColor(r.colorSlot);
    const mid = ly + LANE / 2;
    const active = r.status === 'running';
    // gutter label: swatch, id, prompt
    ctx.fillStyle = r.status === 'finished' ? rgba(hue, 0.45) : hue;
    ctx.fillRect(16, mid - 4, 8, 8);
    ctx.font = `500 ${TYPE.small}px ${TYPE.mono}`;
    ctx.fillStyle = r.status === 'finished' ? C.ink3 : C.ink;
    ctx.fillText(`r${r.rid}`, 30, mid);
    ctx.font = `400 ${TYPE.small}px ${TYPE.sans}`;
    ctx.fillStyle = C.ink3;
    const status = r.status === 'waiting' ? 'queued' : r.status === 'finished' ? (r.finishReason ?? '') : '';
    const sw = status ? ctx.measureText(status).width + 8 : 0;
    ctx.fillText(fitText(ctx, snippet(r.prompt_text), GUTTER - 64 - sw - 12), 60, mid);
    if (status) {
      ctx.textAlign = 'right';
      ctx.fillText(status, GUTTER - 12, mid);
      ctx.textAlign = 'left';
    }
    if (selection.rid === r.rid) {
      ctx.fillStyle = rgba(C.ink, 0.07);
      ctx.fillRect(0, ly, w, LANE);
      ctx.fillStyle = C.ink;
      ctx.fillRect(0, ly, 2, LANE);
    } else if (this.hoverY >= ly && this.hoverY < ly + LANE) {
      ctx.fillStyle = rgba(C.ink, 0.04);
      ctx.fillRect(0, ly, w, LANE);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, ly, w - GUTTER, LANE);
    ctx.clip();
    const curStep = pos; // lanes show only the past
    // waiting spans (dotted)
    const admits = r.admitSteps,
      preempts = r.preemptSteps;
    const waits: [number, number][] = [];
    let from = r.arriveStep;
    for (const a of admits) {
      waits.push([from, a]);
      const p = preempts.find((x) => x >= a);
      if (p === undefined) {
        from = -1;
        break;
      }
      from = p;
    }
    if (from >= 0 && r.status === 'waiting') waits.push([from, curStep]);
    ctx.fillStyle = C.ink3;
    for (const [a, b] of waits) {
      for (let x = X(a); x < X(b); x += 4) ctx.fillRect(x, mid, 1.5, 1);
    }
    // running background band
    const start = admits.length ? admits[0] : null;
    if (start !== null) {
      const end = r.finishStep !== null ? r.finishStep + 1 : curStep;
      ctx.fillStyle = rgba(hue, active ? 0.1 : 0.05);
      ctx.fillRect(X(start), ly + 2, X(end) - X(start), LANE - 4);
    }
    // per-step marks (only steps whose events are applied)
    const tl = player.timeline;
    const bw = Math.max(1, this.pxPerStep - (this.pxPerStep > 4 ? 1 : 0));
    const k1 = (s.config?.spec_k ?? 0) + 1;
    for (const rec of tl.steps) {
      if (rec.beginIdx >= player.cursor) break;
      const x = X(rec.step);
      if (x + bw < GUTTER || x > w) continue;
      const be = rec.batch.find((b) => b.rid === r.rid);
      if (!be) continue;
      if (be.phase === 'prefill') {
        ctx.fillStyle = hue;
        ctx.fillRect(x, ly + 3, bw, LANE - 6);
      } else {
        const n = tl.committed(rec, r.rid, player.cursor);
        const hh = Math.max(2, ((LANE - 6) * Math.min(n, k1)) / k1);
        ctx.fillStyle = hue;
        ctx.fillRect(x, ly + LANE - 3 - hh, bw, hh);
      }
    }
    // preempt marks: discarded work
    for (const p of preempts) {
      const x = X(p) + this.pxPerStep / 2;
      ctx.strokeStyle = C.discard;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 3.5, mid - 3.5);
      ctx.lineTo(x + 3.5, mid + 3.5);
      ctx.moveTo(x + 3.5, mid - 3.5);
      ctx.lineTo(x - 3.5, mid + 3.5);
      ctx.stroke();
    }
    // finish cap
    if (r.finishStep !== null) {
      ctx.fillStyle = C.ink2;
      ctx.fillRect(X(r.finishStep + 1) - 1, ly + 3, 2, LANE - 6);
    }
    void dpr;
    ctx.restore();
  }

  private hoverTip(e: PointerEvent) {
    const p = this.player;
    if (!p) return;
    const s = p.state;
    const step = Math.floor(this.s0 + (e.offsetX - this.x0) / this.pxPerStep);
    if (e.offsetY >= this.lanesTop) {
      const row = this.rows[Math.floor((e.offsetY - this.lanesTop + this.scrollY) / LANE)];
      const r = row?.kind === 'lane' ? s.reqs[row.rid] : undefined;
      if (!r) return tip.hide();
      const acc = r.proposed ? `${Math.round((100 * r.accepted) / r.proposed)}% of ${r.proposed} drafts accepted` : '';
      tip.show(
        `<span class="lab">request r${r.rid} · ${r.status}</span><b>${esc(snippet(r.prompt_text).slice(0, 90))}</b><br/>prompt ${r.prompt_len} tok · out ${r.nTokens}/${r.max_new_tokens}<br/>arrived ${r.arriveStep} · admitted ${r.admitSteps.join(', ') || '—'}${r.preemptSteps.length ? ` · preempted ${r.preemptSteps.join(', ')}` : ''}${r.finishStep !== null ? ` · finished ${r.finishStep} (${r.finishReason})` : ''}${acc ? '<br/>' + acc : ''}${e.offsetX < GUTTER ? '<br/><span class="dim">click to inspect</span>' : ''}`,
        e.clientX,
        e.clientY,
      );
      return;
    }
    const rec = p.timeline.rec(step);
    if (!rec || e.offsetX < GUTTER) return tip.hide();
    const pre = rec.batch.filter((b) => b.phase === 'prefill').length;
    tip.show(
      `<span class="lab">step ${rec.step}</span><b>${rec.batch.length}</b> lanes (${pre} prefill, ${rec.batch.length - pre} decode)<br/>${rec.nTokens ?? '—'} tokens computed · ${rec.ms?.toFixed(1) ?? '—'} ms<br/>KV ${rec.kv ? `${rec.kv.used} used · ${rec.kv.cached} cached · ${rec.kv.free} free` : '—'}<br/>drafts ${rec.accepted}/${rec.proposed} accepted`,
      e.clientX,
      e.clientY,
    );
  }
}
