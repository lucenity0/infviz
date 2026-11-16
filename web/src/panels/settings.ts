// Engine settings (live only): one-click presets and manual fields that rebuild the
// engine on the server. The panel reads its values from the latest `config` EVENT, not
// from the HTTP reply, so every open tab agrees on what the engine is actually running.
import { api, type EngineInfo } from '../live';
import type { Player } from '../player';
import { esc, outlined } from '../ui';

export interface Preset {
  id: string;
  name: string;
  what: string;
  settings: { blocks: number; max_batch: number; speculation: boolean; spec_k: number };
  load: { n: number; rate: number };
}

export const PRESETS: Preset[] = [
  {
    id: 'balanced',
    name: 'Balanced',
    what: 'Room for everyone, k = 4. The default picture: prefix sharing, steady speculation.',
    settings: { blocks: 56, max_batch: 6, speculation: true, spec_k: 4 },
    load: { n: 12, rate: 1.5 },
  },
  {
    id: 'pressure',
    name: 'Memory pressure',
    what: 'A pool barely big enough. Watch cached blocks get evicted and requests preempted.',
    settings: { blocks: 0, max_batch: 6, speculation: true, spec_k: 4 }, // 0 = the server's floor + 4
    load: { n: 14, rate: 3 },
  },
  {
    id: 'plain',
    name: 'No speculation',
    what: 'The target alone, one token per request per step. Compare the step count.',
    settings: { blocks: 56, max_batch: 6, speculation: false, spec_k: 4 },
    load: { n: 12, rate: 1.5 },
  },
  {
    id: 'long',
    name: 'Long guesses',
    what: 'k = 8 with a small batch. More drafts accepted per pass, and many more thrown away.',
    settings: { blocks: 64, max_batch: 3, speculation: true, spec_k: 8 },
    load: { n: 8, rate: 1 },
  },
  {
    id: 'wide',
    name: 'Wide batch',
    what: 'Up to 12 requests per step in a large pool. Continuous batching at full width.',
    settings: { blocks: 128, max_batch: 12, speculation: true, spec_k: 4 },
    load: { n: 20, rate: 4 },
  },
];

export class SettingsPanel {
  private el: HTMLElement;
  private info: EngineInfo | null = null;
  private busy = false;
  private dirty = false;
  private shownKey = '';
  private loadN = 12;
  private loadRate = 1.5;
  open = false;

  constructor(
    private player: Player,
    private toast: (m: string) => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'pop';
    this.el.id = 'settings';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Engine settings');
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('input', (e) => {
      if ((e.target as HTMLElement).closest('[data-form="restart"]')) this.dirty = true;
      this.syncFloor();
    });
    this.el.addEventListener('submit', (e) => {
      e.preventDefault();
      if ((e.target as HTMLElement).dataset.form === 'restart') this.applyManual();
    });
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open) this.toggle(false);
    });
  }

  async toggle(force?: boolean) {
    this.open = force ?? !this.open;
    this.el.hidden = !this.open;
    if (this.open) {
      this.dirty = false;
      this.shownKey = '';
      try {
        this.info = await api.getConfig();
      } catch (e) {
        this.info = null;
        this.toast(`Could not read engine settings: ${e}`);
      }
      this.render();
    }
  }

  /** called every frame: re-render when a new config event (session) arrives */
  tick() {
    if (!this.open) return;
    const c = this.player.state.config;
    const key = c ? `${c.t}|${c.pools.target.n_blocks}|${c.max_batch}|${c.spec_k}|${c.models.draft}` : '';
    if (key !== this.shownKey) this.render();
  }

  private current() {
    const c = this.player.state.config;
    if (!c) return null;
    return { blocks: c.pools.target.n_blocks, max_batch: c.max_batch, speculation: !!c.models.draft, spec_k: c.spec_k || 4 };
  }

  private floor(k: number, spec: boolean): number {
    const f = this.info?.floors[String(spec ? k : 0)];
    return typeof f === 'number' ? f : 8;
  }

  private presetSettings(p: Preset) {
    const s = { ...p.settings };
    if (!this.info?.draft_available) s.speculation = false;
    const fl = this.floor(s.spec_k, s.speculation);
    s.blocks = s.blocks === 0 ? fl + 4 : Math.max(s.blocks, fl);
    return s;
  }

  private render() {
    const c = this.player.state.config;
    this.shownKey = c ? `${c.t}|${c.pools.target.n_blocks}|${c.max_batch}|${c.spec_k}|${c.models.draft}` : '';
    const cur = this.current();
    const lim = this.info?.limits;
    const draftOk = !!this.info?.draft_available;
    const presets = PRESETS.map((p) => {
      const s = this.presetSettings(p);
      const on = cur && cur.blocks === s.blocks && cur.max_batch === s.max_batch && cur.speculation === s.speculation && (!s.speculation || cur.spec_k === s.spec_k);
      const off = p.settings.speculation && !draftOk;
      return `<button class="preset${on ? ' on' : ''}" data-preset="${p.id}" ${this.busy || off ? 'disabled' : ''}>
        <span class="pn">${esc(p.name)}</span>
        <span class="pd">${esc(p.what)}</span>
        <span class="ps num">${s.blocks} blocks · batch ${s.max_batch} · ${s.speculation ? `k ${s.spec_k}` : 'no draft'} · then ${p.load.n} requests</span>
      </button>`;
    }).join('');
    const v = this.dirty ? null : cur;
    const field = (id: string, lab: string, val: number | undefined, lo: number, hi: number, term = '') =>
      `<label class="fld"${term ? ` data-term="${term}"` : ''}><span class="lab">${lab}</span><input id="${id}" type="number" min="${lo}" max="${hi}" step="1" ${val !== undefined ? `value="${val}"` : ''} /></label>`;
    const keep = (id: string) => (this.el.querySelector(`#${id}`) as HTMLInputElement | null)?.value;
    this.el.innerHTML = `
      <div class="head"><span class="title">${outlined('ENGINE', 'Engine')}</span><span class="sub">${cur ? `now ${cur.blocks} blocks · batch ${cur.max_batch} · ${cur.speculation ? `k ${cur.spec_k}` : 'no draft'}` : 'no engine'}</span><span class="grow"></span>
        <button class="tbtn x" data-close aria-label="Close (Esc)" title="Close · Esc">×</button></div>
      <div class="pbody">
        <div class="sh"><span class="lab">Presets</span><span class="dim">restart the engine, then start a load burst</span></div>
        <div class="presets">${presets}</div>
        <form class="manual" data-form="pace">
          <div class="sh"><span class="lab">Load and pace</span><span class="dim">no restart</span></div>
          <div class="fields three">
            <label class="fld"><span class="lab">Requests</span><input id="st-n" type="number" min="1" max="64" step="1" value="${keep('st-n') ?? this.loadN}" /></label>
            <label class="fld"><span class="lab">Rate / s</span><input id="st-rate" type="number" min="0.1" max="20" step="0.1" value="${keep('st-rate') ?? this.loadRate}" /></label>
            <label class="fld"><span class="lab">Step delay (s)</span><input id="st-delay" type="number" min="0" max="5" step="0.05" value="${keep('st-delay') ?? this.info?.step_delay ?? 0.15}" /></label>
          </div>
          <div class="actions"><button class="tbtn text" type="button" data-load>Start load</button><button class="tbtn text" type="button" data-delay>Set delay</button></div>
        </form>
        <form class="manual" data-form="restart">
          <div class="sh"><span class="lab">Manual</span><span class="dim" data-floor></span></div>
          <div class="fields">
            ${field('st-blocks', 'KV pool (blocks)', v?.blocks ?? Number(keep('st-blocks')), lim?.blocks[0] ?? 8, lim?.blocks[1] ?? 512, 'pool')}
            ${field('st-batch', 'Max batch', v?.max_batch ?? Number(keep('st-batch')), lim?.max_batch[0] ?? 1, lim?.max_batch[1] ?? 16, 'batch')}
            ${field('st-k', 'Draft tokens k', v?.spec_k ?? Number(keep('st-k')), lim?.spec_k[0] ?? 1, lim?.spec_k[1] ?? 8, 'k')}
            <label class="fld chk" data-term="spec"><span class="lab">Speculation</span><input id="st-spec" type="checkbox" ${(v ? v.speculation : (this.el.querySelector('#st-spec') as HTMLInputElement | null)?.checked) ? 'checked' : ''} ${draftOk ? '' : 'disabled'} /></label>
          </div>
          <div class="actions"><button class="tbtn text" type="submit" ${this.busy ? 'disabled' : ''}>${this.busy ? 'Restarting…' : 'Apply and restart'}</button>
          <span class="dim">${draftOk ? 'Restarting starts a new session: the current run is cleared.' : 'Started with --draft none: speculation is unavailable.'}</span></div>
        </form>
      </div>`;
    this.syncFloor();
  }

  private syncFloor() {
    const k = Number((this.el.querySelector('#st-k') as HTMLInputElement | null)?.value) || 4;
    const spec = !!(this.el.querySelector('#st-spec') as HTMLInputElement | null)?.checked;
    const fl = this.floor(k, spec);
    const b = this.el.querySelector('#st-blocks') as HTMLInputElement | null;
    if (b) b.min = String(fl);
    const kk = this.el.querySelector('#st-k') as HTMLInputElement | null;
    if (kk) kk.disabled = !spec;
    const f = this.el.querySelector('[data-floor]');
    if (f) f.textContent = `at least ${fl} blocks ${spec ? `at k = ${k}` : 'without speculation'}, so every built-in request fits`;
  }

  private async restart(s: { blocks: number; max_batch: number; speculation: boolean; spec_k: number }) {
    this.busy = true;
    this.render();
    try {
      this.info = await api.setConfig(s);
      this.dirty = false;
      return true;
    } catch (e) {
      this.toast(`Restart refused: ${e}`);
      return false;
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async onClick(e: Event) {
    const t = e.target as HTMLElement;
    if (t.closest('[data-close]')) return this.toggle(false);
    const num = (id: string) => Number((this.el.querySelector(`#${id}`) as HTMLInputElement).value);
    if (t.closest('[data-load]')) {
      this.loadN = Math.max(1, Math.min(64, Math.round(num('st-n')) || 12));
      this.loadRate = Math.max(0.1, Math.min(20, num('st-rate') || 1));
      api.load(this.loadN, this.loadRate).then(
        () => this.toast(`Load started: ${this.loadN} requests at ${this.loadRate}/s`),
        (err) => this.toast(`Load failed: ${err}`),
      );
      return;
    }
    if (t.closest('[data-delay]')) {
      const d = num('st-delay');
      api.speed(d).then(
        (r) => {
          if (this.info) this.info.step_delay = (r as { step_delay: number }).step_delay;
          this.toast(`Engine step delay ${d}s`);
        },
        (err) => this.toast(`Failed: ${err}`),
      );
      return;
    }
    const pb = t.closest('[data-preset]') as HTMLElement | null;
    if (!pb || this.busy) return;
    const p = PRESETS.find((x) => x.id === pb.dataset.preset)!;
    if (await this.restart(this.presetSettings(p))) {
      // sequenced: the burst goes to the NEW engine
      try {
        await api.load(p.load.n, p.load.rate);
        this.toast(`${p.name}: engine restarted, ${p.load.n} requests on the way`);
      } catch (err) {
        this.toast(`Engine restarted, but the load burst failed: ${err}`);
      }
    }
  }

  private async applyManual() {
    const n = (id: string) => Number((this.el.querySelector(`#${id}`) as HTMLInputElement).value);
    const spec = (this.el.querySelector('#st-spec') as HTMLInputElement).checked;
    if (await this.restart({ blocks: n('st-blocks'), max_batch: n('st-batch'), speculation: spec, spec_k: n('st-k') || 4 }))
      this.toast('Engine restarted with the new settings');
  }
}
