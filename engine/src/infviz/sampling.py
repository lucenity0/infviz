"""Temperature sampling and the speculative accept/resample rule (Leviathan et al. 2023;
Chen et al. 2023).

With draft distribution q and target distribution p at the same position, a drafted token
x (sampled from q) is accepted with probability min(1, p(x) / q(x)). At the first
rejection the target samples a replacement from the residual norm(max(0, p - q)); if
every draft is accepted it samples one bonus token from p at the next position. Every
token emitted this way is distributed exactly as if sampled from p alone, which is what
`tests/test_sampling.py` checks on small synthetic distributions.

Greedy decoding (temperature 0) does not come through here: the engine keeps its exact
argmax path for it, so the lossless tests are untouched.
"""
from __future__ import annotations

import torch


def probs(logits: torch.Tensor, temperature: float) -> torch.Tensor:
    """Softmax of logits / temperature in float32 (rows: positions)."""
    return torch.softmax(logits.float() / temperature, dim=-1)


def sample(p: torch.Tensor, gen: torch.Generator) -> int:
    """One token from a probability vector (CPU tensor), with a per-request generator."""
    return int(torch.multinomial(p, 1, generator=gen).item())


def accept_or_resample(p: torch.Tensor, q: torch.Tensor, draft: list[int],
                       gen: torch.Generator) -> tuple[int, int]:
    """One speculative round.

    p: [len(draft) + 1, V] target probabilities at each draft position and one past it.
    q: [len(draft), V] draft probabilities the drafted tokens were sampled from.
    Returns (n_accepted, next_token): the first n_accepted drafts are kept, then next_token
    (a resample from the residual after a rejection, or a bonus sample from p).
    """
    for i, x in enumerate(draft):
        px, qx = float(p[i, x]), float(q[i, x])
        u = float(torch.rand((), generator=gen))
        if qx > 0 and u * qx <= px:  # accept with probability min(1, px / qx)
            continue
        residual = (p[i] - q[i]).clamp_min(0)
        total = float(residual.sum())
        return i, sample(residual / total if total > 0 else p[i], gen)
    return len(draft), sample(p[len(draft)], gen)
