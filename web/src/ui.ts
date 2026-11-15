import type { ReqInfo } from './reducer';
import { reqColor } from './tokens';

export const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** the human part of a prompt (last paragraph), one line */
export function snippet(text: string): string {
  if (!text) return '';
  const paras = text.split(/\n\s*\n/);
  return (paras.length > 1 ? paras[paras.length - 1] : text).replace(/\s+/g, ' ').trim();
}

export function colorOf(r: ReqInfo | undefined): string {
  return reqColor(r ? r.colorSlot : -1);
}

export const vis = (t: string) => t.replace(/\n/g, '↵');

/** token text with a visible leading-space marker */
export function tokHtml(text: string): string {
  const t = vis(text);
  return t.startsWith(' ') ? `<i class="sp">·</i>${esc(t.slice(1))}` : esc(t);
}

/** "Qwen/Qwen2.5-1.5B-Instruct" -> "Qwen2.5-1.5B" */
export function shortModel(m: string | null | undefined): string {
  if (!m) return '—';
  return m.split('/').pop()!.replace(/-Instruct$/i, '');
}

class Tooltip {
  el = document.createElement('div');
  constructor() {
    this.el.className = 'tip';
    this.el.hidden = true;
    document.body.appendChild(this.el);
  }
  show(html: string, x: number, y: number) {
    const el = this.el;
    el.innerHTML = html;
    el.hidden = false;
    const r = el.getBoundingClientRect();
    let left = x + 14,
      top = y + 14;
    if (left + r.width > innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > innerHeight - 8) top = y - r.height - 14;
    el.style.transform = `translate(${Math.max(4, left)}px, ${Math.max(4, top)}px)`;
  }
  hide() {
    this.el.hidden = true;
  }
}
export const tip = new Tooltip();

/** size a canvas backing store to its CSS box; returns css size */
export function fitCanvas(c: HTMLCanvasElement): { w: number; h: number; dpr: number } {
  const r = c.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.max(1, Math.floor(r.width)),
    h = Math.max(1, Math.floor(r.height));
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  return { w, h, dpr };
}

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeOut = (t: number) => 1 - (1 - t) * (1 - t);

/** draw text clipped to maxW with an ellipsis (canvas has no text-overflow) */
export function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (maxW <= 0) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0,
    hi = text.length;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, m) + '…').width <= maxW) lo = m;
    else hi = m - 1;
  }
  return lo > 0 ? text.slice(0, lo) + '…' : '';
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}
