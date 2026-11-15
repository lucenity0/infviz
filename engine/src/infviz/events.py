"""Event emitter. See docs/EVENTS.md for the protocol."""
from __future__ import annotations

import json
import threading
import time
from typing import Any, Callable

Sink = Callable[[dict[str, Any]], None]


class Emitter:
    def __init__(self) -> None:
        self.t0 = time.perf_counter()
        self.step = 0
        self.sinks: list[Sink] = []
        self.config: dict | None = None
        # events since (and including) the last snapshot, so late joiners get a consistent view
        self.since_snapshot: list[dict] = []
        self.lock = threading.Lock()

    def emit(self, type_: str, **fields: Any) -> dict:
        ev = {"type": type_, "step": self.step, "t": round(time.perf_counter() - self.t0, 6), **fields}
        with self.lock:
            if type_ == "config":
                self.config = ev
            elif type_ == "snapshot":
                self.since_snapshot = [ev]
            elif self.since_snapshot:
                self.since_snapshot.append(ev)
            sinks = list(self.sinks)
        for s in sinks:
            s(ev)
        return ev

    def subscribe(self, sink: Sink) -> list[dict]:
        """Atomically attach ``sink`` and return the backlog a late joiner needs
        (config + last snapshot + events since). Every later event goes to ``sink``
        exactly once, after the backlog."""
        with self.lock:
            self.sinks.append(sink)
            return ([self.config] if self.config else []) + list(self.since_snapshot)

    def unsubscribe(self, sink: Sink) -> None:
        with self.lock:
            if sink in self.sinks:
                self.sinks.remove(sink)


class JsonlSink:
    def __init__(self, path: str) -> None:
        self.f = open(path, "w")

    def __call__(self, ev: dict) -> None:
        self.f.write(json.dumps(ev, separators=(",", ":")) + "\n")

    def close(self) -> None:
        self.f.close()
