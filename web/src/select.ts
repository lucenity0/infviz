// The one piece of UI state shared across panels: which request is being inspected.
// Panels read `selection.rid` every frame; nothing here touches engine state.
type Listener = (rid: number | null) => void;

class Selection {
  rid: number | null = null;
  private ls: Listener[] = [];
  set(rid: number | null) {
    if (rid === this.rid) return;
    this.rid = rid;
    for (const l of this.ls) l(rid);
  }
  toggle(rid: number) {
    this.set(this.rid === rid ? null : rid);
  }
  on(l: Listener) {
    this.ls.push(l);
  }
}

export const selection = new Selection();
