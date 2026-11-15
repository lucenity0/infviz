"""Minimal Llama/Qwen2 forward pass over a *paged* KV cache.

Weights are loaded straight from safetensors. The KV cache is a pool of fixed-size
blocks per layer; each sequence addresses it through a block table, so blocks can be
shared (prefix caching), freed, evicted and rolled back independently. The bookkeeping
lives in ``kv.py``; this module only does math on slot indices it is handed.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import torch
import torch.nn.functional as F
from safetensors import safe_open


@dataclass
class ModelConfig:
    hidden_size: int
    intermediate_size: int
    num_layers: int
    num_heads: int
    num_kv_heads: int
    head_dim: int
    rms_eps: float
    rope_theta: float
    vocab_size: int
    tie_embeddings: bool
    qkv_bias: bool

    @classmethod
    def from_dir(cls, path: Path) -> "ModelConfig":
        c = json.loads((path / "config.json").read_text())
        arch = c["architectures"][0]
        if c.get("rope_scaling"):
            raise NotImplementedError(f"rope_scaling not supported: {c['rope_scaling']}")
        return cls(
            hidden_size=c["hidden_size"],
            intermediate_size=c["intermediate_size"],
            num_layers=c["num_hidden_layers"],
            num_heads=c["num_attention_heads"],
            num_kv_heads=c["num_key_value_heads"],
            head_dim=c.get("head_dim") or c["hidden_size"] // c["num_attention_heads"],
            rms_eps=c["rms_norm_eps"],
            rope_theta=c.get("rope_theta", 10000.0),
            vocab_size=c["vocab_size"],
            tie_embeddings=c.get("tie_word_embeddings", False),
            qkv_bias=arch.startswith("Qwen2") or c.get("attention_bias", False),
        )


@dataclass
class SeqInput:
    """One sequence's slice of a ragged batch."""

    tokens: list[int]          # new tokens to run this forward
    start_pos: int             # absolute position of tokens[0] (= kv tokens already cached)
    slots: list[int]           # flat cache slot for each position 0..start_pos+len(tokens)-1
    all_logits: bool = False   # True: logits for every new token; False: last only


class PagedKVCache:
    """Per-layer K/V tensors shaped [n_blocks * block_size, n_kv, head_dim]."""

    def __init__(self, cfg: ModelConfig, n_blocks: int, block_size: int, device, dtype):
        self.n_blocks, self.block_size = n_blocks, block_size
        shape = (n_blocks * block_size, cfg.num_kv_heads, cfg.head_dim)
        self.k = [torch.zeros(shape, device=device, dtype=dtype) for _ in range(cfg.num_layers)]
        self.v = [torch.zeros(shape, device=device, dtype=dtype) for _ in range(cfg.num_layers)]


class Model:
    def __init__(self, path: str | Path, device: str = "mps", dtype: torch.dtype = torch.bfloat16):
        self.path = Path(path)
        self.cfg = ModelConfig.from_dir(self.path)
        self.device, self.dtype = torch.device(device), dtype
        self.w = self._load()
        hd = self.cfg.head_dim
        self.inv_freq = 1.0 / (
            self.cfg.rope_theta ** (torch.arange(0, hd, 2, dtype=torch.float32, device=self.device) / hd)
        )

    # ------------------------------------------------------------------ weights
    def _load(self) -> dict[str, torch.Tensor]:
        w: dict[str, torch.Tensor] = {}
        for f in sorted(self.path.glob("*.safetensors")):
            with safe_open(str(f), framework="pt") as sf:
                for name in sf.keys():
                    w[name] = sf.get_tensor(name).to(device=self.device, dtype=self.dtype)
        if "lm_head.weight" not in w or self.cfg.tie_embeddings:
            w["lm_head.weight"] = w["model.embed_tokens.weight"]
        return w

    def new_cache(self, n_blocks: int, block_size: int) -> PagedKVCache:
        return PagedKVCache(self.cfg, n_blocks, block_size, self.device, self.dtype)

    # ------------------------------------------------------------------ helpers
    def _rms(self, x: torch.Tensor, weight: torch.Tensor) -> torch.Tensor:
        xf = x.float()
        xf = xf * torch.rsqrt(xf.pow(2).mean(-1, keepdim=True) + self.cfg.rms_eps)
        return weight * xf.to(x.dtype)

    def _rope(self, positions: torch.Tensor):
        freqs = positions.float()[:, None] * self.inv_freq[None, :]
        emb = torch.cat([freqs, freqs], dim=-1)
        return emb.cos().to(self.dtype), emb.sin().to(self.dtype)

    @staticmethod
    def _apply_rope(x, cos, sin):  # x: [T, H, D]; cos/sin: [T, D]
        half = x.shape[-1] // 2
        rot = torch.cat([-x[..., half:], x[..., :half]], dim=-1)
        return x * cos[:, None, :] + rot * sin[:, None, :]

    # ------------------------------------------------------------------ forward
    @torch.inference_mode()
    def forward(self, seqs: list[SeqInput], cache: PagedKVCache) -> list[torch.Tensor]:
        """Run a ragged batch. Writes new K/V into ``cache`` and returns, per sequence,
        float32 logits of shape [n, vocab] (n = len(tokens) if all_logits else 1)."""
        cfg, dev = self.cfg, self.device
        B = len(seqs)
        q_lens = [len(s.tokens) for s in seqs]
        kv_lens = [s.start_pos + len(s.tokens) for s in seqs]
        Q, K = max(q_lens), max(kv_lens)

        tokens = torch.tensor([t for s in seqs for t in s.tokens], device=dev)
        positions = torch.tensor(
            [s.start_pos + i for s in seqs for i in range(len(s.tokens))], device=dev
        )
        write_slots = torch.tensor(
            [s.slots[s.start_pos + i] for s in seqs for i in range(len(s.tokens))], device=dev
        )
        # gather index for keys [B, K] and query scatter (b, q) for each packed token
        gather = torch.zeros(B, K, dtype=torch.long)
        mask = torch.zeros(B, Q, K, dtype=torch.bool)
        qb, qi = [], []
        for b, s in enumerate(seqs):
            kl = kv_lens[b]
            gather[b, :kl] = torch.tensor(s.slots[:kl])
            for i in range(len(s.tokens)):
                p = s.start_pos + i
                mask[b, i, : p + 1] = True
                qb.append(b)
                qi.append(i)
            mask[b, len(s.tokens):, 0] = True  # padded query rows: avoid all-masked NaNs
        gather, mask = gather.to(dev), mask.to(dev)[:, None]
        qb_t, qi_t = torch.tensor(qb, device=dev), torch.tensor(qi, device=dev)

        cos, sin = self._rope(positions)
        h = F.embedding(tokens, self.w["model.embed_tokens.weight"])
        H, KVH, D = cfg.num_heads, cfg.num_kv_heads, cfg.head_dim
        rep = H // KVH
        for L in range(cfg.num_layers):
            p = f"model.layers.{L}."
            x = self._rms(h, self.w[p + "input_layernorm.weight"])
            a = p + "self_attn."
            q = F.linear(x, self.w[a + "q_proj.weight"], self.w.get(a + "q_proj.bias"))
            k = F.linear(x, self.w[a + "k_proj.weight"], self.w.get(a + "k_proj.bias"))
            v = F.linear(x, self.w[a + "v_proj.weight"], self.w.get(a + "v_proj.bias"))
            q = self._apply_rope(q.view(-1, H, D), cos, sin)
            k = self._apply_rope(k.view(-1, KVH, D), cos, sin)
            v = v.view(-1, KVH, D)
            cache.k[L][write_slots] = k
            cache.v[L][write_slots] = v

            kg = cache.k[L][gather]  # [B, K, KVH, D]
            vg = cache.v[L][gather]
            qp = torch.zeros(B, Q, H, D, device=dev, dtype=self.dtype)
            qp[qb_t, qi_t] = q
            kg = kg.repeat_interleave(rep, dim=2).transpose(1, 2)  # [B, H, K, D]
            vg = vg.repeat_interleave(rep, dim=2).transpose(1, 2)
            o = F.scaled_dot_product_attention(qp.transpose(1, 2), kg, vg, attn_mask=mask)
            o = o.transpose(1, 2)[qb_t, qi_t].reshape(-1, H * D)  # back to packed [T, H*D]
            h = h + F.linear(o, self.w[a + "o_proj.weight"])

            x = self._rms(h, self.w[p + "post_attention_layernorm.weight"])
            m = p + "mlp."
            g = F.linear(x, self.w[m + "gate_proj.weight"])
            u = F.linear(x, self.w[m + "up_proj.weight"])
            h = h + F.linear(F.silu(g) * u, self.w[m + "down_proj.weight"])

        h = self._rms(h, self.w["model.norm.weight"])
        out, off = [], 0
        idx = []
        spans = []
        for s, n in zip(seqs, q_lens):
            sel = list(range(off, off + n)) if s.all_logits else [off + n - 1]
            spans.append((len(idx), len(sel)))
            idx.extend(sel)
            off += n
        logits = F.linear(h[torch.tensor(idx, device=dev)], self.w["lm_head.weight"]).float()
        for a0, n in spans:
            out.append(logits[a0 : a0 + n])
        return out
