"""Live server: engine loop in a thread, events broadcast over WebSocket."""
from __future__ import annotations

import asyncio
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from . import loadgen
from .engine import Engine


class ReqBody(BaseModel):
    prompt: str
    max_new_tokens: int = 128


class LoadBody(BaseModel):
    n: int = 12
    rate: float = 1.0


class SpeedBody(BaseModel):
    step_delay: float


def run_engine_forever(engine: Engine, stop: threading.Event) -> None:
    while not stop.is_set():
        if engine.has_work():
            engine.step()
            if engine.step_delay:
                stop.wait(engine.step_delay)
        else:
            engine._wake.wait(0.25)
            engine._wake.clear()


def create_app(engine: Engine) -> FastAPI:
    stop = threading.Event()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        th = threading.Thread(target=run_engine_forever, args=(engine, stop), daemon=True)
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

        backlog = engine.em.subscribe(sink)
        try:
            for e in backlog:
                await sock.send_json(e)
            while True:
                await sock.send_json(await q.get())
        except WebSocketDisconnect:
            pass
        finally:
            engine.em.unsubscribe(sink)

    @app.post("/api/requests")
    def add(body: ReqBody):
        try:
            rid = engine.add_request(body.prompt, body.max_new_tokens)
        except ValueError as e:
            raise HTTPException(400, str(e))
        engine.wake()
        return {"rid": rid}

    @app.post("/api/load")
    def load(body: LoadBody):
        loadgen.start_live(engine, body.n, body.rate)
        return {"ok": True}

    @app.post("/api/speed")
    def speed(body: SpeedBody):
        engine.step_delay = max(0.0, min(body.step_delay, 5.0))
        return {"step_delay": engine.step_delay}

    return app
