// Transport bar: play/step/speed, follow-live, and (live only) the engine controls.
import { api } from './live';
import { SPEEDS, type Player } from './player';

const PLAY = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.8 10.2 6 3 10.2z"/></svg>';
const PAUSE = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 2h2v8H3zM7 2h2v8H7z"/></svg>';

export class Transport {
  private $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  private playBtn = this.$('b-play');
  private liveBtn = this.$('b-live');
  private speedBtns: HTMLButtonElement[] = [];
  private ver = '';

  constructor(
    private p: Player,
    onOpen: (f: File) => void,
    private toast: (m: string) => void,
  ) {
    const speeds = this.$('speeds');
    for (const x of SPEEDS) {
      const b = document.createElement('button');
      b.className = 'tbtn';
      b.textContent = `${x}×`;
      b.setAttribute('aria-label', `Speed ${x}×`);
      b.onclick = () => p.setSpeed(x);
      speeds.appendChild(b);
      this.speedBtns.push(b);
    }
    this.playBtn.onclick = () => p.toggle();
    this.$('b-back').onclick = () => p.stepBy(-1);
    this.$('b-fwd').onclick = () => p.stepBy(1);
    this.liveBtn.onclick = () => p.followLive();
    const file = this.$<HTMLInputElement>('file');
    this.$('b-open').onclick = () => file.click();
    file.onchange = () => file.files?.[0] && onOpen(file.files[0]);

    this.$<HTMLFormElement>('f-req').onsubmit = (e) => {
      e.preventDefault();
      const inp = this.$<HTMLInputElement>('in-prompt');
      const prompt = inp.value.trim();
      if (!prompt) return;
      api.request(prompt, 96).then(
        (r) => {
          inp.value = '';
          this.toast(`Sent as r${(r as { rid: number }).rid}`);
        },
        (err) => this.toast(`Send failed: ${err}`),
      );
    };

    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === ' ') {
        e.preventDefault();
        p.toggle();
      } else if (e.key === 'ArrowLeft') p.stepBy(e.shiftKey ? -10 : -1);
      else if (e.key === 'ArrowRight') p.stepBy(e.shiftKey ? 10 : 1);
      else if (e.key === 'l' || e.key === 'L') p.followLive();
    });
  }

  render() {
    const p = this.p;
    const live = p.mode === 'live';
    const v = `${p.playing}|${p.speed}|${live}|${p.follow}`;
    if (v === this.ver) return;
    this.ver = v;
    this.playBtn.innerHTML = p.playing ? PAUSE : PLAY;
    this.speedBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(SPEEDS[i] === p.speed)));
    this.liveBtn.hidden = !live;
    this.liveBtn.setAttribute('aria-pressed', String(live && p.follow));
    for (const id of ['f-req', 'b-engine']) this.$(id).hidden = !live;
    this.$('b-compare').hidden = live; // compare is for recordings
  }
}
