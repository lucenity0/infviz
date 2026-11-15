// Request inspector: a drawer over the speculation column for one request, at the playhead.
// Facts come from the reducer; the token-by-token provenance (drafted and accepted vs the
// target's own) and per-round acceptance come from traceRequest() over the event stream.
// Everything is a function of (events, cursor, rid), so it scrubs like every other panel.
import { traceRequest, type RequestTrace } from '../inspect';
import type { Player } from '../player';
import type { ReqInfo } from '../reducer';
import { selection } from '../select';
import { reqColor } from '../tokens';
import { esc, vis } from '../ui';

/** split a Qwen chat-template prompt into system / user parts (raw text otherwise) */
function splitPrompt(text: string): { system: string; user: string } {
  const sys = /<\|im_start\|>system\n([\s\S]*?)<\|im_end\|>/.exec(text);
  const usr = /<\|im_start\|>user\n([\s\S]*?)<\|im_end\|>/.exec(text);
  if (!usr) return { system: '', user: text };
  return { system: sys?.[1] ?? '', user: usr[1] };
}

/** minimal DOM patch: keep nodes whose markup is unchanged, rewrite only what moved */
function patchChildren(a: Element, b: Element, depth: number) {
  const an = [...a.childNodes],
    bn = [...b.childNodes];
  if (depth <= 0 || an.length !== bn.length) {
    if (a.innerHTML !== b.innerHTML) a.innerHTML = b.innerHTML;
    return;
  }
  an.forEach((n, i) => {
    const m = bn[i];
    if (n.nodeType === 1 && m.nodeType === 1) {
      const x = n as Element,
        y = m as Element;
      if (x.outerHTML === y.outerHTML) return;
      if (x.tagName !== y.tagName) return x.replaceWith(y);
      for (const at of [...x.attributes]) if (!y.hasAttribute(at.name)) x.removeAttribute(at.name);
      for (const at of [...y.attributes]) if (x.getAttribute(at.name) !== at.value) x.setAttribute(at.name, at.value);
      patchChildren(x, y, depth - 1);
    } else if (n.nodeType !== m.nodeType) n.replaceWith(m);
    else if (n.textContent !== m.textContent) n.textContent = m.textContent;
  });
}

const fact = (lab: string, v: string, title = '') =>
  `<div class="ro"${title ? ` title="${esc(title)}"` : ''}><span class="lab">${lab}</span><span class="v num">${v}</span></div>`;

export class InspectPanel {
  private root: HTMLElement;
  private key = '';
  private showRejected = false;

  constructor(root: HTMLElement) {
    this.root = root;
    root.hidden = true;
    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-close]')) selection.set(null);
      if (t.closest('[data-rej]')) {
        this.showRejected = !this.showRejected;
        this.key = '';
      }
    });
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && selection.rid !== null) selection.set(null);
    });
    selection.on(() => (this.key = ''));
  }

  render(player: Player) {
    const rid = selection.rid;
    const r = rid === null ? undefined : player.state.reqs[rid];
    if (!r) {
      if (!this.root.hidden) this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    // recompute only when something the drawer shows can have changed
    const key = `${rid}|${player.cursor}|${player.events.length === 0 ? 0 : 1}|${this.showRejected}`;
    if (key === this.key) return;
    this.key = key;
    const k = player.state.config?.spec_k ?? 0;
    const bs = player.state.config?.block_size ?? 16;
    const tr = traceRequest(player.events, player.cursor, r.rid);
    const html = this.html(r, tr, k, bs);
    const prev = this.root.querySelector('.resp');
    const follow = !prev || prev.scrollTop + prev.clientHeight >= prev.scrollHeight - 4;
    if (!this.root.firstElementChild || this.root.dataset.rid !== String(r.rid)) {
      this.root.innerHTML = html;
      this.root.dataset.rid = String(r.rid);
    } else {
      // patch in place: buttons under the pointer and scroll positions survive playback
      const next = document.createElement('div');
      next.innerHTML = html;
      patchChildren(this.root, next, 4);
    }
    const out = this.root.querySelector('.resp');
    if (out && follow && r.status === 'running') out.scrollTop = out.scrollHeight;
  }

  private html(r: ReqInfo, tr: RequestTrace, k: number, bs: number): string {
    const hue = reqColor(r.colorSlot);
    const { system, user } = splitPrompt(r.prompt_text);
    const status =
      r.status === 'finished'
        ? `finished · ${r.finishReason === 'eos' ? 'end of text' : 'length cap'}`
        : r.status === 'waiting'
          ? r.preemptSteps.length
            ? 'preempted · waiting to recompute'
            : 'queued'
          : 'running';
    const drafted = tr.tokens.filter((t) => t.src === 'draft').length;
    const perPass = tr.rounds.length ? 1 + tr.rounds.reduce((a, x) => a + x.accepted, 0) / tr.rounds.length : null;
    const proposed = tr.rounds.reduce((a, x) => a + x.proposed, 0);
    const accepted = tr.rounds.reduce((a, x) => a + x.accepted, 0);

    const facts = [
      fact('Prompt', `${r.prompt_len}<span class="dim"> tok</span>`),
      fact('Output', `${r.nTokens}<span class="dim">/${r.max_new_tokens}</span>`),
      fact('Prefix reused', tr.prefixHits ? `${tr.prefixHits * bs}<span class="dim"> tok</span>` : '0',
        `${tr.prefixHits} full KV blocks of the prompt were already cached and were shared, not recomputed`),
      fact('Arrived', String(r.arriveStep)),
      fact('Admitted', r.admitSteps.join(', ') || '—'),
      fact(r.finishStep !== null ? 'Finished' : 'Preempted', r.finishStep !== null ? String(r.finishStep) : r.preemptSteps.join(', ') || '—'),
    ];
    if (k > 0)
      facts.push(
        fact('Accepted', proposed ? `${Math.round((100 * accepted) / proposed)}%<span class="dim"> of ${proposed}</span>` : '—'),
        fact('Tok / pass', perPass === null ? '—' : perPass.toFixed(2), 'tokens this request committed per target verify pass'),
        fact('KV rolled back', `${tr.rolledBack}<span class="dim"> pos</span>`, 'speculative KV positions written and then discarded (target pool)'),
      );

    // response with provenance
    let resp = '';
    for (const t of tr.tokens) {
      if (this.showRejected && t.rejected !== undefined)
        resp += `<s class="rj" title="draft guessed this; the target disagreed">${esc(vis(t.rejected))}</s>`;
      const cls = t.src === 'draft' ? 'td' : 'tt';
      const title =
        t.src === 'draft'
          ? `step ${t.step} · drafted by the small model, accepted`
          : t.rejected !== undefined
            ? `step ${t.step} · target's own token (draft guessed “${vis(t.rejected)}”)`
            : t.bonus
              ? `step ${t.step} · target's bonus token (all ${k} drafts accepted)`
              : `step ${t.step} · target's own token`;
      resp += `<span class="${cls}" title="${esc(title)}">${esc(t.text)}</span>`;
    }
    if (!tr.tokens.length) resp = `<span class="dim">${r.status === 'waiting' ? 'Not admitted yet.' : 'Prefill in progress.'}</span>`;

    // per-round acceptance strip: solid = accepted, hatched red = drafts discarded
    let strip = '';
    if (k > 0 && tr.rounds.length) {
      const W = 6, G = 2, H = 28;
      const n = tr.rounds.length;
      const bars = tr.rounds
        .map((x, i) => {
          const ha = (x.accepted / k) * H, hr = ((x.proposed - x.accepted) / k) * H;
          return `<g><title>step ${x.step}: ${x.accepted}/${x.proposed} accepted</title><rect x="${i * (W + G)}" y="${H - ha}" width="${W}" height="${ha}" class="sa"/><rect x="${i * (W + G)}" y="${H - ha - hr}" width="${W}" height="${hr}" class="sr"/></g>`;
        })
        .join('');
      strip = `<div class="sect"><div class="sh"><span class="lab">Rounds</span><span class="dim num">${n} · accepted of ${k} per round</span></div>
        <svg class="rounds" viewBox="0 0 ${n * (W + G)} ${H}" width="${n * (W + G)}" height="${H}" preserveAspectRatio="xMinYMax meet">
        <defs><pattern id="ihz" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" class="hz"/></pattern></defs>${bars}</svg></div>`;
    }

    return `
      <div class="head"><i class="sw" style="background:${hue}"></i><span class="title">Request r${r.rid}</span><span class="sub">${esc(status)}</span><span class="grow"></span><button class="tbtn x" data-close aria-label="Close inspector (Esc)" title="Close · Esc">×</button></div>
      <div class="ibody">
        <div class="ifacts">${facts.join('')}</div>
        <div class="sect"><div class="sh"><span class="lab">Prompt</span></div>
          ${system ? `<p class="sys" title="system prompt">${esc(system)}</p>` : ''}<p class="usr">${esc(user)}</p></div>
        <div class="sect grow"><div class="sh"><span class="lab">Response</span>${
          k > 0
            ? `<span class="ikey"><span class="td">drafted</span> accepted from the draft · <span class="tt">plain</span> the target's own${tr.tokens.some((t) => t.rejected !== undefined) ? ` · <button class="lk" data-rej>${this.showRejected ? 'hide' : 'show'} rejected guesses</button>` : ''}</span>`
            : ''
        }</div>
          <div class="resp">${resp}</div>
          ${k > 0 && tr.tokens.length ? `<div class="share num">${drafted} of ${tr.tokens.length} tokens came from the draft model</div>` : ''}</div>
        ${strip}
      </div>`;
  }
}
