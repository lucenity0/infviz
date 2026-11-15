// Event feed: the recent engine steps in plain language, newest first, ending at the
// playhead (the current step is narrated only up to the cursor). Click a step to seek.
import { narrateStep, type Story } from '../narrate';
import type { Player } from '../player';
import { esc, patchChildren } from '../ui';

const SHOWN = 40;

export function storyAt(player: Player, step: number): Story | null {
  const tl = player.timeline;
  if (step < 0) return null;
  const [a, b] = tl.groupRange(step);
  const end = Math.min(b, player.cursor);
  if (end <= a) return null;
  const cfg = player.state.config;
  return narrateStep(player.events, a, end, cfg?.block_size ?? 16, cfg?.spec_k ?? 0);
}

/** the step the playhead is in (the newest group with any event applied) */
export function currentStep(player: Player): number {
  const e = player.events[player.cursor - 1];
  return e ? e.step : -1;
}

export class Feed {
  private key = '';
  constructor(
    private root: HTMLElement,
    private player: () => Player | null,
  ) {
    root.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest('[data-step]') as HTMLElement | null;
      const p = this.player();
      if (li && p) p.seekStep(Number(li.dataset.step));
    });
  }

  render(player: Player) {
    const key = `${player.cursor}|${player.events.length > 0}`;
    if (key === this.key) return;
    this.key = key;
    const cur = currentStep(player);
    let html = '';
    let shown = 0;
    for (let s = cur; s >= 0 && shown < SHOWN; s--) {
      const st = storyAt(player, s);
      if (!st || !st.lines.length) continue;
      shown++;
      html += `<li class="ev${s === cur ? ' cur' : ''}" data-step="${s}" title="Go to step ${s}">
        <span class="sn num">${s}</span>
        <div class="tx">${st.lines.map((l) => `<p class="${l.kind}">${esc(l.text)}</p>`).join('')}</div>
        <span class="ms num">${st.ms === null ? '' : Math.round(st.ms) + ' ms'}</span></li>`;
    }
    if (!html) html = `<li class="empty">Nothing has happened yet. Press play.</li>`;
    if (!this.root.firstElementChild) this.root.innerHTML = html;
    else {
      const next = document.createElement('ol');
      next.innerHTML = html;
      patchChildren(this.root, next, 2);
    }
  }
}
