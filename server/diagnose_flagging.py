"""
diagnose_flagging.py
Quantify the combined_risk "over-flagging" (everything-is-red) symptom and what
the L1-gated cascade would change — BEFORE touching the live endpoint.

Runs the SAME featurization as serve_model (MiniLM context + target embeddings,
mean-pooled and NOT normalised — matching SentenceTransformer.encode defaults)
-> the trained L2 logistic regression, then reports per transcript:
  * P(HIGH) distribution + uncertainty distribution;
  * CURRENT red% — combined_risk == 'high' under the live P(HIGH) >= 0.75 / 0.55
    gates;
  * CASCADE red% — C2_gate (HIGH iff L1 fires) + a real 2x2 combine, with a
    breakdown of WHERE the red comes from (lexicon / number / money / proper-noun);
  * example tokens, so we can eyeball it.

Self-contained: embeds via `transformers` (no sentence_transformers needed) so it
runs on the user-site /usr/bin/python3. The MiniLM weights are read from the
local HF cache.

Usage (from server/):  python3 diagnose_flagging.py [<transcript.json> ...]
Defaults to bundled case447 + the sland test clip.
"""

from __future__ import annotations

import json
import sys
import warnings
from pathlib import Path
from collections import Counter, OrderedDict

import numpy as np
import joblib

warnings.filterwarnings("ignore")

from l1_rules import l1_label_explained  # noqa: E402

RANK = {"low": 0, "med": 1, "high": 2}
HERE = Path(__file__).resolve().parent
MODEL_PATH = HERE / "models" / "l2_clean.joblib"
ENCODER_NAME = "sentence-transformers/all-MiniLM-L6-v2"

# Live combine() gates (serve_model.py) — kept here to compute the CURRENT red%.
HIGH_THRESHOLD = 0.75
MID_THRESHOLD = 0.55

_PUNCT_STRIP = '.,!?;:"\'()[]'

DEFAULT_INPUTS = [
    HERE.parent / "src" / "data" / "defaultTranscript.json",
    Path.home() / "Desktop" / "devoid测试结果"
    / "transcript-sland_s1_055-058_merged-2026-06-10T23-10-45-736Z.json",
]


# ---- featurization (mirror serve_model) -----------------------------------

def clean_for_model(text: str) -> str:
    return text.strip().strip(_PUNCT_STRIP).strip()


def build_context(words, i: int) -> str:
    cleaned = [clean_for_model(w["text"]) for w in words]
    before = " ".join(cleaned[:i])
    target = cleaned[i]
    after = " ".join(cleaned[i + 1:])
    return f"{before} [TARGET] {target} [/TARGET] {after}".strip()


_tok = _mdl = None


def _encoder():
    global _tok, _mdl
    if _mdl is None:
        import torch  # noqa
        from transformers import AutoTokenizer, AutoModel
        _tok = AutoTokenizer.from_pretrained(ENCODER_NAME)
        _mdl = AutoModel.from_pretrained(ENCODER_NAME)
        _mdl.eval()
    return _tok, _mdl


def encode(texts, batch_size=64):
    """Reproduce SentenceTransformer('all-MiniLM-L6-v2').encode(): mean pooling
    over tokens THEN L2-normalise (the model ships a Normalize module, so encode
    always normalises — and training featurised the same way)."""
    import torch
    tok, mdl = _encoder()
    out = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        enc = tok(batch, padding=True, truncation=True, max_length=256, return_tensors="pt")
        with torch.no_grad():
            o = mdl(**enc)
        mask = enc["attention_mask"].unsqueeze(-1).float()
        summed = (o.last_hidden_state * mask).sum(1)
        cnt = mask.sum(1).clamp(min=1e-9)
        mean = summed / cnt
        mean = torch.nn.functional.normalize(mean, p=2, dim=1)  # Normalize module
        out.append(mean.cpu().numpy())
    return np.concatenate(out, 0)


# ---- combine policies ------------------------------------------------------

def combine_current(uncertainty, proba):
    u = RANK[uncertainty]
    p_high, p_med = proba["high"], proba["med"]
    if p_high >= HIGH_THRESHOLD:
        return "high"
    if p_high >= MID_THRESHOLD:
        return "high" if u >= 1 else "med"
    if p_med >= 0.5 or u == 2:
        return "med"
    if u == 1:
        return "med"
    return "low"


def combine_cascade(uncertainty, importance):
    u = RANK[uncertainty]
    if importance == "HIGH":
        return "high"
    if importance == "MEDIUM":
        return "high" if u == 2 else "med"
    return "med" if u >= 1 else "low"


# ---- analysis --------------------------------------------------------------

def collect(path: Path):
    data = json.loads(path.read_text(encoding="utf-8"))
    contexts, rows = [], []
    for seg in data["segments"]:
        mname = next(iter(seg["words"]))
        words = seg["words"][mname]
        for i, w in enumerate(words):
            cleaned = clean_for_model(w.get("text", ""))
            if cleaned == "":
                continue
            contexts.append(build_context(words, i))
            rows.append({
                "tgt": cleaned,
                "raw": w.get("text", ""),
                "prev": words[i - 1].get("text", "") if i > 0 else None,
                "is_first": i == 0,
                "unc": w.get("risk", "low"),
            })
    return rows, contexts


def proba_for(rows, contexts):
    clf = joblib.load(MODEL_PATH)
    ctx = encode(contexts)
    tgt = encode([r["tgt"] for r in rows])
    X = np.concatenate([ctx, tgt], axis=1)
    # The classifier was pickled under an older sklearn (no `multi_class` attr),
    # so call predict_proba's math directly: this is a multinomial LR (lbfgs,
    # 3 classes) -> predict_proba == softmax(decision_function). Version-proof.
    d = clf.decision_function(X)
    d = d - d.max(axis=1, keepdims=True)
    e = np.exp(d)
    P = e / e.sum(axis=1, keepdims=True)
    idx = {c: i for i, c in enumerate(clf.classes_)}
    return P[:, idx["HIGH"]], P[:, idx["MEDIUM"]], P[:, idx["LOW"]]


def pct(x):
    return f"{x * 100:.1f}%"


def analyze(path: Path):
    rows, contexts = collect(path)
    n = len(rows)
    print("=" * 78)
    print(f"FILE: {path.name}   content tokens: {n}")
    if n == 0:
        return
    p_high, p_med, p_low = proba_for(rows, contexts)

    unc = Counter(r["unc"] for r in rows)
    print("uncertainty: " + "  ".join(f"{k}={unc.get(k,0)}" for k in ("low", "med", "high")))
    qs = [50, 75, 90, 95, 99, 100]
    print("P(HIGH) quantiles: " + "  ".join(f"p{q}={v:.2f}" for q, v in zip(qs, np.percentile(p_high, qs))))

    cur, casc, reasons = [], [], []
    for k in range(n):
        proba = {"high": float(p_high[k]), "med": float(p_med[k]), "low": float(p_low[k])}
        cur.append(combine_current(rows[k]["unc"], proba))
        lab, reason = l1_label_explained(rows[k]["raw"], rows[k]["prev"], rows[k]["is_first"])
        imp = "HIGH" if lab == "HIGH" else ("MEDIUM" if p_med[k] >= p_low[k] else "LOW")
        casc.append(combine_cascade(rows[k]["unc"], imp))
        reasons.append(reason if imp == "HIGH" else None)

    cur_high = sum(c == "high" for c in cur)
    casc_high = sum(c == "high" for c in casc)
    strong = int((p_high >= HIGH_THRESHOLD).sum())
    print("-" * 78)
    print(f"CURRENT red (P(HIGH) gates): {cur_high}/{n} = {pct(cur_high/n)}   "
          f"(of which P(HIGH)>=0.75: {strong})")
    print(f"CASCADE red (L1 gate + 2x2): {casc_high}/{n} = {pct(casc_high/n)}")
    src = Counter(r for r in reasons if r)
    print("   cascade red source: " + ("  ".join(f"{k}={v}" for k, v in src.most_common()) or "(none)"))

    cur_set = {rows[k]["tgt"] for k in range(n) if cur[k] == "high"}
    casc_set = {rows[k]["tgt"] for k in range(n) if casc[k] == "high"}
    dropped = list(OrderedDict.fromkeys(rows[k]["tgt"] for k in range(n)
                                        if cur[k] == "high" and casc[k] != "high"))
    print("-" * 78)
    print(f"now-red, cascade-NOT ({len(cur_set - casc_set)} distinct): {', '.join(dropped[:45])}")
    print(f"cascade keeps red ({len(casc_set)} distinct): {', '.join(sorted(casc_set)[:45])}")


def main():
    args = [Path(a) for a in sys.argv[1:]] or DEFAULT_INPUTS
    for p in args:
        if not p.exists():
            print(f"!! missing: {p}")
            continue
        analyze(p)
    print("=" * 78)


if __name__ == "__main__":
    main()
