// Plain-language narration of one engine step, written from that step's events.
// Pure: (events in the step, up to the cursor) -> sentences. No engine or reducer state.
import type { InfvizEvent } from "./events";

export type LineKind =
  | "preempt"
  | "evict"
  | "arrive"
  | "admit"
  | "prefill"
  | "spec"
  | "decode"
  | "finish";

export interface Line {
  kind: LineKind;
  text: string;
}

export interface Story {
  step: number;
  ms: number | null;
  lines: Line[];
}

const r = (rid: number) => `r${rid}`;

/** "r1", "r1 and r2", "r1, r2 and r3" */
export function list(ids: number[]): string {
  const s = ids.map(r);
  return s.length <= 1
    ? (s[0] ?? "")
    : `${s.slice(0, -1).join(", ")} and ${s[s.length - 1]}`;
}
const plural = (n: number, one: string, many = one + "s") =>
  `${n} ${n === 1 ? one : many}`;

/** narrate events [a, end) that belong to one step; `bs` = KV block size, `k` = draft length */
export function narrateStep(
  events: InfvizEvent[],
  a: number,
  end: number,
  bs: number,
  k: number,
): Story {
  const step = events[a]?.step ?? 0;
  let ms: number | null = null;
  const arrived: { rid: number; len: number }[] = [];
  const admitted: number[] = [];
  const hits = new Map<number, number>();
  const prefill = new Map<number, number>();
  const decodes: number[] = [];
  const verifies: { rid: number; n: number }[] = [];
  const preempted: number[] = [];
  const finished: { rid: number; reason: string; len: number }[] = [];
  let evicted = 0;

  for (let i = a; i < end; i++) {
    const e = events[i];
    switch (e.type) {
      case "req_arrive":
        arrived.push({ rid: e.rid, len: e.prompt_len });
        break;
      case "req_admit":
        admitted.push(e.rid);
        break;
      case "block_hit":
        if (e.pool === "target") hits.set(e.rid, (hits.get(e.rid) ?? 0) + 1);
        break;
      case "step_begin":
        for (const b of e.batch) {
          if (b.phase === "prefill") prefill.set(b.rid, b.n_tokens);
          else decodes.push(b.rid);
        }
        break;
      case "verify":
        verifies.push({ rid: e.rid, n: e.n_accepted });
        break;
      case "block_evict":
        if (e.pool === "target") evicted++;
        break;
      case "req_preempt":
        preempted.push(e.rid);
        break;
      case "req_finish":
        finished.push({ rid: e.rid, reason: e.reason, len: e.output_len });
        break;
      case "step_end":
        ms = e.ms;
        break;
    }
  }

  const lines: Line[] = [];
  for (const rid of preempted)
    lines.push({
      kind: "preempt",
      text: `${r(rid)} was preempted: the KV pool ran out of free blocks, so its cache was released and it went back to the queue, to be recomputed later.`,
    });
  if (evicted)
    lines.push({
      kind: "evict",
      text: `The pool needed room, so ${plural(evicted, "cached block")} kept from finished requests ${evicted === 1 ? "was" : "were"} evicted, least recently used first.`,
    });
  if (arrived.length)
    lines.push({
      kind: "arrive",
      text:
        arrived.length === 1
          ? `${r(arrived[0].rid)} arrived with a ${arrived[0].len}-token prompt and joined the queue.`
          : `${list(arrived.map((x) => x.rid))} arrived and joined the queue.`,
    });
  for (const rid of admitted) {
    const h = hits.get(rid) ?? 0;
    const p = prefill.get(rid);
    let t = `${r(rid)} joined the running batch`;
    if (h)
      t += `, reused ${h * bs} prompt tokens already in the cache (${plural(h, "block")})`;
    if (p !== undefined)
      t += ` and prefilled ${h ? "the other " : ""}${p} ${h ? "" : "prompt "}tokens in one pass`;
    lines.push({ kind: "admit", text: t + "." });
    prefill.delete(rid);
  }
  for (const [rid, n] of prefill)
    lines.push({
      kind: "prefill",
      text: `${r(rid)} prefilled ${n} tokens, recomputing what preemption threw away.`,
    });
  if (verifies.length && k > 0) {
    const acc = verifies.reduce((s, v) => s + v.n, 0);
    const all = verifies.filter((v) => v.n === k).map((v) => v.rid);
    const none = verifies.filter((v) => v.n === 0).map((v) => v.rid);
    let t =
      verifies.length === 1
        ? `The draft model guessed ${k} tokens for ${r(verifies[0].rid)}; one target pass checked them and kept ${acc}, plus one token of its own.`
        : `The draft model guessed ${k} tokens for each of ${verifies.length} running requests; one target pass checked all ${verifies.length * k} and kept ${acc}, plus one token of its own per request.`;
    if (verifies.length === 1) {
      lines.push({ kind: "spec", text: t });
    } else {
      if (all.length) t += ` ${list(all)} kept every guess.`;
      if (none.length) t += ` ${list(none)} lost all ${k}.`;
      lines.push({ kind: "spec", text: t });
    }
  } else if (decodes.length && k === 0) {
    lines.push({
      kind: "decode",
      text: `${plural(decodes.length, "running request")} each decoded one token.`,
    });
  }
  for (const f of finished)
    lines.push({
      kind: "finish",
      text: `${r(f.rid)} finished after ${f.len} tokens (${f.reason === "eos" ? "end of text" : "length cap"}); its blocks stay cached for reuse until evicted.`,
    });
  return { step, ms, lines };
}
