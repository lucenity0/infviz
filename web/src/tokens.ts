// Design tokens — the single source of truth for colour, space, type and motion.
// CSS reads them as custom properties (written onto :root by applyTokens); canvas
// renderers read the same values from `T`. A light theme is a second colour set.
//
// Colour rules (instrument panel):
//   * request hues are the ONLY categorical colour; everything else is neutral ink
//   * `discard` (red) has exactly one meaning: computed work that was thrown away
//     (rejected draft tokens, rolled-back KV, preemption -> recompute)
//   * accepted vs rejected is encoded by FILL (solid vs hatched), never by hue alone

export type Theme = 'dark' | 'light';

interface Colors {
  bg: string; // page / panel surface
  sunken: string; // recessed wells (canvas plot areas, inputs)
  hair: string; // 1px hairline dividers
  grid: string; // recessive plot grid
  ink: string; // primary text, accepted chips, playhead
  ink2: string; // secondary text, values at rest
  ink3: string; // micro-labels, axis text (>= 4.5:1 on bg)
  ink4: string; // decorative-only marks (free cells, ticks); never text
  cached: string; // cached-but-unowned KV
  discard: string; // the single "thrown away" signal
  focus: string;
  req: string[]; // categorical request palette (validated)
  other: string; // requests beyond the palette
}

// Validated with the dataviz skill's validate_palette.js, --mode dark --surface #0b0d10:
// OKLCH L=0.66 C=0.12, hues 258 170 300 130 345 75 215 (order chosen by search).
// PASS lightness band, chroma floor, adjacent CVD ΔE >= 10.9, normal-vision >= 15, contrast >= 3:1.
const DARK: Colors = {
  bg: '#0b0d10',
  sunken: '#08090c',
  hair: '#1f242b',
  grid: '#161a20',
  ink: '#e8ebef',
  ink2: '#aab2bd',
  ink3: '#7f8895',
  ink4: '#2b313a',
  cached: '#4a525e',
  discard: '#e95145',
  focus: '#e8ebef',
  req: ['#6293db', '#29a987', '#9e80d1', '#7aa14e', '#c673a3', '#bd8630', '#00a4c0'],
  other: '#8b939e',
};

// Light set. Validated with validate_palette.js --mode light --surface #f4f5f6: PASS lightness
// band, chroma floor, adjacent CVD ΔE >= 11.8, normal-vision >= 17.0, contrast >= 3:1. Text
// (WCAG, on bg / sunken): ink 16.9 / 15.9, ink2 8.6 / 8.1, ink3 5.3 / 5.0; discard 4.8 / 4.5.
// Cached vs free cell 1.72:1, matching the dark set's 1.66:1.
const LIGHT: Colors = {
  bg: '#f4f5f6',
  sunken: '#eceef0',
  hair: '#d5d9de',
  grid: '#e3e6ea',
  ink: '#111418',
  ink2: '#3f4752',
  ink3: '#5d6672',
  ink4: '#cdd2d8',
  cached: '#98a1ac',
  discard: '#c8372c',
  focus: '#111418',
  req: ['#2f6bc4', '#11866a', '#7a5cb6', '#55801f', '#a74d83', '#9a6510', '#00809a'],
  other: '#6b737e',
};

export const SPACE = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32 } as const;

export const TYPE = {
  // families
  sans: `'Inter Tight Variable', ui-sans-serif, system-ui, sans-serif`,
  mono: `'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace`,
  // the strict scale (px); micro is the instrument caps label
  micro: 10,
  small: 11,
  body: 13,
  title: 15,
  display: 88,
  microTrack: '0.12em',
} as const;

// Motion is measured in ENGINE STEPS, not milliseconds: every animation is a pure
// function of the playback cursor, so scrubbing backwards plays it backwards.
// Events of step s occupy phase [s, s + EVENT_SPAN); the rest of the step settles.
export const MOTION = {
  eventSpan: 0.6, // events of a step are spread over the first 60% of it
  specGap: 0.5, // gap before the verify pass (x events in step): the draft "ghost" dwell ~0.2 step
  fill: 0.18, // cell fill flash
  rollback: 0.3, // red retreat of discarded KV
  evict: 0.3,
  alloc: 0.14,
  chip: 0.1, // per-chip verdict
  chipStagger: 0.035,
  window: 0.4, // max age any animation cares about
} as const;

export let C: Colors = DARK;
export let theme: Theme = 'dark';

const cssVars = (c: Colors): Record<string, string> => ({
  '--bg': c.bg,
  '--sunken': c.sunken,
  '--hair': c.hair,
  '--grid': c.grid,
  '--ink': c.ink,
  '--ink-2': c.ink2,
  '--ink-3': c.ink3,
  '--ink-4': c.ink4,
  '--cached': c.cached,
  '--discard': c.discard,
  '--focus': c.focus,
  '--sans': TYPE.sans,
  '--mono': TYPE.mono,
  '--t-micro': `${TYPE.micro}px`,
  '--t-small': `${TYPE.small}px`,
  '--t-body': `${TYPE.body}px`,
  '--t-title': `${TYPE.title}px`,
  '--t-display': `${TYPE.display}px`,
  '--track': TYPE.microTrack,
  ...Object.fromEntries(c.req.map((h, i) => [`--req-${i}`, h])),
  ...Object.fromEntries(Object.entries(SPACE).map(([k, v]) => [`--s${k}`, `${v}px`])),
});

export function applyTokens(t: Theme = 'dark') {
  theme = t;
  C = t === 'dark' ? DARK : LIGHT;
  const root = document.documentElement;
  root.dataset.theme = t;
  for (const [k, v] of Object.entries(cssVars(C))) root.style.setProperty(k, v);
}

export function reqColor(slot: number): string {
  return slot >= 0 && slot < C.req.length ? C.req[slot] : C.other;
}

// ---- small colour helpers for canvas ----
export function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
export function mix(a: string, b: string, t: number): string {
  const A = parseInt(a.slice(1), 16),
    B = parseInt(b.slice(1), 16);
  const ch = (s: number) => {
    const x = (A >> s) & 255,
      y = (B >> s) & 255;
    return Math.round(x + (y - x) * t);
  };
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

/** 45° hatch pattern (the "rejected / discarded" texture) for canvas */
const hatchCache = new Map<string, CanvasPattern>();
export function hatch(ctx: CanvasRenderingContext2D, color: string, dpr: number, gap = 4): CanvasPattern {
  const key = `${color}|${dpr}|${gap}`;
  let p = hatchCache.get(key);
  if (p) return p;
  const s = Math.round(gap * dpr);
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.strokeStyle = color;
  g.lineWidth = Math.max(1, dpr);
  g.beginPath();
  g.moveTo(-1, s + 1);
  g.lineTo(s + 1, -1);
  g.moveTo(-1, 1);
  g.lineTo(1, -1);
  g.moveTo(s - 1, s + 1);
  g.lineTo(s + 1, s - 1);
  g.stroke();
  p = ctx.createPattern(c, 'repeat')!;
  hatchCache.set(key, p);
  return p;
}
