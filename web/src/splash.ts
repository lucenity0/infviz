// Opening splash (~1.5 s): the wordmark, a small KV pool filling cell by cell in the
// request hues (a prefill), a few speculative cells rolled back in the discard hatch, and a
// hairline progress bar. It also covers the moment the page spends looking for a live
// engine. Click or any key skips it; reduced motion gets a still frame; captures never see it.
import { reduceMotion } from './ui';
import { outlined } from './ui';

export const SPLASH_MS = 1500;
const FADE_MS = 260;
const COLS = 10,
  ROWS = 2,
  CELLS = 16; // 4 x 4 cells per block, as in the KV panel

export interface Splash {
  /** resolve once the minimum time has passed, then fade out and remove */
  finish(): Promise<void>;
}

export function showSplash(caption: string): Splash {
  const t0 = performance.now();
  const still = reduceMotion();
  const el = document.createElement('div');
  el.className = 'splash' + (still ? ' still' : '');
  el.setAttribute('role', 'status');
  el.setAttribute('aria-label', 'Loading infviz');

  // fill order: blocks left to right, row by row; within a block, cells in reading order.
  // Each block belongs to one "request" (hue); the last two blocks end in a rollback.
  const nBlocks = COLS * ROWS;
  const owners = [0, 0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 4, 4, 4, 5, 5, 6, 6, 0, 1];
  const fillSpan = SPLASH_MS * 0.62;
  let blocks = '';
  for (let b = 0; b < nBlocks; b++) {
    const filled = b < nBlocks - 3 ? CELLS : b === nBlocks - 3 ? 11 : b === nBlocks - 2 ? 6 : 0;
    const rolled = b >= nBlocks - 3 && b < nBlocks - 1; // these end with discarded cells
    let cells = '';
    for (let c = 0; c < CELLS; c++) {
      const on = c < filled;
      const delay = Math.round(((b * CELLS + c) / (nBlocks * CELLS)) * fillSpan);
      const cls = !on ? 'c' : rolled && c >= filled - 3 ? 'c on rb' : 'c on';
      cells += `<i class="${cls}" style="--d:${delay}ms"></i>`;
    }
    blocks += `<span class="b" style="--h:var(--req-${owners[b] % 7})">${cells}</span>`;
  }

  el.innerHTML = `
    <div class="sp-in">
      <div class="sp-mark">${outlined('infviz')}</div>
      <div class="sp-grid" style="--cols:${COLS}">${blocks}</div>
      <div class="sp-cap">${caption}</div>
    </div>
    <div class="sp-bar"><i style="--t:${SPLASH_MS}ms"></i></div>`;
  document.body.appendChild(el);

  let skip = false;
  let resolveSkip: () => void = () => {};
  const skipped = new Promise<void>((r) => (resolveSkip = r));
  const onSkip = () => {
    skip = true;
    resolveSkip();
  };
  el.addEventListener('click', onSkip);
  addEventListener('keydown', onSkip, { once: true });

  return {
    async finish() {
      const left = SPLASH_MS - (performance.now() - t0);
      if (left > 0 && !skip) await Promise.race([new Promise((r) => setTimeout(r, left)), skipped]);
      removeEventListener('keydown', onSkip);
      el.classList.add('out');
      await new Promise((r) => setTimeout(r, still ? 0 : FADE_MS));
      el.remove();
    },
  };
}
