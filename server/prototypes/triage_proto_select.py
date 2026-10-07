"""Prototype variant: top-K SELECTION instead of per-line absolute scores."""
import json
import time

import httpx

OLLAMA_URL = "http://127.0.0.1:11434"
import os
MODEL = os.environ.get("TRIAGE_MODEL", "qwen2.5:7b-instruct")
K = 8

OFFICER_IDS = {0, 1, 2, 4, 7, 9, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 29, 31}

PROMPT = f"""You are triaging a police-interview transcript for a reviewer who only has
time to re-listen to {K} lines against the audio. The transcript below may
contain speech-recognition errors.

Pick the {K} lines where a transcription error would most badly mislead the
investigation or a court — the WITNESS's factual claims: what happened, who or
what was seen, weapon mentions, times, places, quantities, identifications,
denials, and explicit confirmations or corrections of the record. OFFICER lines
are questions/procedure and are almost never worth a slot.

Order them most-critical first.
Output strict JSON only: {{"top":[{{"id":<n>,"reason":"<=8 words>"}}]}} with exactly {K} items.
TRANSCRIPT:
"""


def load_segments():
    t = json.load(open("src/data/defaultTranscript.json"))
    segs = []
    for s in t["segments"]:
        model = next(iter(s["words"]))
        text = " ".join(w["text"] for w in s["words"][model]).strip()
        segs.append({"id": s["id"], "text": text})
    return segs


def numbered(segs):
    return "\n".join(
        f"[{s['id']}] {'OFFICER' if s['id'] in OFFICER_IDS else 'WITNESS'}: {s['text']}"
        for s in segs
    )


def call(prompt):
    body = {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "format": "json",
        "options": {"temperature": 0, "seed": 0, "num_ctx": 4096},
    }
    t0 = time.time()
    r = httpx.post(f"{OLLAMA_URL}/api/chat", json=body, timeout=300.0)
    r.raise_for_status()
    return r.json()["message"]["content"], time.time() - t0


def parse_top(content, valid_ids):
    try:
        data = json.loads(content)
    except Exception:
        s, e = content.index("{"), content.rindex("}")
        data = json.loads(content[s : e + 1])
    out = []
    for item in data.get("top", []):
        sid = item.get("id")
        if isinstance(sid, str) and sid.lstrip("-").isdigit():
            sid = int(sid)
        if sid in valid_ids and sid not in [x[0] for x in out]:
            out.append((sid, str(item.get("reason", ""))[:60]))
    return out


K_ASK = 12  # over-ask so officer remapping + fusion still fill K slots


def remap_officer(picks, all_ids):
    """An officer pick is usually a proxy for the answer it frames (the model's
    own reasons cite the answer's content) — remap it to the next WITNESS line."""
    out = []
    for sid, reason in picks:
        if sid in OFFICER_IDS:
            nxt = next((i for i in sorted(all_ids) if i > sid and i not in OFFICER_IDS), None)
            if nxt is None:
                continue
            sid, reason = nxt, reason + " (remapped from question)"
        if sid not in [x[0] for x in out]:
            out.append((sid, reason))
    return out


def main():
    segs = load_segments()
    valid_ids = {s["id"] for s in segs}
    by_id = {s["id"]: s for s in segs}

    results = {}
    for label, ordered in [("forward", segs), ("reversed", list(reversed(segs)))]:
        content, dt = call(PROMPT.replace(str(K), str(K_ASK)) + numbered(ordered))
        raw = parse_top(content, valid_ids)
        picks = remap_officer(raw, valid_ids)
        results[label] = picks
        n_off = sum(1 for sid, _ in raw if sid in OFFICER_IDS)
        print(f"-- {label}: {dt:.1f}s, {len(raw)} picks ({n_off} officer → remapped)")

    # Borda fusion of the two passes: earlier rank = more points.
    borda = {}
    for picks in results.values():
        for rank, (sid, _) in enumerate(picks):
            borda[sid] = borda.get(sid, 0) + (K_ASK - rank)
    reasons = {sid: r for picks in results.values() for sid, r in picks}
    fused = sorted(borda.items(), key=lambda kv: (-kv[1], kv[0]))[:K]

    print(f"\n== FUSED TOP-{K} (Borda over forward+reversed, officer-remapped) ==")
    for rank, (sid, pts) in enumerate(fused, 1):
        text = by_id[sid]["text"][:70] + ("…" if len(by_id[sid]["text"]) > 70 else "")
        print(f"  {rank}. [{sid:>2}] ({pts:>2}pt) {text}")
        print(f"       ↳ {reasons[sid]}")

    # Informal gold (my judgment; REAL gold = V2 dual annotation)
    gold = {5, 25, 30, 17, 6, 8, 11, 21}
    fused_set = {sid for sid, _ in fused}
    print(f"\n== vs informal gold {sorted(gold)} ==")
    print(f"  recall@{K}: {len(fused_set & gold)}/{len(gold)}"
          f"  |  missed: {sorted(gold - fused_set)}  |  extra: {sorted(fused_set - gold)}")


if __name__ == "__main__":
    main()
