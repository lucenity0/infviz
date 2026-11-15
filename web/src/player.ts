// Player: the event list (replay or live) plus ONE authoritative playback position `pos`
// (fractional engine steps). Reducer state is always "events with tau <= pos" (see
// timeline.ts), restored from checkpoints when moving backwards. Panels render purely
// from (state, pos), so there is no wall-clock animation state anywhere.
import type { InfvizEvent } from './events';
import { apply, initialState, type State } from './reducer';
import { Timeline } from './timeline';

export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
const BASE_STEPS_PER_SEC = 2; // 1x
const CP_EVERY = 256;

export type Mode = 'replay' | 'live';

export class Player {
  events: InfvizEvent[] = [];
  cursor = 0; // number of events applied
  state: State = initialState();
  timeline = new Timeline();
  mode: Mode = 'replay';
  label = '';
  playing = false;
  speed = 1;
  /** live only: playhead chases the head of the stream */
  follow = false;
  /** reduced motion: advance in whole steps (each frame is a settled state) */
  stepwise = false;
  pos = 0;
  /** bumps whenever anything visible may have changed */
  version = 0;
  private cps = new Map<number, State>();
  private stepAcc = 0;

  constructor() {
    this.timeline.reset(this.events);
  }

  get isMock() {
    return this.events[0]?.type === 'config' && this.events[0].models.target === 'mock';
  }
  get maxStep() {
    return this.timeline.maxStep;
  }
  get maxPos() {
    return this.timeline.maxPos();
  }
  get atEnd() {
    return this.pos >= this.maxPos - 1e-9;
  }
  get empty() {
    return this.events.length === 0;
  }

  touch() {
    this.version++;
  }

  load(events: InfvizEvent[], label: string, mode: Mode = 'replay') {
    this.events = [];
    this.timeline.reset(this.events);
    this.cps.clear();
    events.forEach((e) => this.push(e));
    this.timeline.sealed = mode === 'replay';
    this.mode = mode;
    this.label = label;
    this.state = initialState();
    this.cursor = 0;
    this.pos = 0;
    this.playing = false;
    this.follow = false;
    this.setPos(0);
  }

  startLive(label: string) {
    this.load([], label, 'live');
    this.follow = true;
    this.playing = true;
    this.touch();
  }

  private push(ev: InfvizEvent) {
    const i = this.events.length;
    this.events.push(ev);
    this.timeline.add(ev, i);
  }

  append(ev: InfvizEvent) {
    if (ev.type === 'config' && this.events.length > 0) {
      const follow = this.follow;
      this.load([], this.label, this.mode); // engine restarted: fresh session
      this.follow = follow;
      this.playing = follow;
    }
    this.push(ev);
    if (this.cursor === 0) this.setPos(this.pos);
    this.touch();
  }

  private advanceTo(target: number) {
    while (this.cursor < target) {
      this.state = apply(this.state, this.events[this.cursor]);
      this.cursor++;
      if (this.cursor % CP_EVERY === 0 && !this.cps.has(this.cursor)) this.cps.set(this.cursor, this.state);
    }
  }

  private seekIndex(target: number) {
    target = Math.max(0, Math.min(this.events.length, target));
    if (target === this.cursor) return;
    if (target < this.cursor) {
      let base = Math.floor(target / CP_EVERY) * CP_EVERY;
      while (base > 0 && !this.cps.has(base)) base -= CP_EVERY;
      this.state = base > 0 ? this.cps.get(base)! : initialState();
      this.cursor = base;
    }
    this.advanceTo(target);
  }

  /** the one way the playhead moves */
  setPos(p: number) {
    this.pos = Math.max(0, Math.min(this.maxPos, p));
    this.seekIndex(this.timeline.cursorAt(this.pos));
    this.touch();
  }

  /** user scrub / deep link: settle on the end of step S (or any fractional pos) */
  seek(p: number) {
    if (this.mode === 'live') {
      this.follow = false;
      this.playing = false;
    }
    this.setPos(p);
  }
  seekStep(S: number) {
    this.seek(Math.round(S) + 1);
  }
  stepBy(d: number) {
    this.pause();
    this.seek(Math.round(this.pos) + d);
  }

  setSpeed(x: number) {
    this.speed = x;
    this.touch();
  }
  play() {
    if (this.mode === 'replay' && this.atEnd) this.setPos(0);
    this.playing = true;
    if (this.mode === 'live' && this.atEnd) this.follow = true;
    this.touch();
  }
  pause() {
    this.playing = false;
    if (this.mode === 'live') this.follow = false;
    this.touch();
  }
  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }
  followLive() {
    if (this.mode !== 'live') return;
    this.follow = true;
    this.playing = true;
    this.touch();
  }

  /** advance by wall-clock dt (ms) */
  tick(dtMs: number) {
    if (!this.playing) return;
    const head = this.maxPos;
    let rate = BASE_STEPS_PER_SEC * this.speed;
    if (this.mode === 'live' && this.follow) {
      // joined late / fell far behind: jump, don't replay history in fast-forward
      if (head - this.pos > 4) this.setPos(head - 1);
      // chase the head: never fall more than ~1.5 steps behind a fast engine
      rate = Math.max(rate, (head - this.pos) * 2.5);
    }
    const dp = (dtMs / 1000) * rate;
    if (this.stepwise) {
      this.stepAcc += dp;
      if (this.stepAcc < 1) return;
      this.stepAcc -= Math.floor(this.stepAcc);
      this.setPos(Math.floor(this.pos) + 1);
    } else if (this.pos < head) {
      this.setPos(Math.min(head, this.pos + dp));
    }
    if (this.atEnd && this.mode === 'replay') {
      this.playing = false;
      this.touch();
    }
  }
}
