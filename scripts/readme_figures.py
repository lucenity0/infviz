"""Regenerate the README figures in infviz's own visual language.

    cd engine && uv run --with fonttools --with brotli python ../scripts/readme_figures.py
    (needs `npm install` in web/ for the OFL font files it embeds)

assets/hero.svg          an animated replay of web/public/demo.jsonl: the target KV pool, the
                         step counter, the running lanes' latest speculation round and the
                         request lanes, all on ONE clock. With animation off it is the
                         step-45 frame (the same state the app shows at ?step=45).
assets/architecture.svg  the system, labelled with the files that implement each box, with
                         one engine step animated in order.

Colours are read from web/src/tokens.ts. Only open-licence fonts (Geist Mono, Inter Tight)
are embedded, as small subsets; the Envato display face is never used here.
"""
from __future__ import annotations

import base64
import io
import json
import re
import sys
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine" / "src"))
from infviz.replay import State  # noqa: E402  (pure reducer, no torch)

TRACE = ROOT / "web" / "public" / "demo.jsonl"
OUT = ROOT / "assets"
POSTER_STEP = 45
FRAME_EVERY = 3  # sample the run every N steps
FRAME_S = 0.42  # seconds per frame
HOLD_S = 2.6  # hold on the last frame before looping

# --------------------------------------------------------------------- tokens
TOK = (ROOT / "web" / "src" / "tokens.ts").read_text()
DARK = TOK[TOK.index("const DARK"): TOK.index("const LIGHT")]


def tok(name: str) -> str:
    return re.search(rf"\b{name}: '(#[0-9a-f]{{6}})'", DARK).group(1)


BG, SUNKEN, HAIR, GRID = tok("bg"), tok("sunken"), tok("hair"), tok("grid")
INK, INK2, INK3, INK4 = tok("ink"), tok("ink2"), tok("ink3"), tok("ink4")
CACHED, DISCARD, OTHER = tok("cached"), tok("discard"), tok("other")
REQ = re.findall(r"#[0-9a-f]{6}", re.search(r"req: \[([^\]]*)\]", DARK).group(1))

# --------------------------------------------------------------------- fonts
FONTS = ROOT / "web" / "node_modules"
GM400 = FONTS / "@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff2"
GM500 = FONTS / "@fontsource/geist-mono/files/geist-mono-latin-500-normal.woff2"
IT = FONTS / "@fontsource-variable/inter-tight/files/inter-tight-latin-wght-normal.woff2"
MONO = "GM, ui-monospace, Menlo, monospace"
SANS = "IT, 'Inter Tight', ui-sans-serif, system-ui, sans-serif"
MONO_ADV = 0.6  # Geist Mono advance / em (verified: 600 / 1000)


def font_css(text: str) -> str:
    from fontTools import subset
    from fontTools.ttLib import TTFont

    chars = set(text) | set("0123456789 .,:;%×·/+-=()[]_#*\"'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
    css = []
    for path, family, weight in ((GM400, "GM", "400"), (GM500, "GM", "500"), (IT, "IT", "100 900")):
        f = TTFont(str(path))
        opts = subset.Options()
        opts.flavor = "woff2"
        opts.layout_features = ["*"]
        sub = subset.Subsetter(opts)
        sub.populate(text="".join(chars))
        sub.subset(f)
        buf = io.BytesIO()
        f.save(buf)
        b64 = base64.b64encode(buf.getvalue()).decode()
        css.append(f"@font-face{{font-family:{family};font-weight:{weight};src:url(data:font/woff2;base64,{b64}) format('woff2')}}")
    css.append(f".m{{font-family:{MONO}}}.s{{font-family:{SANS}}}")
    return "".join(css)


def T(x, y, s, size=16, fill=INK3, font=MONO, anchor="start", weight=400, ls=0.0, extra=""):
    cls = "m" if font == MONO else "s"
    lsa = f' letter-spacing="{ls}"' if ls else ""
    wa = f' font-weight="{weight}"' if weight != 400 else ""
    an = f' text-anchor="{anchor}"' if anchor != "start" else ""
    return f'<text class="{cls}" x="{x:.1f}" y="{y:.1f}" font-size="{size}" fill="{fill}"{wa}{an}{lsa}{extra}>{escape(s)}</text>'


def mono_w(s: str, size: float) -> float:
    return len(s) * size * MONO_ADV


def arrow_path(x1, y1, x2, y2, color=INK3, w=1.4, dash="") -> str:
    da = f' stroke-dasharray="{dash}"' if dash else ""
    return f'<path d="M{x1:.1f},{y1:.1f} L{x2:.1f},{y2:.1f}" stroke="{color}" stroke-width="{w}" fill="none" marker-end="url(#ah)"{da}/>'


DEFS_COMMON = f"""<marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
  <path d="M0,1 L9,5 L0,9 z" fill="{INK3}"/></marker>
<pattern id="hz" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
  <line x1="0" y1="0" x2="0" y2="5" stroke="{DISCARD}" stroke-width="1.6"/></pattern>"""


# --------------------------------------------------------------------- trace replay
class Replay:
    """Walk the trace once; capture the state needed by the hero at every frame step."""

    def __init__(self, events):
        self.events = events
        self.cfg = events[0]
        self.max_step = max(e["step"] for e in events)
        self.frames = list(range(0, self.max_step + 1, FRAME_EVERY))
        if self.frames[-1] != self.max_step:
            self.frames.append(self.max_step)
        assert POSTER_STEP in self.frames
        self.at: dict[int, dict] = {}
        self.reqs: dict[int, dict] = {}
        self.marks: list[tuple[int, int, str, int]] = []  # rid, step, phase, tokens committed
        self._walk()

    def _walk(self):
        s = State()
        slots = [-1] * len(REQ)
        color = {}  # rid -> last colour slot
        spec = {}  # rid -> latest round {texts, n, fix}
        acc = prop = rounds = 0
        tokens = 0
        cur = None
        committed: dict[tuple[int, int], int] = {}

        def take(rid):
            if rid in slots:
                return
            if -1 in slots:
                i = slots.index(-1)
                slots[i] = rid
                color[rid] = i

        want = list(self.frames)
        evs = self.events
        for idx, e in enumerate(evs):
            ty = e["type"]
            if ty != "snapshot":
                s.apply(e)
            if ty == "req_arrive":
                take(e["rid"])
                self.reqs[e["rid"]] = {"arrive": e["step"], "admit": [], "preempt": [], "finish": None,
                                       "prompt": e["prompt_text"]}
            elif ty == "req_admit":
                take(e["rid"])
                self.reqs[e["rid"]]["admit"].append(e["step"])
            elif ty == "req_preempt":
                self.reqs[e["rid"]]["preempt"].append(e["step"])
            elif ty == "req_finish":
                if e["rid"] in slots:
                    slots[slots.index(e["rid"])] = -1
                self.reqs[e["rid"]]["finish"] = e["step"]
                spec.pop(e["rid"], None)
            elif ty == "step_begin":
                cur = e["step"]
                for b in e["batch"]:
                    self.marks.append((b["rid"], e["step"], b["phase"], 0))
            elif ty == "token":
                tokens += 1
                committed[(e["rid"], cur)] = committed.get((e["rid"], cur), 0) + 1
            elif ty == "draft_propose":
                prop += len(e["tokens"])
                spec[e["rid"]] = {"texts": e["texts"], "n": None, "fix": None}
            elif ty == "verify":
                acc += e["n_accepted"]
                rounds += 1
                if e["rid"] in spec:
                    spec[e["rid"]].update(n=e["n_accepted"], fix=e["target_text"])
            # a frame is the state after every event of its step
            nxt = evs[idx + 1]["step"] if idx + 1 < len(evs) else 10**9
            while want and nxt > want[0] and e["step"] >= want[0]:
                f = want.pop(0)
                self.at[f] = {
                    "blocks": [dict(b) for b in s.pools["target"]],
                    "color": dict(color),
                    "running": list(s.running),
                    "spec": {r: dict(v) for r, v in spec.items()},
                    "tokens": tokens,
                    "perpass": (1 + acc / rounds) if rounds else None,
                    "acc": acc,
                    "prop": prop,
                }
        self.committed = committed
        self.final_color = color


def block_color(b, color) -> str:
    if b["state"] == "cached":
        return CACHED
    if b["state"] == "used":
        if len(b["owners"]) > 1:
            return INK2
        c = color.get(b["owners"][0], -1)
        return REQ[c] if 0 <= c < len(REQ) else OTHER
    return INK4


# --------------------------------------------------------------------- hero
def hero(rp: Replay) -> str:
    W, H = 1280, 800
    F = rp.frames
    D = len(F) * FRAME_S + HOLD_S
    kt = [i * FRAME_S / D for i in range(len(F))]  # frame i starts at kt[i]
    KT = ";".join(f"{k:.4f}" for k in kt)
    anim = f'dur="{D:.2f}s" repeatCount="indefinite" begin="0s"'
    pi = F.index(POSTER_STEP)
    poster = rp.at[POSTER_STEP]
    body: list[str] = []
    text_all: list[str] = []

    def t(*a, **k):
        text_all.append(str(a[2]))
        return T(*a, **k)

    # ---- frame: hairline machine
    body.append(f'<rect width="{W}" height="{H}" fill="{BG}"/>')
    body.append(f'<rect x="0.5" y="0.5" width="{W - 1}" height="{H - 1}" fill="none" stroke="{HAIR}"/>')
    # status strip
    body.append(f'<line x1="0" y1="56" x2="{W}" y2="56" stroke="{HAIR}"/>')
    for x, w in ((34, 9), (46, 9)):
        body.append(f'<rect x="{x}" y="19" width="{w}" height="{w}" fill="{INK}"/>')
    body.append(f'<rect x="34" y="31" width="9" height="9" fill="{INK}"/><rect x="46.5" y="31.5" width="8" height="8" fill="none" stroke="{INK}"/>')
    body.append(t(66, 37, "infviz", 22, INK, SANS, weight=600))
    body.append(f'<rect x="150.5" y="18.5" width="96" height="21" fill="none" stroke="{INK3}"/><rect x="160" y="26" width="6" height="6" fill="{INK}"/>')
    body.append(t(172, 34, "REPLAY", 14, INK, weight=500, ls=1.2))
    body.append(f'<line x1="270" y1="0" x2="270" y2="56" stroke="{HAIR}"/>')
    body.append(t(292, 35, "demo.jsonl · Qwen2.5-1.5B + 0.5B draft · mps · k 4", 16, INK2))
    # headline
    body.append(t(34, 118, "Watch an inference server think.", 46, INK, SANS, weight=300, ls=-0.6))
    body.append(t(36, 152, "A real engine trace, replayed: every KV block, batch step and draft token.", 17, INK3))
    body.append(f'<line x1="0" y1="180" x2="{W}" y2="180" stroke="{HAIR}"/>')

    # ---- KV grid (target pool) — one colour animation + a growing clip per block
    kx, ky = 34, 226
    c, cg, g = 13, 2, 4
    bw = g * c + (g - 1) * cg  # 58
    bgap = 11
    cols = 8
    body.append(t(kx, ky - 18, "KV CACHE · TARGET POOL", 14, INK3, weight=500, ls=1.4))
    defs: list[str] = ["<g id=\"blk\">" + "".join(
        f'<rect x="{(k % g) * (c + cg)}" y="{(k // g) * (c + cg)}" width="{c}" height="{c}"/>' for k in range(16)) + "</g>"]
    n_blocks = len(poster["blocks"])
    for i in range(n_blocks):
        bx = kx + (i % cols) * (bw + bgap)
        by = ky + (i // cols) * (bw + bgap)
        body.append(f'<use href="#blk" x="{bx}" y="{by}" fill="{INK4}"/>')
        # filled region: full rows + partial row, as a clip
        fills = [rp.at[f]["blocks"][i]["filled"] for f in F]
        cols_v = [block_color(rp.at[f]["blocks"][i], rp.at[f]["color"]) for f in F]
        def rows_h(f):
            return (f // g) * (c + cg)
        def part_w(f):
            return (f % g) * (c + cg)
        pf = fills[pi]
        a_h = f'<animate attributeName="height" calcMode="discrete" keyTimes="{KT}" values="{";".join(str(rows_h(v)) for v in fills)}" {anim}/>' if len(set(fills)) > 1 else ""
        a_y = f'<animate attributeName="y" calcMode="discrete" keyTimes="{KT}" values="{";".join(str(by + rows_h(v)) for v in fills)}" {anim}/>' if len(set(fills)) > 1 else ""
        a_w = f'<animate attributeName="width" calcMode="discrete" keyTimes="{KT}" values="{";".join(str(part_w(v)) for v in fills)}" {anim}/>' if len(set(fills)) > 1 else ""
        defs.append(f'<clipPath id="k{i}"><rect x="{bx}" y="{by}" width="{bw}" height="{rows_h(pf)}">{a_h}</rect>'
                    f'<rect x="{bx}" y="{by + rows_h(pf)}" width="{part_w(pf)}" height="{c}">{a_y}{a_w}</rect></clipPath>')
        a_c = (f'<animate attributeName="fill" calcMode="discrete" keyTimes="{KT}" values="{";".join(cols_v)}" {anim}/>'
               if len(set(cols_v)) > 1 else "")
        body.append(f'<g clip-path="url(#k{i})"><use href="#blk" x="{bx}" y="{by}" fill="{cols_v[pi]}">{a_c}</use></g>')
    gh = 5 * (bw + bgap) - bgap
    # legend
    ly = ky + gh + 28
    lx = kx
    for name, col in (("owned (request colour)", REQ[0]), ("shared prefix", INK2), ("cached", CACHED), ("free", INK4)):
        body.append(f'<rect x="{lx}" y="{ly - 11}" width="12" height="12" fill="{col}"/>')
        body.append(t(lx + 20, ly, name, 15, INK3))
        lx += 20 + mono_w(name, 15) + 26

    # ---- right column: step counter, counters, speculation lanes
    rx = 690
    body.append(f'<line x1="{rx - 30}" y1="180" x2="{rx - 30}" y2="606" stroke="{HAIR}"/>')
    body.append(t(rx, 208, "STEP", 14, INK3, weight=500, ls=1.4))
    body.append(t(rx + 260, 208, "TOKENS / TARGET PASS", 14, INK3, weight=500, ls=1.4))
    frame_groups = []
    for fi, f in enumerate(F):
        st = rp.at[f]
        parts = []
        parts.append(t(rx - 4, 300, f"{f:02d}", 96, INK, SANS, weight=300, ls=-2))
        parts.append(t(rx + 122, 300, f"/{rp.max_step}", 22, INK3))
        pp = st["perpass"]
        parts.append(t(rx + 258, 300, f"{pp:.2f}" if pp else "-.--", 96, INK, SANS, weight=300, ls=-2))
        parts.append(t(rx + 258 + 0.57 * 96 * 3.4 + 8, 300, "×", 26, INK2))
        b = st["blocks"]
        used = sum(1 for x in b if x["state"] == "used")
        cached = sum(1 for x in b if x["state"] == "cached")
        free = sum(1 for x in b if x["state"] == "free")
        parts.append(t(rx, 336, f"{used} used · {cached} cached · {free} free · {st['tokens']} tokens out", 16, INK2))
        # speculation lanes: latest round of up to 4 running requests
        parts.append(t(rx, 384, "SPECULATION · LATEST ROUND PER LANE", 14, INK3, weight=500, ls=1.4))
        y = 404
        lanes = [r for r in st["running"] if r in st["spec"]][:4]
        for rid in lanes:
            sp = st["spec"][rid]
            cslot = st["color"].get(rid, -1)
            parts.append(f'<rect x="{rx}" y="{y + 9}" width="12" height="12" fill="{REQ[cslot] if 0 <= cslot < len(REQ) else OTHER}"/>')
            parts.append(t(rx + 20, y + 21, f"r{rid}", 16, INK, weight=500))
            x = rx + 72
            for j, tx in enumerate(sp["texts"]):
                kind = "draft" if sp["n"] is None else ("acc" if j < sp["n"] else "rej" if j == sp["n"] else "void")
                chip, w = make_chip(x, y + 3, tx, kind, text_all)
                if x + w > W - 34:
                    break
                parts.append(chip)
                x += w + 5
            if sp["n"] is not None and sp["fix"] is not None:
                if x + 30 < W - 80:
                    parts.append(arrow_path(x + 2, y + 15, x + 22, y + 15, INK3, 1.4))
                    chip, w = make_chip(x + 28, y + 3, sp["fix"], "fix", text_all)
                    if x + 28 + w <= W - 34:
                        parts.append(chip)
            y += 42
        if not lanes:
            parts.append(t(rx, 430, "no decode lanes yet", 16, INK3))
        vis = "visible" if fi == pi else "hidden"
        vals = ";".join("visible" if j == fi else "hidden" for j in range(len(F)))
        a = f'<animate attributeName="visibility" calcMode="discrete" keyTimes="{KT}" values="{vals}" {anim}/>'
        frame_groups.append(f'<g visibility="{vis}">{a}{"".join(parts)}</g>')
    body.extend(frame_groups)


    # ---- request lanes + playhead (same clock)
    lx0, lx1 = 150, W - 34
    ty0 = 636
    rows = sorted(rp.reqs)
    lh = (H - 22 - (ty0 + 24)) / len(rows)
    sx = (lx1 - lx0) / (rp.max_step + 1)
    X = lambda s: lx0 + s * sx  # noqa: E731
    body.append(f'<line x1="0" y1="606" x2="{W}" y2="606" stroke="{HAIR}"/>')
    body.append(t(34, ty0 + 2, "REQUESTS", 14, INK3, weight=500, ls=1.4))
    for s_ in range(0, rp.max_step + 1, 10):
        body.append(f'<line x1="{X(s_):.1f}" y1="{ty0 + 12}" x2="{X(s_):.1f}" y2="{H - 26}" stroke="{GRID}"/>')
        body.append(t(X(s_) + 4, ty0 + 2, str(s_), 14, INK3))
    lanes_bright, lanes_dim = [], []
    k1 = rp.cfg["spec_k"] + 1
    for i, rid in enumerate(rows):
        y = ty0 + 24 + i * lh
        r = rp.reqs[rid]
        cs = rp.final_color.get(rid, -1)
        hue = REQ[cs] if 0 <= cs < len(REQ) else OTHER
        body.append(f'<rect x="{lx0 - 18}" y="{y + 1:.1f}" width="8" height="{max(2.0, lh - 2):.1f}" fill="{hue}"/>')
        end = r["admit"][0] if r["admit"] else rp.max_step
        dots = f'<line x1="{X(r["arrive"]):.1f}" y1="{y + lh / 2:.1f}" x2="{X(end):.1f}" y2="{y + lh / 2:.1f}" stroke="{INK3}" stroke-width="1.2" stroke-dasharray="1.5 3"/>'
        lanes_bright.append(dots)
        for p in r["preempt"]:
            px, d, cy = X(p) + sx / 2, 4, y + lh / 2
            lanes_bright.append(f'<path d="M{px - d:.1f},{cy - d:.1f} L{px + d:.1f},{cy + d:.1f} M{px + d:.1f},{cy - d:.1f} L{px - d:.1f},{cy + d:.1f}" stroke="{DISCARD}" stroke-width="2"/>')
    for rid, st_, phase, _ in rp.marks:
        i = rows.index(rid)
        y = ty0 + 24 + i * lh
        cs = rp.final_color.get(rid, -1)
        hue = REQ[cs] if 0 <= cs < len(REQ) else OTHER
        bw_ = max(1.0, sx - 1.5)
        if phase == "prefill":
            m = f'<rect x="{X(st_):.1f}" y="{y + 1.5:.1f}" width="{bw_:.1f}" height="{lh - 3:.1f}" fill="{hue}"/>'
        else:
            n = min(rp.committed.get((rid, st_), 1), k1)
            hh = max(2.0, (lh - 3) * n / k1)
            m = f'<rect x="{X(st_):.1f}" y="{y + lh - 1.5 - hh:.1f}" width="{bw_:.1f}" height="{hh:.1f}" fill="{hue}"/>'
        lanes_bright.append(m)
        lanes_dim.append(m)
    # reveal up to the playhead; ahead of it, the run shows faintly
    px_vals = [X(f + 1) for f in F]
    defs.append(f'<g id="lanes">{"".join(lanes_dim)}</g>')
    body.append('<use href="#lanes" opacity="0.16"/>')
    defs.append(f'<clipPath id="reveal"><rect x="0" y="{ty0}" height="{H - ty0}" width="{px_vals[pi]:.1f}">'
                f'<animate attributeName="width" calcMode="discrete" keyTimes="{KT}" values="{";".join(f"{v:.1f}" for v in px_vals)}" {anim}/></rect></clipPath>')
    body.append(f'<g clip-path="url(#reveal)"><use href="#lanes"/>{"".join(b for b in lanes_bright if b not in set(lanes_dim))}</g>')
    tx_vals = ";".join(f"{v - px_vals[pi]:.1f},0" for v in px_vals)
    body.append(f'<g><animateTransform attributeName="transform" type="translate" calcMode="discrete" keyTimes="{KT}" values="{tx_vals}" {anim}/>'
                f'<line x1="{px_vals[pi]:.1f}" y1="{ty0 + 10}" x2="{px_vals[pi]:.1f}" y2="{H - 24}" stroke="{INK}" stroke-width="1.6"/></g>')

    css = font_css("".join(text_all) + "infviz")
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" '
            f'aria-label="infviz replaying a real engine trace: the target KV cache filling in request colours, the step counter, '
            f'speculation rounds with accepted and rejected draft tokens, and request lanes under one playhead.">'
            f"<style>{css}</style><defs>{DEFS_COMMON}{''.join(defs)}</defs>{''.join(body)}</svg>\n")


def show_tok(s: str) -> str:
    s = s.replace("\n", "\\n")
    return "·" + s[1:] if s.startswith(" ") else s


def make_chip(x, y, text, kind, text_all) -> tuple[str, float]:
    s = show_tok(text)[:12]
    text_all.append(s)
    size = 15
    w = mono_w(s, size) + 14
    h = 24
    if kind == "draft":
        r = f'<rect x="{x + .5}" y="{y + .5}" width="{w - 1}" height="{h - 1}" fill="none" stroke="{INK3}" stroke-dasharray="3 2"/>'
        fill = INK3
    elif kind == "acc":
        r = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{INK}"/>'
        fill = BG
    elif kind == "rej":
        r = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="url(#hz)" stroke="{DISCARD}" stroke-width="1.2"/>'
        fill = DISCARD
    elif kind == "void":
        r = (f'<rect x="{x + .5}" y="{y + .5}" width="{w - 1}" height="{h - 1}" fill="none" stroke="{INK4}"/>'
             f'<line x1="{x + 5}" y1="{y + h / 2}" x2="{x + w - 5}" y2="{y + h / 2}" stroke="{INK3}"/>')
        fill = INK3
    else:
        r = f'<rect x="{x + .75}" y="{y + .75}" width="{w - 1.5}" height="{h - 1.5}" fill="none" stroke="{INK}" stroke-width="1.5"/>'
        fill = INK
    return r + T(x + 7, y + 17, s, size, fill), w


# --------------------------------------------------------------------- architecture
STAGES = 9.0  # seconds per animated engine step


def arch() -> str:
    W, H = 1280, 1040
    text_all: list[str] = []
    body: list[str] = [f'<rect width="{W}" height="{H}" fill="{BG}"/>',
                       f'<rect x="0.5" y="0.5" width="{W - 1}" height="{H - 1}" fill="none" stroke="{HAIR}"/>']
    anim = f'dur="{STAGES}s" repeatCount="indefinite" begin="0s"'

    def t(x, y, s, *a, **k):
        text_all.append(s)
        return T(x, y, s, *a, **k)

    def region(y, h, label, sub):
        body.append(f'<rect x="20.5" y="{y + .5}" width="{W - 41}" height="{h}" fill="none" stroke="{HAIR}"/>')
        body.append(t(40, y + 30, label, 15, INK, weight=500, ls=1.6))
        body.append(t(W - 40, y + 30, sub, 15, INK3, anchor="end"))

    def box(x, y, w, h, title, file, lines, hl=None):
        body.append(f'<rect x="{x + .5}" y="{y + .5}" width="{w}" height="{h}" fill="{SUNKEN}" stroke="{HAIR}"/>')
        body.append(t(x + 14, y + 28, title, 18, INK, SANS, weight=600))
        body.append(t(x + 14, y + 50, file, 15, INK3))
        for i, line in enumerate(lines):
            body.append(t(x + 14, y + 76 + i * 21, line, 15, INK2))
        if hl is not None:  # the stage lights up at its moment in the step
            a, b = hl
            kt = f"0;{a / STAGES:.3f};{(a + 0.12) / STAGES:.3f};{b / STAGES:.3f};{(b + 0.5) / STAGES:.3f};1"
            body.append(f'<rect x="{x + .5}" y="{y + .5}" width="{w}" height="{h}" fill="none" stroke="{INK}" stroke-width="1.6" opacity="0">'
                        f'<animate attributeName="opacity" keyTimes="{kt}" values="0;0;1;1;0;0" {anim}/></rect>')

    def wire(d, arrow=True, color=INK3, dash=""):
        da = f' stroke-dasharray="{dash}"' if dash else ""
        me = ' marker-end="url(#ah)"' if arrow else ""
        body.append(f'<path d="{d}" stroke="{color}" stroke-width="1.4" fill="none"{me}{da}/>')

    def packet(path_d, label, color, t0, t1):
        """one event in flight along a wire during [t0, t1] of the step"""
        w = mono_w(label, 13) + 12
        text_all.append(label)
        body.append(
            f'<g opacity="0"><animate attributeName="opacity" keyTimes="0;{t0 / STAGES:.3f};{(t0 + .05) / STAGES:.3f};{(t1 - .05) / STAGES:.3f};{t1 / STAGES:.3f};1" values="0;0;1;1;0;0" {anim}/>'
            f'<animateMotion path="{path_d}" keyPoints="0;0;1;1" keyTimes="0;{t0 / STAGES:.3f};{t1 / STAGES:.3f};1" calcMode="linear" {anim}/>'
            f'<rect x="{-w / 2}" y="-10" width="{w}" height="20" fill="{color}"/>'
            f'{T(0, 4.5, label, 13, BG, anchor="middle", weight=500)}</g>')

    body.append(t(40, 52, "ARCHITECTURE", 15, INK3, weight=500, ls=1.6))
    body.append(t(40, 84, "One engine step, in order. Every box names the file that implements it.", 20, INK, SANS))

    # ---------------- engine: five stages, then the state they share
    region(110, 456, "ENGINE", "python · engine/src/infviz")
    bw, bh, gap, x0, y0 = 220, 166, 22, 40, 160
    stages = [
        ("requests in", "server.py · loadgen.py", ["POST /api/requests", "Poisson load bursts", "into the inbox"]),
        ("schedule", "engine.py · _admit", ["admit to the batch", "prefix-cache match", "reserve KV · preempt"]),
        ("draft × k", "model.py · 0.5B", ["k sequential passes", "greedy proposals", "writes draft KV"]),
        ("verify", "model.py · 1.5B", ["one ragged pass:", "prefill + verify", "k+1 logits a lane"]),
        ("commit", "engine.py · _commit", ["accept prefix + 1", "roll back the rest", "finish · release"]),
    ]
    times = [(0.3, 1.4), (1.4, 2.6), (2.6, 3.9), (3.9, 5.1), (5.1, 6.3)]
    cx = [x0 + i * (bw + gap) + bw / 2 for i in range(5)]
    for i, ((title, file, lines), hl) in enumerate(zip(stages, times)):
        x = x0 + i * (bw + gap)
        box(x, y0, bw, bh, title, file, lines, hl)
        if i:
            wire(f"M{x - gap + 3},{y0 + bh / 2} H{x - 3}")
    bus = 350
    for c_ in cx:
        wire(f"M{c_},{y0 + bh} V{bus}", arrow=False, color=INK4)
    wire(f"M{cx[0]},{bus} H1002 V{372 - 3}", color=INK3, dash="2 4")
    body.append(t(cx[0] + 10, bus - 7, "every stage emits events", 14, INK3))
    sy = 372
    box(40, sy, 340, 166, "BlockPool · target, draft", "kv.py", ["free heap · ref counts", "prefix hash index · LRU", "used by schedule, commit"])
    box(402, sy, 340, 166, "PagedKVCache", "model.py", ["K, V per layer [blocks×16,", "kv_heads, d], read through", "block-table slots"])
    box(764, sy, 476, 166, "Emitter", "events.py", ["every state change, one event", "subscribe(): backlog, then live", "snapshot every 8 steps"])

    # ---------------- transport: straight down from the emitter
    region(590, 120, "TRANSPORT", "")
    body.append(t(40, 664, "the protocol, docs/EVENTS.md: 20 event types", 15, INK2))
    body.append(t(40, 686, "req_* · step_* · block_* · draft_propose · verify · token", 15, INK2))
    box(764, 628, 226, 66, "WebSocket /ws", "server.py", [])
    box(1014, 628, 226, 66, "trace.jsonl", "cli.py record", [])
    wire(f"M877,{sy + 166} V{628 - 3}")
    wire(f"M1127,{sy + 166} V{628 - 3}")

    # ---------------- browser: source, then the pure pipeline
    region(734, 214, "BROWSER", "typescript · web/src")
    bstages = [
        ("source", "live.ts · drop", ["live or trace", "file, ?trace="]),
        ("player", "player.ts", ["playhead pos", "checkpoints"]),
        ("timeline", "timeline.ts", ["tau(event)", "per-step index"]),
        ("reducer", "reducer.ts", ["pure apply()", "state at pos"]),
        ("panels", "panels/*.ts", ["f(state, pos)", "tokens.ts"]),
    ]
    bw2, gap2, by = 222, 22, 790
    for i, (title, file, lines) in enumerate(bstages):
        x = 40 + i * (bw2 + gap2)
        box(x, by, bw2, 132, title, file, lines, (6.5 + i * 0.4, 7.4 + i * 0.25))
        if i:
            wire(f"M{x - gap2 + 3},{by + 66} H{x - 3}")
    chan = 722
    wire(f"M877,694 V{chan}", arrow=False)
    wire(f"M1127,694 V{chan} H200 V{by - 3}")

    # ---------------- what checks it
    body.append(t(40, 984, "CHECKED BY  pytest: parity with transformers · lossless speculation · allocator invariants", 15, INK3))
    body.append(t(40, 1010, "            replay.py + reducer.test.ts: the rebuilt state equals every engine snapshot", 15, INK3))

    # ---------------- one step's events, in order: stage -> bus -> emitter -> ws -> browser
    req = REQ[0]
    ev = [("req_admit", req, 1, 0.9), ("block_alloc", req, 1, 1.5), ("draft_propose", req, 2, 3.0),
          ("verify", INK, 3, 4.4), ("kv_rollback", DISCARD, 4, 5.2), ("token", req, 4, 5.8)]
    for label, color, stage, t0 in ev:
        packet(f"M{cx[stage]},{y0 + bh} V{bus} H1002 V{sy + 20}", label, color, t0, t0 + 1.0)
        packet(f"M877,{sy + 166} V{chan} H200 V{by + 10}", label, color, t0 + 1.0, t0 + 2.0)
    css = font_css("".join(text_all) + "ARCHITECTURE")
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" '
            f'aria-label="Architecture: requests are scheduled, drafted, verified and committed by the engine over a paged KV cache; '
            f'every state change becomes an event sent over a WebSocket or to a trace file; in the browser a player, timeline, reducer and panels rebuild it.">'
            f"<style>{css}</style><defs>{DEFS_COMMON}</defs>{''.join(body)}</svg>\n")


def main() -> None:
    events = [json.loads(line) for line in TRACE.open()]
    rp = Replay(events)
    OUT.mkdir(exist_ok=True)
    for name, svg in (("hero.svg", hero(rp)), ("architecture.svg", arch())):
        (OUT / name).write_text(svg)
        print(f"wrote assets/{name}  {len(svg) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
