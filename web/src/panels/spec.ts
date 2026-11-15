// Speculation inspector. Top: the one poster number — tokens committed per target
// verify pass (1 + mean accepted drafts), computed from verify events at the playhead.
// Below: each running lane's latest round. Chips go draft (outlined) -> accepted
// (solid ink) / first rejection (hatched red) / voided rest (struck) -> the target's
// own token (outlined ink, FIX or BONUS). Phase is a pure function of the playhead.
import type { Player } from '../player';
import { selection } from '../select';
import { Feed } from './feed';
import type { ReqInfo } from '../reducer';
import { MOTION, reqColor } from '../tokens';
import { el, esc, snippet, tip, tokHtml } from '../ui';

export class SpecPanel {
  private big: HTMLElement;
  private cap: HTMLElement;
  private facts: HTMLElement;
  private lanes: HTMLElement;
  private sub: HTMLElement;
  private laneEls = new Map<number, HTMLElement>();
  private reqs = new Map<number, ReqInfo>();
  private feedEl: HTMLElement;
  private legend: HTMLElement;
  private feed: Feed;
  private tabs: HTMLButtonElement[] = [];
  private tab: 'lanes' | 'events' = 'lanes';
  private player: Player | null = null;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="head"><span class="title" data-term="spec">Speculative decoding</span><span class="sub" data-sub></span></div>
      <div class="poster">
        <div class="big" data-big></div>
        <div class="cap" data-cap></div>
        <div class="facts" data-facts></div>
      </div>
      <div class="head"><div class="tabs" role="tablist" aria-label="Lower panel">
          <button class="tab lab" role="tab" data-tab="lanes" aria-selected="true" title="Each running request’s latest speculation round">Lanes</button>
          <button class="tab lab" role="tab" data-tab="events" aria-selected="false" title="What the engine did, step by step, in plain language">Events</button></div><span class="grow"></span>
        <span class="legend" data-legend><span class="key lab" data-term="draft"><i class="sw draft"></i>Draft</span><span class="key lab" data-term="accepted"><i class="sw acc"></i>Accept</span><span class="key lab" data-term="reject"><i class="sw rej"></i>Reject</span></span></div>
      <div class="lanes" data-lanes></div>
      <ol class="feed" data-feed hidden></ol>`;
    this.big = root.querySelector('[data-big]')!;
    this.cap = root.querySelector('[data-cap]')!;
    this.facts = root.querySelector('[data-facts]')!;
    this.lanes = root.querySelector('[data-lanes]')!;
    this.sub = root.querySelector('[data-sub]')!;
    this.feedEl = root.querySelector('[data-feed]')!;
    this.legend = root.querySelector('[data-legend]')!;
    this.feed = new Feed(this.feedEl, () => this.player);
    root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => this.showTab(b.dataset.tab as 'lanes' | 'events')),
    );
    this.tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-tab]')];
  }

  showTab(t: 'lanes' | 'events') {
    this.tab = t;
    for (const b of this.tabs) b.setAttribute('aria-selected', String(b.dataset.tab === t));
    this.lanes.hidden = t !== 'lanes';
    this.legend.hidden = t !== 'lanes';
    this.feedEl.hidden = t !== 'events';
  }

  render(player: Player) {
    this.player = player;
    if (this.tab === 'events') this.feed.render(player);
    const s = player.state;
    const k = s.config?.spec_k ?? 0;
    this.sub.textContent = s.config?.models.draft ? `k = ${k}` : 'off';

    // ---- poster number
    const rounds = k > 0 ? s.totalProposed / k : 0;
    const perPass = rounds > 0 ? 1 + s.totalAccepted / rounds : null;
    const big = perPass === null ? '' : perPass.toFixed(2);
    const bigHtml =
      perPass === null
        ? `<span class="none">No verify passes yet</span>`
        : [...big].map((ch) => `<span class="d${ch === '.' ? ' p' : ''}">${ch}</span>`).join('') + `<span class="unit" data-term="tokpass">tok/pass</span>`;
    if (this.big.dataset.v !== big) {
      this.big.innerHTML = bigHtml;
      this.big.dataset.v = big;
    }
    const cap = !s.config?.models.draft
      ? 'Speculation is off for this run (no draft model).'
      : perPass === null
        ? 'Tokens committed per target forward pass on decode lanes; plain decoding commits 1.00. Not a wall-clock speed-up.'
        : 'Tokens committed per target forward pass on decode lanes; plain decoding commits 1.00. Not a wall-clock speed-up.';
    if (this.cap.textContent !== cap) this.cap.textContent = cap;
    const acc = s.totalProposed ? Math.round((100 * s.totalAccepted) / s.totalProposed) : null;
    const facts = `
      <div class="ro" data-term="accepted"><span class="lab">Accepted</span><span class="v num">${acc === null ? '—' : acc + '%'}</span></div>
      <div class="ro" data-term="drafts"><span class="lab">Drafts</span><span class="v num">${s.totalAccepted}/${s.totalProposed}</span></div>
      <div class="ro" data-term="rounds"><span class="lab">Rounds</span><span class="v num">${Math.round(rounds)}</span></div>`;
    if (this.facts.dataset.v !== facts) {
      this.facts.innerHTML = facts;
      this.facts.dataset.v = facts;
    }

    // ---- lanes: running requests in admission order
    const verifyTau = this.recentVerifies(player);
    const live = new Set<number>();
    this.reqs.clear();
    for (const rid of s.running) {
      const r = s.reqs[rid];
      if (!r) continue;
      this.reqs.set(rid, r);
      live.add(rid);
      let lane = this.laneEls.get(rid);
      if (!lane) {
        lane = el('div', 'lane');
        lane.innerHTML = `<i class="sw"></i><span class="rid"></span><div class="chips"></div><span class="rate num"></span>`;
        lane.addEventListener('mousemove', (e) => {
          const r = this.reqs.get(rid);
          if (r)
            tip.show(
              `<span class="lab">r${r.rid} · ${r.nTokens}/${r.max_new_tokens} tokens · ${r.proposed ? Math.round((100 * r.accepted) / r.proposed) + '% accepted' : 'no rounds'}</span><b>${esc(snippet(r.prompt_text).slice(0, 120))}</b><br/>…${esc(r.out.replace(/\s+/g, ' ').slice(-160))}`,
              e.clientX,
              e.clientY,
            );
        });
        lane.addEventListener('mouseleave', () => tip.hide());
        lane.addEventListener('click', () => selection.toggle(rid));
        this.laneEls.set(rid, lane);
      }
      if (lane.parentElement !== this.lanes || lane !== this.lanes.children[live.size - 1]) {
        this.lanes.insertBefore(lane, this.lanes.children[live.size - 1] ?? null);
      }
      this.fillLane(lane, r, k, verifyTau.get(rid) ?? null, player.pos);
    }
    for (const [rid, lane] of this.laneEls) {
      if (!live.has(rid)) {
        lane.remove();
        this.laneEls.delete(rid);
      }
    }
    if (!s.running.length) {
      if (!this.lanes.querySelector('.state'))
        this.lanes.innerHTML = `<div class="state" style="position:static;padding:32px 16px"><div class="msg">No decode lanes</div><div class="hint">Running requests appear here with their draft tokens.</div></div>`;
    } else this.lanes.querySelector('.state')?.remove();
  }

  /** time of the most recent verify per rid, within the motion window */
  private recentVerifies(player: Player): Map<number, number> {
    const m = new Map<number, number>();
    const tl = player.timeline;
    for (let i = tl.cursorAt(player.pos - MOTION.window); i < player.cursor; i++) {
      const e = player.events[i];
      if (e.type === 'verify') m.set(e.rid, tl.tau(i));
    }
    return m;
  }

  private fillLane(lane: HTMLElement, r: ReqInfo, k: number, tauV: number | null, pos: number) {
    const set = (sel: string, v: string, html = false) => {
      const e = lane.querySelector(sel) as HTMLElement;
      if (e.dataset.v === v) return e;
      e.dataset.v = v;
      if (html) e.innerHTML = v;
      else e.textContent = v;
      return e;
    };
    (lane.querySelector('.sw') as HTMLElement).style.background = reqColor(r.colorSlot);
    lane.classList.toggle('sel', selection.rid === r.rid);
    set('.rid', `r${r.rid}`);
    set('.rate', r.proposed ? `${Math.round((100 * r.accepted) / r.proposed)}%` : '—');

    // chips
    const sp = r.spec;
    let html = '';
    if (!sp || k === 0) {
      html = `<span class="tag">${k === 0 ? 'plain decode' : 'prefill'}</span>`;
    } else {
      const age = sp.nAccepted === null || tauV === null ? (sp.nAccepted === null ? -1 : Infinity) : pos - tauV;
      const settled = (j: number) => age >= j * MOTION.chipStagger + MOTION.chip * 0.5;
      sp.texts.forEach((t, j) => {
        let cls = 'draft';
        if (sp.nAccepted !== null && settled(j)) cls = j < sp.nAccepted ? 'acc' : j === sp.nAccepted ? 'rej' : 'void';
        html += `<span class="chip ${cls}">${tokHtml(t)}</span>`;
      });
      if (sp.nAccepted !== null && sp.targetText !== null && settled(sp.texts.length)) {
        const kind = sp.nAccepted === sp.tokens.length ? 'bonus' : 'fix';
        html += `<span class="arrow">→</span><span class="chip fix" title="${kind === 'bonus' ? 'all drafts accepted: bonus token' : 'target model correction'}">${tokHtml(sp.targetText)}</span>`;
      }
    }
    set('.chips', html, true);
  }
}
