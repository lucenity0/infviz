"""Live server: an engine loop in a thread, events broadcast over WebSocket, and engine
settings that can be changed from the browser (the engine is rebuilt between steps).

Ordering guarantee: a settings change is applied ON THE ENGINE THREAD, between two
steps. The emitter is reset (step 0, new clock, empty backlog) and the new engine emits
its `config` and `snapshot`, so no event from the old engine can follow the new config.
Open WebSockets stay attached to the same emitter and simply see a new session begin.
"""
from __future__ import annotations

import asyncio
import math
import threading
from contextlib import asynccontextmanager
from typing import Any, Callable

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from . import loadgen
from .events import Emitter

LIMITS = {"blocks": (8, 512), "max_batch": (1, 16), "spec_k": (1, 8)}


class ReqBody(BaseModel):
    prompt: str
    max_new_tokens: int = 128


class LoadBody(BaseModel):
    n: int = 12
    rate: float = 1.0


class SpeedBody(BaseModel):
    step_delay: float


class ConfigBody(BaseModel):
    blocks: int
    max_batch: int
    speculation: bool
    spec_k: int = 4


Factory = Callable[[dict, Emitter], Any]


class EngineHost:
    """Owns the current engine, the shared emitter and the settings it was built from.
    `factory(settings, emitter)` builds an engine (reusing loaded weights)."""

    def __init__(self, factory: Factory, settings: dict, *, draft_available: bool,
                 step_delay: float = 0.0) -> None:
        self.factory = factory
        self.em = Emitter()
        self.settings = dict(settings)
        self.draft_available = draft_available
        self.step_delay = step_delay
        self.epoch = 0  # bumps on every rebuild; load generators stop when it changes
        self.engine = factory(self.settings, self.em)
        self._pending: tuple[dict, threading.Event, dict] | None = None
        self._longest: int | None = None
        self._lock = threading.Lock()

    # ---------------------------------------------------------------- settings
    def pool_floor(self, k: int) -> int:
        """Smallest pool (blocks) in which every built-in load-generator request fits alone."""
        eng = self.engine
        if self._longest is None:  # same tokenizer across rebuilds: measure once
            from .engine import chat_prompt

            self._longest = max(
                len(eng.tok.encode(chat_prompt(prompt, system), add_special_tokens=False).ids) + max_new
                for system in loadgen.SYSTEMS
                for prompt, max_new in loadgen.PROMPTS
            )
        return math.ceil((self._longest + k + 1 + eng.bs) / eng.bs)

    def describe(self) -> dict:
        return {
            "settings": self.settings,
            "draft_available": self.draft_available,
            "limits": LIMITS,
            "floors": {k: self.pool_floor(k) for k in range(0, LIMITS["spec_k"][1] + 1)},
            "step_delay": self.step_delay,
            "epoch": self.epoch,
        }

    def validate(self, body: ConfigBody) -> dict:
        def rng(name: str, v: int) -> int:
            lo, hi = LIMITS[name]
            if not lo <= v <= hi:
                raise ValueError(f"{name} must be between {lo} and {hi}")
            return v

        spec = bool(body.speculation)
        if spec and not self.draft_available:
            raise ValueError("this server was started without a draft model (--draft none)")
        k = rng("spec_k", body.spec_k) if spec else 0
        blocks = rng("blocks", body.blocks)
        floor = self.pool_floor(k)
        if blocks < floor:
            raise ValueError(f"{blocks} blocks is too small: the longest built-in request needs {floor} at k = {k}")
        return {"blocks": blocks, "max_batch": rng("max_batch", body.max_batch), "speculation": spec, "spec_k": k}

    def request_restart(self, settings: dict, timeout: float = 180.0) -> dict:
        """Called from a request handler: queue the change and wait for the engine thread."""
        done, box = threading.Event(), {}
        with self._lock:
            self._pending = (settings, done, box)
        self.engine.wake()
        if not done.wait(timeout):
            raise TimeoutError("engine did not restart in time")
        if "error" in box:
            raise box["error"]
        return box["settings"]

    def apply_pending(self) -> None:
        """Engine thread only, between steps."""
        with self._lock:
            p, self._pending = self._pending, None
        if p is None:
            return
        settings, done, box = p
        try:
            self.em.reset()
            self.engine = self.factory(settings, self.em)
            self.settings = settings
            box["settings"] = settings
        except Exception as e:  # keep serving: rebuild with the last good settings
            box["error"] = e
            self.em.reset()
            self.engine = self.factory(self.settings, self.em)
        finally:
            self.epoch += 1
            _empty_device_cache(self.engine)
            done.set()

    # ---------------------------------------------------------------- loop
    def run_forever(self, stop: threading.Event) -> None:
        while not stop.is_set():
            self.apply_pending()
            eng = self.engine
            if eng.has_work():
                eng.step()
                if self.step_delay:
                    stop.wait(self.step_delay)
            else:
                eng._wake.wait(0.25)
                eng._wake.clear()


def _empty_device_cache(engine: Any) -> None:
    try:
        import torch

        dev = getattr(engine, "device", "")
        if dev == "mps":
            torch.mps.empty_cache()
        elif str(dev).startswith("cuda"):
            torch.cuda.empty_cache()
    except Exception:
        pass


def create_app(host: EngineHost) -> FastAPI:
    stop = threading.Event()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        th = threading.Thread(target=host.run_forever, args=(stop,), daemon=True)
        th.start()
        yield
        stop.set()

    app = FastAPI(lifespan=lifespan)

    @app.websocket("/ws")
    async def ws(sock: WebSocket):
        await sock.accept()
        loop = asyncio.get_running_loop()
        q: asyncio.Queue = asyncio.Queue()

        def sink(ev: dict) -> None:
            loop.call_soon_threadsafe(q.put_nowait, ev)

        backlog = host.em.subscribe(sink)
        try:
            for e in backlog:
                await sock.send_json(e)
            while True:
                await sock.send_json(await q.get())
        except WebSocketDisconnect:
            pass
        finally:
            host.em.unsubscribe(sink)

    @app.post("/api/requests")
    def add(body: ReqBody):
        try:
            rid = host.engine.add_request(body.prompt, body.max_new_tokens)
        except ValueError as e:
            raise HTTPException(400, str(e))
        host.engine.wake()
        return {"rid": rid}

    @app.post("/api/load")
    def load(body: LoadBody):
        loadgen.start_live(host, body.n, body.rate)
        return {"ok": True}

    @app.post("/api/speed")
    def speed(body: SpeedBody):
        host.step_delay = max(0.0, min(body.step_delay, 5.0))
        return {"step_delay": host.step_delay}

    @app.get("/api/config")
    def get_config():
        return host.describe()

    @app.post("/api/config")
    def set_config(body: ConfigBody):
        try:
            settings = host.validate(body)
        except ValueError as e:
            raise HTTPException(400, str(e))
        try:
            host.request_restart(settings)
        except Exception as e:
            raise HTTPException(500, f"restart failed: {e}")
        return host.describe()

    return app
