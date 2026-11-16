"""Reference reducer: rebuild engine state purely from events and check it against every
snapshot in a trace. This is the honesty check — the web reducer must agree with it."""
from __future__ import annotations

import json
import sys


class State:
    def __init__(self) -> None:
        self.pools: dict[str, list[dict]] = {}
        self.waiting: list[int] = []
        self.running: list[int] = []
        self.finished: list[int] = []

    def apply(self, e: dict) -> None:
        t = e["type"]
        if t == "config":  # a new session (the live server rebuilt its engine): start over
            self.__init__()
            self.pools = {
                name: [{"state": "free", "owners": [], "filled": 0} for _ in range(p["n_blocks"])]
                for name, p in e["pools"].items()
            }
        elif t == "req_arrive":
            self.waiting.append(e["rid"])
        elif t == "req_admit":
            self.waiting.remove(e["rid"])
            self.running.append(e["rid"])
        elif t == "req_preempt":
            self.running.remove(e["rid"])
            self.waiting.insert(0, e["rid"])
        elif t == "req_finish":
            self.running.remove(e["rid"])
            self.finished.append(e["rid"])
        elif t.startswith("block_"):
            b = self.pools[e["pool"]][e["block"]]
            if t == "block_alloc":
                b.update(state="used", owners=[e["rid"]], filled=0)
            elif t == "block_hit":
                b["state"] = "used"
                b["owners"] = sorted(set(b["owners"]) | {e["rid"]})
            elif t == "block_fill":
                b["filled"] = e["filled"]
            elif t == "block_release":
                b["owners"] = [o for o in b["owners"] if o != e["rid"]]
            elif t == "block_cache":
                b.update(state="cached", owners=[])
            elif t in ("block_free", "block_evict"):
                b.update(state="free", owners=[], filled=0)

    def snapshot(self) -> dict:
        return {
            "pools": {k: {"blocks": v} for k, v in self.pools.items()},
            "waiting": self.waiting,
            "running": self.running,
            "finished": self.finished,
        }


def check_events(events) -> int:
    """Returns number of snapshots verified; raises AssertionError on the first mismatch."""
    s, n = State(), 0
    for e in events:
        if e["type"] == "snapshot":
            got = s.snapshot()
            want = {k: e[k] for k in ("pools", "waiting", "running", "finished")}
            if got != want:
                for name in want["pools"]:
                    for i, (g, w) in enumerate(zip(got["pools"][name]["blocks"], want["pools"][name]["blocks"])):
                        if g != w:
                            raise AssertionError(f"step {e['step']} {name}[{i}]: replay={g} engine={w}")
                raise AssertionError(f"step {e['step']}: queues differ: {got} vs {want}")
            n += 1
        else:
            s.apply(e)
    return n


def main(path: str) -> None:
    with open(path) as f:
        n = check_events(json.loads(line) for line in f)
    print(f"OK: {n} snapshots reproduced exactly from events")


if __name__ == "__main__":
    main(sys.argv[1])
