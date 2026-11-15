"""Regenerate the README figures from the committed demo trace.

    python scripts/readme_figures.py          # -> assets/hero-light.svg, assets/pipeline-light.svg

Everything drawn in the hero comes from web/public/demo.jsonl (a real engine run): the KV
pool is the reducer's state at STEP, the lanes are the run's step_begin/token events, and the
speculation round is a real draft_propose/verify pair. Ink on paper: identity is not colour
here, so the encodings are fill (owned), dots (shared prefix), hatch (cached / rejected).
"""
from __future__ import annotations

import json
import sys
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine" / "src"))
from infviz.replay import State  # noqa: E402  (pure reducer, no torch needed)

TRACE = ROOT / "web" / "public" / "demo.jsonl"
OUT = ROOT / "assets"
STEP = 45  # KV snapshot + playhead
ROUND = (24, 8)  # (step, rid) of the speculation round shown

PAPER, INK, INK2, INK3, RULE = "#F5F4F0", "#161513", "#47443E", "#85806F", "#C9C4B6"
MONO = "ui-monospace, Menlo, Consolas, 'DejaVu Sans Mono', monospace"
SERIF = "Charter, 'Bitstream Charter', 'Iowan Old Style', Georgia, 'Times New Roman', serif"

DEFS = f"""<defs>
  <pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <line x1="0" y1="0" x2="0" y2="5" stroke="{INK}" stroke-width="1.5"/></pattern>
  <pattern id="hatchl" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <line x1="0" y1="0" x2="0" y2="5" stroke="{INK3}" stroke-width="1.1"/></pattern>
  <pattern id="dots" width="4" height="4" patternUnits="userSpaceOnUse">
    <circle cx="2" cy="2" r="1.05" fill="{INK}"/></pattern>
  <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
    <path d="M0,1.5 L9,5 L0,8.5" fill="none" stroke="{INK}" stroke-width="1.4"/></marker>
</defs>"""


def t(x, y, s, size=12.5, fill=INK3, font=MONO, anchor="start", weight=400, ls=None, extra=""):
    lsa = f' letter-spacing="{ls}"' if ls else ""
    return (f'<text x="{x:.1f}" y="{y:.1f}" font-family="{font}" font-size="{size}" font-weight="{weight}"'
            f' fill="{fill}" text-anchor="{anchor}"{lsa}{extra}>{escape(s)}</text>')


def fade(body: str, delay: float) -> str:
    return (f'<g opacity="0"><animate attributeName="opacity" from="0" to="1" dur="0.9s" begin="{delay}s" fill="freeze"/>'
            f'<animateTransform attributeName="transform" type="translate" from="0 10" to="0 0" dur="0.9s" begin="{delay}s" fill="freeze"/>'
            f"{body}</g>")


def load():
    return [json.loads(line) for line in TRACE.open()]


# --------------------------------------------------------------------------- hero
def kv_panel(events, x0, y0) -> str:
    s = State()
    for e in events:
        if e["type"] != "snapshot" and e["step"] > STEP:
            break
        if e["type"] != "snapshot":
            s.apply(e)
    blocks = s.pools["target"]
    cfg = events[0]
    bs = cfg["block_size"]
    g = 4
    c, cg, bg, cols = 8, 2, 12, 8
    bw = g * c + (g - 1) * cg
    out = [t(x0, y0, f"KV CACHE · TARGET POOL · STEP {STEP}", 11, ls=1.1)]
    out.append(f'<line x1="{x0}" y1="{y0 + 9}" x2="{x0 + 400}" y2="{y0 + 9}" stroke="{RULE}" stroke-width="1"/>')
    y1 = y0 + 26
    for i, b in enumerate(blocks):
        bx = x0 + (i % cols) * (bw + bg)
        by = y1 + (i // cols) * (bw + bg)
        shared = b["state"] == "used" and len(b["owners"]) > 1
        if shared:  # stacked ghost layer, as in the UI
            out.append(f'<rect x="{bx + 3.5}" y="{by - 3.5}" width="{bw}" height="{bw}" fill="{PAPER}" stroke="{INK3}" stroke-width="0.9"/>')
        for k in range(bs):
            cx = bx + (k % g) * (c + cg)
            cy = by + (k // g) * (c + cg)
            if b["state"] == "free" or k >= b["filled"]:
                out.append(f'<rect x="{cx + .5}" y="{cy + .5}" width="{c - 1}" height="{c - 1}" fill="none" stroke="{RULE}" stroke-width="0.8"/>')
            elif b["state"] == "cached":
                out.append(f'<rect x="{cx}" y="{cy}" width="{c}" height="{c}" fill="url(#hatchl)"/>')
            elif shared:
                out.append(f'<rect x="{cx}" y="{cy}" width="{c}" height="{c}" fill="url(#dots)"/>')
            else:
                out.append(f'<rect x="{cx}" y="{cy}" width="{c}" height="{c}" fill="{INK}"/>')
    n = {k: sum(1 for b in blocks if b["state"] == k) for k in ("used", "cached", "free")}
    n_shared = sum(1 for b in blocks if b["state"] == "used" and len(b["owners"]) > 1)
    ly = y1 + 5 * (bw + bg) + 6
    leg = [("owned", f'fill="{INK}"', n["used"]), ("shared", 'fill="url(#dots)"', n_shared),
           ("cached", 'fill="url(#hatchl)"', n["cached"]), ("free", f'fill="none" stroke="{RULE}"', n["free"])]
    lx = x0
    for name, fill, cnt in leg:
        out.append(f'<rect x="{lx}" y="{ly - 8}" width="9" height="9" {fill}/>')
        label = f"{name} {cnt}" if cnt is not None else name
        out.append(t(lx + 14, ly, label, 11, INK2))
        lx += 16 + 7.2 * len(label) + 16
    return "".join(out)


def lanes_panel(events, x0, y0, w=470) -> str:
    max_step = max(e["step"] for e in events)
    k1 = events[0]["spec_k"] + 1
    reqs: dict[int, dict] = {}
    cur = None
    marks: list[tuple[int, int, str, int]] = []  # (rid, step, kind, n)
    committed: dict[tuple[int, int], int] = {}
    for e in events:
        ty = e["type"]
        if ty == "req_arrive":
            reqs[e["rid"]] = {"arrive": e["step"], "admit": [], "preempt": [], "finish": None}
        elif ty == "req_admit":
            reqs[e["rid"]]["admit"].append(e["step"])
        elif ty == "req_preempt":
            reqs[e["rid"]]["preempt"].append(e["step"])
        elif ty == "req_finish":
            reqs[e["rid"]]["finish"] = e["step"]
        elif ty == "step_begin":
            cur = e
            for b in e["batch"]:
                marks.append((b["rid"], e["step"], b["phase"], 0))
        elif ty == "token" and cur:
            key = (e["rid"], cur["step"])
            committed[key] = committed.get(key, 0) + 1
    sx = w / (max_step + 1)
    X = lambda s: x0 + s * sx  # noqa: E731
    rows = sorted(reqs)
    lh = min(14.0, 238 / max(1, len(rows)))
    out = [t(x0, y0, f"CONTINUOUS BATCHING · {len(rows)} REQUESTS · {max_step} STEPS", 11, ls=1.1)]
    out.append(f'<line x1="{x0}" y1="{y0 + 9}" x2="{x0 + w}" y2="{y0 + 9}" stroke="{RULE}" stroke-width="1"/>')
    top = y0 + 24
    rowy = {rid: top + i * lh for i, rid in enumerate(rows)}
    for rid, r in reqs.items():
        y = rowy[rid] + lh / 2
        end = r["admit"][0] if r["admit"] else max_step
        out.append(f'<line x1="{X(r["arrive"]):.1f}" y1="{y:.1f}" x2="{X(end):.1f}" y2="{y:.1f}" stroke="{INK3}" stroke-width="1" stroke-dasharray="1.5 2.5"/>')
        for p in r["preempt"]:
            px, d = X(p) + sx / 2, 3
            out.append(f'<path d="M{px - d:.1f},{y - d:.1f} L{px + d:.1f},{y + d:.1f} M{px + d:.1f},{y - d:.1f} L{px - d:.1f},{y + d:.1f}" stroke="{INK}" stroke-width="1.4"/>')
    for rid, st, phase, _ in marks:
        y = rowy[rid]
        future = st > STEP
        fill = RULE if future else INK
        bw = max(1.0, sx - 1.2)
        if phase == "prefill":
            out.append(f'<rect x="{X(st):.1f}" y="{y + 2:.1f}" width="{bw:.1f}" height="{lh - 4:.1f}" fill="{fill if future else "url(#hatch)"}" stroke="{fill}" stroke-width="0.8"/>')
        else:
            n = min(committed.get((rid, st), 1), k1)
            hh = max(1.5, (lh - 4) * n / k1)
            out.append(f'<rect x="{X(st):.1f}" y="{y + lh - 2 - hh:.1f}" width="{bw:.1f}" height="{hh:.1f}" fill="{fill}"/>')
    ph = X(STEP + 1)
    out.append(f'<line x1="{ph:.1f}" y1="{top - 6}" x2="{ph:.1f}" y2="{top + len(rows) * lh + 4:.1f}" stroke="{INK}" stroke-width="1.2"/>')
    out.append(f'<rect x="{ph - 13:.1f}" y="{top - 18}" width="26" height="13" fill="{INK}"/>')
    out.append(t(ph, top - 8.5, str(STEP), 10, PAPER, anchor="middle", weight=600))
    ly = top + len(rows) * lh + 18
    out.append(t(x0, ly, "prefill (hatched) · decode ticks = tokens committed · ×  preempted · grey = after the playhead", 11, INK2))
    return "".join(out)


def chip(x, y, text, kind) -> tuple[str, float]:
    shown = text.replace("\n", "↵").replace(" ", "·", 1) if text.startswith(" ") else text.replace("\n", "↵")
    w = 9 + 7.6 * len(shown)
    h = 22
    if kind == "draft":
        r = f'<rect x="{x + .5}" y="{y + .5}" width="{w - 1}" height="{h - 1}" fill="none" stroke="{INK3}" stroke-dasharray="3 2"/>'
        fill = INK3
    elif kind == "acc":
        r = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{INK}"/>'
        fill = PAPER
    elif kind == "rej":
        r = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="url(#hatch)" stroke="{INK}" stroke-width="1.2"/><rect x="{x + 3}" y="{y + 5}" width="{w - 6}" height="{h - 10}" fill="{PAPER}"/>'
        fill = INK
    elif kind == "void":
        r = f'<rect x="{x + .5}" y="{y + .5}" width="{w - 1}" height="{h - 1}" fill="none" stroke="{RULE}"/><line x1="{x + 4}" y1="{y + h / 2}" x2="{x + w - 4}" y2="{y + h / 2}" stroke="{INK3}"/>'
        fill = INK3
    else:  # fix
        r = f'<rect x="{x + .75}" y="{y + .75}" width="{w - 1.5}" height="{h - 1.5}" fill="none" stroke="{INK}" stroke-width="1.5"/>'
        fill = INK
    return r + t(x + w / 2, y + 15, shown, 12.5, fill, anchor="middle"), w


def spec_panel(events, x0, y0) -> str:
    step, rid = ROUND
    prop = ver = None
    prompt = ""
    for e in events:
        if e["type"] == "req_arrive" and e["rid"] == rid:
            prompt = e["prompt_text"]
        if e["step"] == step and e.get("rid") == rid:
            if e["type"] == "draft_propose":
                prop = e
            if e["type"] == "verify":
                ver = e
    n = ver["n_accepted"]
    out = [t(x0, y0, "SPECULATION · ONE REAL ROUND", 11, ls=1.1)]
    out.append(f'<line x1="{x0}" y1="{y0 + 9}" x2="{x0 + 290}" y2="{y0 + 9}" stroke="{RULE}" stroke-width="1"/>')
    out.append(t(x0, y0 + 32, f"r{rid} · “{prompt}”", 12, INK2, font=SERIF, extra=' font-style="italic"'))
    rows = [("1  draft model proposes k = 4", [(tx, "draft") for tx in prop["texts"]], None),
            ("2  target verifies all four in one pass",
             [(tx, "acc" if i < n else "rej" if i == n else "void") for i, tx in enumerate(prop["texts"])], ver["target_text"])]
    y = y0 + 58
    for label, chips, fix in rows:
        out.append(t(x0, y, label, 11, INK2))
        x = x0
        y += 10
        for tx, kind in chips:
            body, w = chip(x, y, tx, kind)
            out.append(body)
            x += w + 5
        if fix:
            out.append(t(x + 4, y + 15, "→", 13, INK))
            body, w = chip(x + 20, y + 0, fix, "fix")
            out.append(body)
        y += 50
    out.append(t(x0, y - 8, f"3  commits {n} drafted + 1 own token = {n + 1}", 11, INK2))
    out.append(t(x0, y + 8, "   tokens for a single target forward pass", 11, INK2))
    return "".join(out)


def hero(events) -> str:
    W, H = 1280, 520
    head = [f'<rect width="{W}" height="{H}" fill="{PAPER}"/>',
            t(40, 40, "INFVIZ · A VISUAL DEBUGGER FOR LLM INFERENCE · QWEN2.5-1.5B ← 0.5B DRAFT", 12.5, ls=1.2),
            f'<line x1="40" y1="56" x2="{W - 40}" y2="56" stroke="{INK}" stroke-width="1.2"/>']
    title = (t(40, 118, "Watch an inference server think.", 50, INK, SERIF) +
             t(40, 152, "Every KV block, every batch step and every draft token, rebuilt from a real engine’s events.", 19, INK2, SERIF))
    body = (fade(title, 0.0) + fade(kv_panel(events, 40, 200), 0.35) + fade(lanes_panel(events, 470, 200), 0.6) +
            fade(spec_panel(events, 950, 200), 0.85))
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" '
            f'aria-label="infviz: the KV cache, continuous batching and one speculative-decoding round from a real engine trace.">'
            f"{DEFS}{''.join(head)}{body}</svg>\n")


# --------------------------------------------------------------------------- pipeline
def box(x, y, w, h, title, lines, dashed=False) -> str:
    da = ' stroke-dasharray="4 3"' if dashed else ""
    out = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{PAPER}" stroke="{INK}" stroke-width="1.2"{da}/>',
           t(x + 14, y + 24, title, 15, INK, SERIF, weight=600)]
    for i, line in enumerate(lines):
        out.append(t(x + 14, y + 46 + i * 18, line, 11.5, INK2))
    return "".join(out)


def arrow(x1, y1, x2, y2, label="", above=True) -> str:
    out = f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{INK}" stroke-width="1.3" marker-end="url(#arr)"/>'
    if label:
        out += t((x1 + x2) / 2, (y1 + y2) / 2 + (-8 if above else 16), label, 11, INK3, anchor="middle", ls=0.6)
    return out


def pipeline() -> str:
    W, H = 1280, 330
    parts = [f'<rect width="{W}" height="{H}" fill="{PAPER}"/>',
             t(40, 34, "HOW IT FITS TOGETHER", 12.5, ls=1.2),
             f'<line x1="40" y1="48" x2="{W - 40}" y2="48" stroke="{INK}" stroke-width="1.2"/>']
    parts.append(box(40, 78, 330, 168, "engine  (PyTorch · MPS / CUDA)", [
        "scheduler: admit · reserve KV · preempt",
        "paged KV pools: target + draft",
        "draft k tokens → one target verify pass",
        "accept · roll back · commit · finish",
        "every state change → one event"]))
    parts.append(f'<line x1="370" y1="162" x2="420" y2="162" stroke="{INK}" stroke-width="1.3"/>')
    parts.append(t(395, 154, "EVENTS", 11, INK3, anchor="middle", ls=0.6))
    parts.append(arrow(420, 162, 470, 115))
    parts.append(arrow(420, 162, 470, 209))
    parts.append(box(470, 78, 250, 74, "WebSocket  /ws", ["live: config + snapshot + stream"]))
    parts.append(box(470, 172, 250, 74, "trace.jsonl", ["record once, replay anywhere"]))
    parts.append(arrow(720, 115, 812, 150))
    parts.append(arrow(720, 209, 812, 174))
    parts.append(box(812, 78, 180, 168, "reducer", ["pure: state =", "f(events ≤ playhead)", "", "animation =", "f(playhead − t)"]))
    parts.append(arrow(992, 162, 1060, 162))
    parts.append(box(1060, 78, 180, 168, "panels", ["KV cache", "timeline", "speculation", "status · transport"]))
    parts.append(f'<path d="M902,246 V286 H205 V246" fill="none" stroke="{INK3}" stroke-width="1.1" stroke-dasharray="3 3"/>')
    parts.append(t(553, 304, "HONESTY CHECK · the reducer must reproduce every engine snapshot exactly (pytest + vitest)", 11, INK3, anchor="middle", ls=0.6))
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" '
            f'aria-label="Pipeline: the engine emits events over a WebSocket or to a trace file; a pure reducer rebuilds state for the panels.">'
            f"{DEFS}{''.join(parts)}</svg>\n")


def main() -> None:
    events = load()
    OUT.mkdir(exist_ok=True)
    (OUT / "hero-light.svg").write_text(hero(events))
    (OUT / "pipeline-light.svg").write_text(pipeline())
    print("wrote", OUT / "hero-light.svg", OUT / "pipeline-light.svg")


if __name__ == "__main__":
    main()
