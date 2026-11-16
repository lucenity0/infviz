import { parseJsonl } from './events';
import { fontsReady } from './fonts';
import { connectLive } from './live';
import { currentStep, storyAt } from './panels/feed';
import { InspectPanel } from './panels/inspect';
import { KvPanel } from './panels/kv';
import { SettingsPanel } from './panels/settings';
import { SpecPanel } from './panels/spec';
import { StatusStrip } from './panels/status';
import { TimelinePanel } from './panels/timeline';
import { Player } from './player';
import { selection } from './select';
import { applyTokens } from './tokens';
import { Transport } from './transport';
import { reduceMotion } from './ui';

applyTokens(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark');
// poster: a fixed frame for screenshots and GIF capture (no transport, no hover, no autoplay)
const poster = new URLSearchParams(location.search).has('poster');
// carry the theme across to the compare page
if (new URLSearchParams(location.search).get('theme') === 'light')
  (document.getElementById('b-compare') as HTMLAnchorElement).href = 'compare.html?theme=light';
if (poster) document.documentElement.classList.add('poster');
let markLoaded: () => void = () => {};
const loaded = new Promise<void>((r) => (markLoaded = r));

const player = new Player();
player.stepwise = reduceMotion();
const status = new StatusStrip(document.getElementById('status')!);
const kv = new KvPanel(document.getElementById('kv')!);
const spec = new SpecPanel(document.getElementById('spec')!);
const timeline = new TimelinePanel(document.getElementById('tl')!);
const inspect = new InspectPanel(document.getElementById('inspect')!);

function toast(msg: string, ms = 3500) {
  const t = document.getElementById('toast')!;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout((toast as unknown as { h?: number }).h);
  (toast as unknown as { h?: number }).h = window.setTimeout(() => (t.hidden = true), ms);
}
const transport = new Transport(player, (f) => openFile(f), toast);
const settings = new SettingsPanel(player, toast);
document.getElementById('b-engine')!.addEventListener('click', () => settings.toggle());

function startReplay(text: string, label: string) {
  const ev = parseJsonl(text);
  if (!ev.length || ev[0].type !== 'config') {
    toast(ev.length ? 'That file does not start with a config event' : 'No events found in that file');
    return false;
  }
  stopLive();
  status.conn = 'none';
  player.load(ev, label, 'replay');
  const q = new URLSearchParams(location.search);
  if (q.has('speed')) player.setSpeed(Number(q.get('speed')) || 1);
  if (q.has('pos')) player.seek(Number(q.get('pos')));
  else if (q.has('step')) player.seekStep(Number(q.get('step')));
  if (!poster && ((!q.has('step') && !q.has('pos')) || q.has('play'))) player.play();
  markLoaded();
  return true;
}
async function openFile(f: File) {
  startReplay(await f.text(), f.name);
}

// drag & drop anywhere
const drop = document.getElementById('drop')!;
let dragDepth = 0;
addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  drop.hidden = false;
});
addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    drop.hidden = true;
  }
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});

// ---------- live ----------
let ws: WebSocket | null = null;
let retry: number | undefined;
let wantLive = false;

function stopLive() {
  wantLive = false;
  clearTimeout(retry);
  if (ws) {
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
}
async function connect(first: boolean): Promise<boolean> {
  try {
    let started = !first;
    ws = await connectLive(
      (e) => {
        if (!started) {
          started = true;
          player.startLive('live');
        }
        // a new config = the engine was rebuilt: request ids restart, so drop the selection
        if (e.type === 'config') selection.set(null);
        player.append(e);
      },
      () => {
        status.conn = 'disconnected';
        player.touch();
        if (wantLive) retry = window.setTimeout(() => connect(false), 2000);
      },
    );
    wantLive = true;
    status.conn = 'connected';
    player.touch();
    return true;
  } catch {
    if (!first && wantLive) retry = window.setTimeout(() => connect(false), 2000);
    return false;
  }
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const traceUrl = params.get('trace');
  if (traceUrl) {
    try {
      const r = await fetch(traceUrl);
      if (!r.ok) throw new Error(String(r.status));
      startReplay(await r.text(), traceUrl.split('/').pop() || traceUrl);
      return;
    } catch (e) {
      toast(`Could not load trace ${traceUrl}: ${e}`);
    }
  }
  if (!params.has('nolive') && !poster) {
    status.conn = 'connecting';
    kv.setOverlay('loading');
    if (await connect(true)) {
      kv.setOverlay(null);
      return;
    }
  }
  status.conn = 'none';
  for (const name of ['demo.jsonl', 'mock.jsonl']) {
    try {
      const r = await fetch(`./${name}`);
      if (!r.ok) continue;
      if (startReplay(await r.text(), name)) {
        kv.setOverlay(null);
        return;
      }
    } catch {
      /* try next */
    }
  }
  kv.setOverlay('error', 'No live engine on :8000 and no bundled trace.');
}

// ---------- one-line narration in the transport bar ----------
const narr = document.getElementById('narr')!;
const narrStep = narr.querySelector('[data-narr-step]')!;
const narrText = narr.querySelector('[data-narr-text]')!;
const PRIORITY = ['preempt', 'evict', 'admit', 'prefill', 'finish', 'arrive', 'spec', 'decode'];
let narrKey = '';
narr.addEventListener('click', () => spec.showTab('events'));
function renderNarration() {
  const key = `${player.cursor}|${player.events.length}`;
  if (key === narrKey) return;
  narrKey = key;
  const s = currentStep(player);
  const st = s > 0 ? storyAt(player, s) : null;
  const lines = st ? st.lines.slice().sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind)) : [];
  narrStep.textContent = st ? `Step ${s}` : '';
  narrText.textContent = lines.length ? lines.map((l) => l.text).join(' ') : player.empty ? '' : 'Press play to watch the engine work.';
}

// ---------- frame loop: everything renders from (state, pos) ----------
let last = performance.now();
function renderAll() {
  status.render(player);
  transport.render();
  kv.render(player);
  spec.render(player);
  timeline.render(player);
  inspect.render(player);
  renderNarration();
  settings.tick();
}
function frame(now: number) {
  const dt = Math.min(100, now - last);
  last = now;
  player.tick(dt);
  renderAll();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
/** capture hook: settle the whole page on playback position `pos`, synchronously */
function renderAt(pos: number) {
  player.pause();
  player.seek(pos);
  renderAll();
}
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => (player.stepwise = reduceMotion()));
boot();

const ready = Promise.all([loaded, fontsReady]).then(() => renderAll());
(window as unknown as { infviz: unknown }).infviz = { player, selection, renderAt, ready, spec };
