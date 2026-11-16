"""EngineHost: settings changes rebuild the engine between steps, in order. Uses a fake
engine (no weights), so these run anywhere."""
from __future__ import annotations

import queue
import threading
import time

import pytest

from infviz import loadgen
from infviz.events import Emitter
from infviz.server import ConfigBody, EngineHost


class _Tok:
    def encode(self, text, add_special_tokens=False):
        class R:
            ids = list(range(len(text) // 4))
        return R()


class FakeEngine:
    """Emits config + snapshot on construction, and step_begin/step_end per step, every
    event tagged with this engine's id so tests can tell old from new."""
    made = 0

    def __init__(self, settings: dict, em: Emitter, busy: bool = True):
        FakeEngine.made += 1
        self.eid = FakeEngine.made
        self.em, self.settings, self.busy = em, settings, busy
        self.tok, self.bs, self.device = _Tok(), 16, "cpu"
        self._wake = threading.Event()
        self.added: list[str] = []
        em.emit("config", eid=self.eid, pools={"target": {"n_blocks": settings["blocks"]}})
        em.emit("snapshot", eid=self.eid)

    def has_work(self) -> bool:
        return self.busy

    def step(self) -> bool:
        self.em.step += 1
        self.em.emit("step_begin", eid=self.eid, batch=[])
        time.sleep(0.002)
        self.em.emit("step_end", eid=self.eid, ms=2)
        return True

    def add_request(self, prompt, max_new_tokens=128, *, system=""):
        self.added.append(prompt)
        return len(self.added) - 1

    def wake(self) -> None:
        self._wake.set()


SETTINGS = {"blocks": 56, "max_batch": 6, "speculation": True, "spec_k": 4}


@pytest.fixture
def running_host():
    host = EngineHost(lambda st, em: FakeEngine(st, em), SETTINGS, draft_available=True)
    stop = threading.Event()
    th = threading.Thread(target=host.run_forever, args=(stop,), daemon=True)
    th.start()
    yield host
    stop.set()
    th.join(2)


def test_restart_is_ordered_and_resets_the_session(running_host):
    host = running_host
    got: queue.Queue = queue.Queue()
    host.em.subscribe(got.put)
    time.sleep(0.05)
    old = host.engine.eid
    host.request_restart({**SETTINGS, "blocks": 24})
    time.sleep(0.05)
    evs = []
    while not got.empty():
        evs.append(got.get())
    new = host.engine.eid
    assert new != old and host.epoch == 1
    i = max(j for j, e in enumerate(evs) if e["type"] == "config")
    assert evs[i]["eid"] == new and evs[i]["pools"]["target"]["n_blocks"] == 24
    assert all(e["eid"] == new for e in evs[i:]), "an old-engine event followed the new config"
    assert evs[i + 1]["type"] == "snapshot"
    first_step = next(e for e in evs[i:] if e["type"] == "step_begin")
    assert first_step["step"] == 1, "the step counter restarts with the session"
    assert evs[i]["t"] < 0.5, "the clock restarts with the session"


def test_late_joiner_after_restart_sees_only_the_new_session(running_host):
    host = running_host
    host.request_restart({**SETTINGS, "blocks": 30})
    backlog = host.em.subscribe(lambda e: None)
    assert backlog[0]["type"] == "config" and backlog[0]["eid"] == host.engine.eid
    assert all(e["eid"] == host.engine.eid for e in backlog)


def test_a_load_burst_stops_when_the_engine_is_rebuilt(running_host):
    host = running_host
    old = host.engine
    loadgen.start_live(host, n=200, rate=200.0, seed=1)
    time.sleep(0.1)
    host.request_restart({**SETTINGS, "blocks": 40})
    new = host.engine
    time.sleep(0.3)
    assert len(old.added) > 0
    assert len(new.added) <= 1, "the old burst kept feeding the new engine"


def test_a_failed_rebuild_keeps_serving_the_last_good_settings():
    def factory(st, em):
        if st["blocks"] == 13:
            raise RuntimeError("boom")
        return FakeEngine(st, em, busy=False)

    host = EngineHost(factory, SETTINGS, draft_available=True)
    stop = threading.Event()
    threading.Thread(target=host.run_forever, args=(stop,), daemon=True).start()
    try:
        with pytest.raises(RuntimeError):
            host.request_restart({**SETTINGS, "blocks": 13})
        assert host.settings == SETTINGS
        assert host.engine.settings == SETTINGS
        assert host.em.config["pools"]["target"]["n_blocks"] == 56
    finally:
        stop.set()


def test_validation_limits_and_pool_floor():
    host = EngineHost(lambda st, em: FakeEngine(st, em, busy=False), SETTINGS, draft_available=False)
    with pytest.raises(ValueError, match="without a draft"):
        host.validate(ConfigBody(blocks=56, max_batch=6, speculation=True, spec_k=4))
    with pytest.raises(ValueError, match="max_batch"):
        host.validate(ConfigBody(blocks=56, max_batch=0, speculation=False))
    floor = host.pool_floor(0)
    assert floor >= 2
    with pytest.raises(ValueError, match="too small"):
        host.validate(ConfigBody(blocks=max(8, floor - 1), max_batch=6, speculation=False))
    ok = host.validate(ConfigBody(blocks=floor, max_batch=6, speculation=False, spec_k=4))
    assert ok == {"blocks": floor, "max_batch": 6, "speculation": False, "spec_k": 0}
    assert host.pool_floor(8) >= host.pool_floor(0)
