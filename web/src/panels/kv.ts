// KV cache inspector: the target and draft block pools at the playhead.
// Static encoding (state at cursor):
//   free   — recessed empty cells
//   used   — filled cells in the owning request's hue; a notch marks a sequence's first block
//   shared — a prefix block owned by several requests: neutral cells with stacked ghost
//            layers behind it (one per extra owner) and an owner strip underneath
//   cached — kept for prefix reuse, no owner: grey cells
// Motion (pure function of playhead - event time): new tokens flash in, discarded KV
// (speculative rollback) retreats hatched red, evicted blocks dissolve.
import type { InfvizEvent, PoolName } from '../events';
import type { Player } from '../player';
import { selection } from '../select';
import type { Block, State } from '../reducer';
import { C, MOTION, hatch, reqColor, rgba } from '../tokens';
import { clamp01, el, esc, fitCanvas, shortModel, snippet, tip } from '../ui';

interface Geo {
  c: number; // cell px
  cg: number; // gap between cells
  g: number; // cells per block row
  gr: number; // cell rows per block
  bw: number;
  bh: number;
  bgap: number;
  cols: number;
  ox: number;
  oy: number;
}

type Overlay = 'loading' | 'error' | null;

class PoolView {
  root: HTMLElement;
  head: HTMLElement;
  canvas: HTMLCanvasElement;
  geo: Geo | null = null;
  n = 0;
  constructor(
    parent: HTMLElement,
    public name: PoolName,
  ) {
    this.root = el('div', 'pool');
    this.head = el('div', 'phead');
    const plot = el('div', 'plot');
    this.canvas = el('canvas');
    plot.appendChild(this.canvas);
    this.root.append(this.head, plot);
    parent.appendChild(this.root);
  }
}

export class KvPanel {
  private pools: PoolView[] = [];
  private body: HTMLElement;
  private sub: HTMLElement;
  private overlay: HTMLElement;
  private overlayKind = 'none';
  private lastKey = '';
  private player: Player | null = null;
  private hover: { pool: PoolView; block: number } | null = null;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="head">
        <span class="title">KV cache</span><span class="sub" data-sub></span>
        <span class="grow"></span>
        <div class="legend">
          <span class="key lab"><i class="sw used"></i>Owned</span>
          <span class="key lab"><i class="sw shared"></i>Shared prefix</span>
          <span class="key lab"><i class="sw cached"></i>Cached</span>
          <span class="key lab"><i class="sw free"></i>Free</span>
          <span class="key lab"><i class="sw rej"></i>Discarded</span>
        </div>
      </div>
      <div class="pools" data-body></div>
      <div class="state" data-overlay hidden></div>`;
    this.body = root.querySelector('[data-body]')!;
    this.sub = root.querySelector('[data-sub]')!;
    this.overlay = root.querySelector('[data-overlay]')!;
    root.style.position = 'relative';
  }

  setOverlay(kind: Overlay, detail = '') {
    const key = `${kind}|${detail}`;
    if (key === this.overlayKind) return;
    this.overlayKind = key;
    const o = this.overlay;
    o.hidden = !kind;
    o.innerHTML = '';
    const card = (msg: string, hint: string) => `<div class="card"><div class="msg">${msg}</div><div class="hint">${hint}</div></div>`;
    if (kind === 'loading') o.innerHTML = card('Connecting to engine', esc(detail || 'ws /ws · falls back to the bundled trace'));
    if (kind === 'error')
      o.innerHTML = card('Nothing to show', `${esc(detail)}<br/>Start the engine with <code>uv run infviz serve</code>, or drop a <code>.jsonl</code> trace here.`);
  }

  private build(s: State) {
    const cfg = s.config!;
    this.body.innerHTML = '';
    this.pools = [new PoolView(this.body, 'target')];
    if (cfg.pools.draft) this.pools.push(new PoolView(this.body, 'draft'));
    for (const p of this.pools) {
      p.n = p.name === 'target' ? cfg.pools.target.n_blocks : cfg.pools.draft!.n_blocks;
      p.canvas.addEventListener('mousemove', (e) => this.onMove(p, e));
      p.canvas.addEventListener('click', () => {
        const h = this.hover;
        const st = this.player?.state;
        if (!h || !st) return selection.set(null);
        const b = (h.pool.name === 'target' ? st.pools.target : st.pools.draft)?.[h.block];
        if (b && b.state === 'used' && b.owners.length) {
          const cur = selection.rid;
          // shared block: cycle through its owners
          const j = cur !== null ? b.owners.indexOf(cur) : -1;
          selection.set(j >= 0 && b.owners.length > 1 ? b.owners[(j + 1) % b.owners.length] : j >= 0 ? null : b.owners[0]);
        } else selection.set(null);
      });
      p.canvas.addEventListener('mouseleave', () => {
        this.hover = null;
        tip.hide();
      });
    }
  }

  render(player: Player) {
    this.player = player;
    const s = player.state;
    if (!s.config) {
      this.body.innerHTML = '';
      this.pools = [];
      this.lastKey = '';
      return;
    }
    const key = `${player.events.length > 0 ? (player.events[0] as InfvizEvent).t : 0}|${s.config.pools.target.n_blocks}|${s.config.pools.draft?.n_blocks ?? 0}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.build(s);
    }
    const quiet = player.mode === 'live' && !s.running.length && !s.waiting.length;
    this.sub.textContent = `at step ${Math.max(0, Math.ceil(player.pos) - 1)}${quiet ? ' · engine idle' : ''}`;
    // no placard over a drawn grid: an idle engine is stated in the header instead

    // one cell size for both pools so their blocks are directly comparable
    const sizes = this.pools.map((p) => fitCanvas(p.canvas));
    let c = 40;
    const bs = s.config.block_size;
    this.pools.forEach((p, i) => (c = Math.min(c, this.cellFor(p.n, bs, sizes[i].w, sizes[i].h))));
    this.pools.forEach((p, i) => {
      p.geo = this.layout(p.n, bs, sizes[i].w, sizes[i].h, c);
      this.headFor(p, s);
      this.draw(p, s, player, sizes[i].dpr, sizes[i].w, sizes[i].h);
    });
  }

  private headFor(p: PoolView, s: State) {
    const blocks = p.name === 'target' ? s.pools.target : s.pools.draft ?? [];
    let used = 0,
      cached = 0,
      free = 0,
      shared = 0;
    for (const b of blocks) {
      if (b.state === 'used') used++;
      else if (b.state === 'cached') cached++;
      else free++;
      if (b.owners.length > 1) shared++;
    }
    const model = shortModel(p.name === 'target' ? s.config!.models.target : s.config!.models.draft);
    const pct = blocks.length ? Math.round((100 * (used + cached)) / blocks.length) : 0;
    const html = `<span class="lab">${p.name}</span><span class="pm ell">${esc(model)}</span><span class="grow"></span>
      <span class="pr num"><b>${used}</b> used</span><span class="pr num">${shared} shared</span><span class="pr num">${cached} cached</span><span class="pr num">${free} free</span>
      <span class="pr num pct"><b>${pct}%</b></span>`;
    if (p.head.dataset.h !== html) {
      p.head.innerHTML = html;
      p.head.dataset.h = html;
    }
  }

  private cellFor(n: number, bs: number, w: number, h: number): number {
    for (let c = 40; c >= 2; c--) if (this.layout(n, bs, w, h, c)) return c;
    return 2;
  }

  /** biggest cells first; among column counts that fit, match the panel's aspect ratio
   *  and prefer ones that divide the pool evenly (no ragged last row) */
  private layout(n: number, bs: number, w: number, h: number, c: number): Geo | null {
    const g = Math.ceil(Math.sqrt(bs)),
      gr = Math.ceil(bs / g);
    const cg = c >= 5 ? 1 : 0;
    const bw = g * c + (g - 1) * cg,
      bh = gr * c + (gr - 1) * cg;
    const bgap = Math.max(6, Math.round(c * 0.9));
    const padX = 20,
      padY = 14;
    const availW = w - 2 * padX,
      availH = h - 2 * padY;
    const maxCols = Math.floor((availW + bgap) / (bw + bgap));
    let best: { cols: number; score: number } | null = null;
    for (let cols = 1; cols <= Math.min(maxCols, n); cols++) {
      const rows = Math.ceil(n / cols);
      const gh = rows * (bh + bgap) - bgap;
      if (gh > availH) continue;
      const gw = cols * (bw + bgap) - bgap;
      const score = Math.abs(Math.log(gw / gh) - Math.log(availW / availH)) + (n % cols ? 0.35 : 0);
      if (!best || score < best.score) best = { cols, score };
    }
    if (!best) return null;
    const cols = best.cols,
      rows = Math.ceil(n / cols);
    const totalW = cols * (bw + bgap) - bgap,
      totalH = rows * (bh + bgap) - bgap;
    return { c, cg, g, gr, bw, bh, bgap, cols, ox: Math.floor((w - totalW) / 2), oy: Math.max(padY, Math.floor((h - totalH) / 2)) };
  }

  private cellRect(G: Geo, block: number, k: number): [number, number, number, number] {
    const [bx, by] = this.blockXY(G, block);
    const cx = k % G.g,
      cy = Math.floor(k / G.g);
    return [bx + cx * (G.c + G.cg), by + cy * (G.c + G.cg), G.c, G.c];
  }
  private blockXY(G: Geo, block: number): [number, number] {
    const col = block % G.cols,
      row = Math.floor(block / G.cols);
    return [G.ox + col * (G.bw + G.bgap), G.oy + row * (G.bh + G.bgap)];
  }

  private draw(p: PoolView, s: State, player: Player, dpr: number, w: number, h: number) {
    const G = p.geo;
    const ctx = p.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!G) return;
    const bs = s.config!.block_size;
    const blocks: Block[] = (p.name === 'target' ? s.pools.target : s.pools.draft) ?? [];

    // ---- static state at the cursor (an inspected request keeps full contrast; the rest recede)
    const focus = selection.rid;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const [bx, by] = this.blockXY(G, i);
      const base = focus === null || (b.state === 'used' && b.owners.includes(focus)) ? 1 : 0.28;
      ctx.globalAlpha = base;
      const shared = b.state === 'used' && b.owners.length > 1;
      if (shared) {
        // ghost layers: one offset frame per extra owner, so sharing reads as physical stacking
        const layers = Math.min(b.owners.length - 1, 3);
        for (let j = layers; j >= 1; j--) {
          const o = j * Math.max(2, Math.round(G.c * 0.35));
          ctx.strokeStyle = rgba(C.ink3, 0.55 - j * 0.1);
          ctx.lineWidth = 1;
          ctx.strokeRect(bx + o + 0.5, by - o + 0.5, G.bw - 1, G.bh - 1);
          ctx.fillStyle = C.bg;
          ctx.fillRect(bx + o + 1, by - o + 1, G.bw - 2, G.bh - 2);
        }
      }
      const hue =
        b.state === 'used' && b.owners.length === 1 ? reqColor(s.reqs[b.owners[0]]?.colorSlot ?? -1) : null;
      for (let k = 0; k < bs; k++) {
        const [x, y, cw, ch] = this.cellRect(G, i, k);
        let fill: string;
        if (b.state === 'free' || k >= b.filled) fill = C.ink4;
        else if (b.state === 'cached') fill = C.cached;
        else if (shared) fill = C.ink2;
        else fill = hue!;
        ctx.fillStyle = fill;
        if (b.state === 'free' || k >= b.filled) {
          ctx.globalAlpha = base * (b.state === 'free' ? 0.55 : 1);
          ctx.fillRect(x, y, cw, ch);
          ctx.globalAlpha = base;
        } else ctx.fillRect(x, y, cw, ch);
      }
      if (shared) {
        // owner strip: one hue segment per owner, under the block
        const n = b.owners.length;
        const segW = G.bw / n;
        b.owners.forEach((rid, j) => {
          ctx.fillStyle = reqColor(s.reqs[rid]?.colorSlot ?? -1);
          ctx.fillRect(bx + j * segW, by + G.bh + 2, Math.max(1, segW - 1), 2);
        });
      } else if (hue && b.idx === 0) {
        // sequence head notch
        ctx.fillStyle = hue;
        ctx.fillRect(bx - 3, by, 2, G.bh);
      }
      ctx.globalAlpha = 1;
    }

    // ---- motion: every mark below is f(playhead - event time)
    const tl = player.timeline;
    const pos = player.pos;
    const i0 = tl.cursorAt(pos - MOTION.window);
    let rbPool: PoolName | null = null;
    for (let i = i0; i < player.cursor; i++) {
      const ev = player.events[i];
      if (ev.type === 'kv_rollback') {
        rbPool = ev.pool;
        continue;
      }
      if (!ev.type.startsWith('block_')) {
        rbPool = null;
        continue;
      }
      const e = ev as Extract<InfvizEvent, { pool: PoolName; block: number }>;
      if (e.pool !== p.name) continue;
      const age = pos - tl.tau(i);
      const prev = tl.prevFilled.get(i) ?? 0;
      const discard = rbPool === p.name;
      if (e.type === 'block_fill') {
        const f = e.filled;
        if (f > prev) this.cells(ctx, G, e.block, prev, f, C.ink, 0.85 * (1 - clamp01(age / MOTION.fill)));
        else if (f < prev) this.discard(ctx, G, e.block, f, prev, dpr, 1 - clamp01(age / MOTION.rollback));
      } else if (e.type === 'block_free') {
        if (discard) this.discard(ctx, G, e.block, 0, prev, dpr, 1 - clamp01(age / MOTION.rollback));
        else this.cells(ctx, G, e.block, 0, prev, C.ink3, 0.6 * (1 - clamp01(age / MOTION.evict)));
      } else if (e.type === 'block_evict') {
        const t = clamp01(age / MOTION.evict);
        if (t < 1) {
          for (let k = 0; k < prev; k++) {
            const [x, y, cw] = this.cellRect(G, e.block, k);
            const sc = (1 - t) * cw;
            ctx.fillStyle = C.cached;
            ctx.fillRect(x + (cw - sc) / 2, y + (cw - sc) / 2, sc, sc);
          }
        }
      } else if (e.type === 'block_alloc' || e.type === 'block_hit') {
        const a = 1 - clamp01(age / MOTION.alloc);
        if (a > 0) {
          const [bx, by] = this.blockXY(G, e.block);
          ctx.strokeStyle = rgba(C.ink, a);
          ctx.lineWidth = 1;
          ctx.strokeRect(bx - 1.5, by - 1.5, G.bw + 3, G.bh + 3);
        }
      }
    }

    // ---- hover frame
    if (this.hover && this.hover.pool === p) {
      const [bx, by] = this.blockXY(G, this.hover.block);
      ctx.strokeStyle = C.focus;
      ctx.lineWidth = 1;
      ctx.strokeRect(bx - 2.5, by - 2.5, G.bw + 5, G.bh + 5);
    }
  }

  private cells(ctx: CanvasRenderingContext2D, G: Geo, block: number, from: number, to: number, color: string, a: number) {
    if (a <= 0.01) return;
    ctx.fillStyle = rgba(color, a);
    for (let k = from; k < to; k++) {
      const [x, y, cw, ch] = this.cellRect(G, block, k);
      ctx.fillRect(x, y, cw, ch);
    }
  }

  private discard(ctx: CanvasRenderingContext2D, G: Geo, block: number, from: number, to: number, dpr: number, a: number) {
    if (a <= 0.01) return;
    ctx.globalAlpha = a;
    const pat = hatch(ctx, C.discard, dpr, 3);
    for (let k = from; k < to; k++) {
      const [x, y, cw, ch] = this.cellRect(G, block, k);
      ctx.fillStyle = C.bg;
      ctx.fillRect(x, y, cw, ch);
      ctx.fillStyle = pat;
      ctx.fillRect(x, y, cw, ch);
      ctx.strokeStyle = C.discard;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
    }
    ctx.globalAlpha = 1;
  }

  private onMove(p: PoolView, e: MouseEvent) {
    const G = p.geo,
      s = this.player?.state;
    if (!G || !s?.config) return;
    const r = p.canvas.getBoundingClientRect();
    const x = e.clientX - r.left - G.ox,
      y = e.clientY - r.top - G.oy;
    const col = Math.floor(x / (G.bw + G.bgap)),
      row = Math.floor(y / (G.bh + G.bgap));
    const inX = x - col * (G.bw + G.bgap) <= G.bw,
      inY = y - row * (G.bh + G.bgap) <= G.bh;
    const i = row * G.cols + col;
    if (x < 0 || y < 0 || col >= G.cols || !inX || !inY || i >= p.n) {
      this.hover = null;
      tip.hide();
      return;
    }
    this.hover = { pool: p, block: i };
    const b = (p.name === 'target' ? s.pools.target : s.pools.draft)![i];
    const bs = s.config.block_size;
    const owners = b.owners
      .map((rid) => `<b>r${rid}</b> ${esc(snippet(s.reqs[rid]?.prompt_text ?? '').slice(0, 40))}`)
      .join('<br/>');
    const what =
      b.state === 'free'
        ? 'free'
        : b.state === 'cached'
          ? 'cached · no owner · reusable prefix'
          : b.owners.length > 1
            ? `shared prefix · ${b.owners.length} owners`
            : `owned · logical block ${b.idx}`;
    tip.show(
      `<span class="lab">${p.name} pool · block ${i}</span><b>${what}</b><br/>${b.filled}/${bs} tokens${owners ? '<br/>' + owners + '<br/><span class="dim">click to inspect</span>' : ''}`,
      e.clientX,
      e.clientY,
    );
  }
}
