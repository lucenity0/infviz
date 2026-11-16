// Status strip: identity of the run on the left, live readouts on the right.
// Every number is mono + tabular so counters never jitter.
import type { Player } from '../player';
import { esc, shortModel } from '../ui';

export type Conn = 'none' | 'connecting' | 'connected' | 'disconnected';

export class StatusStrip {
  conn: Conn = 'none';
  constructor(private root: HTMLElement) {}

  render(p: Player) {
    const s = p.state;
    const cfg = s.config;
    const live = p.mode === 'live';
    const modeCls = live ? (this.conn === 'connected' ? 'live' : 'live off') : '';
    const modeTxt = live ? (this.conn === 'connected' ? 'LIVE' : 'OFFLINE') : this.conn === 'connecting' ? 'CONNECTING' : 'REPLAY';
    const src = live ? 'ws /ws' : p.label || '—';
    const step = Math.max(0, Math.ceil(p.pos) - 1);
    const tNow = p.events[Math.max(0, p.cursor - 1)]?.t ?? 0;
    const TERMS: Record<string, string> = { Step: 'step', Running: 'running', Queued: 'queued' };
    const ro = (lab: string, v: string) =>
      `<div class="ro"${TERMS[lab] ? ` data-term="${TERMS[lab]}"` : ''}><span class="lab">${lab}</span><span class="v num">${v}</span></div>`;
    const html = `
      <div class="seg brand"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="0" y="0" width="6" height="6" fill="currentColor"/><rect x="8" y="0" width="6" height="6" fill="currentColor"/><rect x="0" y="8" width="6" height="6" fill="currentColor"/><rect x="8.5" y="8.5" width="5" height="5" fill="none" stroke="currentColor"/></svg><b>infviz</b><span class="mode ${modeCls}">${modeTxt}</span></div>
      <div class="seg"><span class="lab">Source</span><span class="v ell">${esc(src)}${p.isMock ? ' · synthetic' : ''}</span></div>
      <div class="seg"><span class="lab">Target ← draft</span><span class="v ell"><b>${esc(shortModel(cfg?.models.target))}</b> ← ${esc(shortModel(cfg?.models.draft))}</span></div>
      <div class="seg"><span class="lab">Engine</span><span class="v ell">${cfg ? `${esc(cfg.device)} · block ${cfg.block_size} · batch ${cfg.max_batch} · k ${cfg.spec_k}${cfg.temperature ? ` · T ${cfg.temperature}` : ' · greedy'}` : '—'}</span></div>
      <div class="seg flex"></div>
      <div class="seg readouts">
        ${ro('Step', `${step}<span class="dim">/${p.maxStep}</span>`)}
        ${ro('Time', `${tNow.toFixed(2)}<span class="dim">s</span>`)}
        ${ro('Tokens', String(Object.values(s.reqs).reduce((a, r) => a + r.nTokens, 0)))}
        ${ro('Running', `${s.running.length}<span class="dim">/${cfg?.max_batch ?? 0}</span>`)}
        ${ro('Queued', String(s.waiting.length))}
        ${ro('Done', String(s.finished.length))}
      </div>`;
    if (this.root.dataset.v !== html) {
      this.root.innerHTML = html;
      this.root.dataset.v = html;
    }
  }
}
