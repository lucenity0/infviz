#!/usr/bin/env node
// Capture a poster frame (PNG) or an animated GIF of any infviz page, headlessly.
//
// Every frame is the page settled on one playback position through window.infviz.renderAt,
// so captures are exact and repeatable (animation is a pure function of position).
//
//   npm run capture -- --at 45 --out poster.png
//   npm run capture -- --from 20 --to 60 --step 0.2 --fps 12 --out run.gif
//   npm run capture -- --page compare --from 0 --to 13.5 --step 0.1 --out compare.gif
//
// Positions are engine steps on the single-run page (--at 45 shows step 45 settled, like
// ?step=45) and seconds on the compare page.
// Uses your installed Chrome (set CHROME_PATH if it is somewhere unusual). The licensed
// display font is blocked by default so outputs carry only the OFL fonts; pass
// --licensed-font to allow it for private use. --full keeps the transport bar.
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import puppeteer from 'puppeteer-core';

const { GIFEncoder, applyPalette, quantize } = gifenc;
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function args(argv) {
  const a = {
    page: 'single', trace: './demo.jsonl', a: null, b: null, at: null, from: null, to: null, step: 0.25,
    fps: 12, hold: 1.5, width: 1280, height: 800, scale: 1, out: null, theme: 'dark', maxMb: 15,
    licensedFont: false, full: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (k === 'licensedFont') a.licensedFont = true;
    else if (k === 'full') a.full = true;
    else if (k in a) a[k] = argv[++i];
    else throw new Error(`unknown option --${argv[i].replace(/^--/, '')}`);
  }
  for (const n of ['at', 'from', 'to', 'step', 'fps', 'hold', 'width', 'height', 'scale', 'maxMb'])
    if (a[n] !== null) a[n] = Number(a[n]);
  if (!a.out) throw new Error('--out file.png|file.gif is required');
  if (a.out.endsWith('.png') && a.at === null) throw new Error('a PNG needs --at <position>');
  if (a.out.endsWith('.gif') && (a.from === null || a.to === null)) throw new Error('a GIF needs --from and --to');
  return a;
}

function chromePath() {
  const c = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const p = c.find((x) => existsSync(x));
  if (!p) throw new Error('Chrome not found: set CHROME_PATH');
  return p;
}

const a = args(process.argv.slice(2));
const server = await createServer({ root, logLevel: 'error', server: { port: 0, strictPort: false } });
await server.listen();
const base = server.resolvedUrls.local[0];
const q = new URLSearchParams({ theme: a.theme, nosplash: '1' });
if (!a.full) q.set('poster', '1'); // --full keeps the transport bar (a screenshot of the whole app)
let url;
if (a.page === 'compare') {
  if (a.a) q.set('a', a.a);
  if (a.b) q.set('b', a.b);
  url = `${base}compare.html?${q}`;
} else {
  q.set('trace', a.trace);
  q.set('nolive', '1');
  q.set('step', '0');
  url = `${base}?${q}`;
}

const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--hide-scrollbars'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: a.width, height: a.height, deviceScaleFactor: a.scale });
  if (!a.licensedFont) {
    await page.setRequestInterception(true);
    page.on('request', (r) => (r.url().includes('/fonts/licensed/') ? r.abort() : r.continue()));
  }
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.infviz && window.infviz.ready !== undefined, { timeout: 30000 });
  await page.evaluate(() => window.infviz.ready);
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);

  // single-run page: positions are engine steps, settled at the END of that step (like ?step=)
  const off = a.page === 'compare' ? 0 : 1;
  const frameAt = async (p) => {
    await page.evaluate((x) => window.infviz.renderAt(x), p + off);
    return page.screenshot({ type: 'png' });
  };

  if (a.out.endsWith('.png')) {
    writeFileSync(a.out, await frameAt(a.at));
    console.log(`wrote ${a.out}`);
  } else {
    const positions = [];
    for (let p = a.from; p <= a.to + 1e-9; p += a.step) positions.push(Math.round(p * 1000) / 1000);
    const frames = [];
    for (const [i, p] of positions.entries()) {
      const png = PNG.sync.read(await frameAt(p));
      frames.push({ data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length), w: png.width, h: png.height });
      if (i % 20 === 0) process.stdout.write(`\r  frame ${i + 1}/${positions.length}`);
    }
    process.stdout.write('\n');
    // ONE palette for every frame (sampled across the whole run), so colours never shimmer
    const { w, h } = frames[0];
    const every = Math.max(1, Math.floor(frames.length / 12));
    const sample = [];
    for (let i = 0; i < frames.length; i += every) {
      const d = frames[i].data;
      for (let j = 0; j < d.length; j += 4 * 7) sample.push(d[j], d[j + 1], d[j + 2], d[j + 3]);
    }
    const palette = quantize(new Uint8Array(sample), 256);
    const gif = GIFEncoder();
    const delay = Math.round(1000 / a.fps);
    frames.forEach((f, i) => {
      const last = i === frames.length - 1;
      gif.writeFrame(applyPalette(f.data, palette), w, h, {
        palette: i === 0 ? palette : undefined,
        delay: last ? delay + a.hold * 1000 : delay,
        repeat: 0,
      });
    });
    gif.finish();
    const bytes = gif.bytes();
    const mb = bytes.length / 1048576;
    writeFileSync(a.out, bytes);
    console.log(`wrote ${a.out}: ${frames.length} frames, ${w}x${h}, ${mb.toFixed(1)} MB`);
    if (mb > a.maxMb) {
      console.error(`over --max-mb ${a.maxMb}: use a smaller --width/--height, a larger --step or a shorter range`);
      process.exitCode = 1;
    }
  }
} finally {
  await browser.close();
  await server.close();
}
