"""The speculative accept/resample rule preserves the target distribution.

With context-free p and q (the same at every position), plain sampling from p emits
i.i.d. tokens from p. Speculative rounds must emit tokens with exactly that distribution,
whatever q is. Checked by simulation on small vocabularies; no model weights needed.
"""
from __future__ import annotations

import pytest
import torch

from infviz.sampling import accept_or_resample, sample

N_TOKENS = 60_000


def emitted_histogram(p: torch.Tensor, q: torch.Tensor, k: int, seed: int = 0) -> torch.Tensor:
    gen = torch.Generator().manual_seed(seed)
    P = p.expand(k + 1, -1)
    Q = q.expand(k, -1)
    counts = torch.zeros(p.numel())
    n = 0
    while n < N_TOKENS:
        draft = [sample(q, gen) for _ in range(k)]
        a, nxt = accept_or_resample(P, Q, draft, gen)
        for t in draft[:a] + [nxt]:
            counts[t] += 1
            n += 1
    return counts / counts.sum()


CASES = {
    "q equals p": (torch.tensor([0.5, 0.2, 0.2, 0.1]), torch.tensor([0.5, 0.2, 0.2, 0.1])),
    "q differs": (torch.tensor([0.6, 0.1, 0.2, 0.1]), torch.tensor([0.1, 0.5, 0.1, 0.3])),
    "disjoint supports": (torch.tensor([0.7, 0.3, 0.0, 0.0]), torch.tensor([0.0, 0.0, 0.4, 0.6])),
    "q is 0 where p is not": (torch.tensor([0.25, 0.25, 0.25, 0.25]), torch.tensor([0.5, 0.5, 0.0, 0.0])),
    "peaked draft": (torch.tensor([0.3, 0.3, 0.2, 0.1, 0.1]), torch.tensor([0.96, 0.01, 0.01, 0.01, 0.01])),
}


@pytest.mark.parametrize("name", list(CASES))
@pytest.mark.parametrize("k", [1, 4])
def test_emitted_tokens_follow_the_target_distribution(name, k):
    p, q = CASES[name]
    got = emitted_histogram(p, q, k)
    # sampling error is about sqrt(p(1-p)/N) <= 0.002 here; allow a wide margin
    assert torch.allclose(got, p, atol=0.012), f"{name}, k={k}: emitted {got.tolist()} vs p {p.tolist()}"


def test_identical_distributions_accept_every_draft():
    p = torch.tensor([0.5, 0.3, 0.2])
    gen = torch.Generator().manual_seed(1)
    for _ in range(200):
        draft = [sample(p, gen) for _ in range(4)]
        a, _ = accept_or_resample(p.expand(5, -1), p.expand(4, -1), draft, gen)
        assert a == 4


def test_disjoint_supports_reject_the_first_draft_always():
    p, q = torch.tensor([1.0, 0.0]), torch.tensor([0.0, 1.0])
    gen = torch.Generator().manual_seed(2)
    for _ in range(200):
        a, nxt = accept_or_resample(p.expand(3, -1), q.expand(2, -1), [1, 1], gen)
        assert (a, nxt) == (0, 0)
