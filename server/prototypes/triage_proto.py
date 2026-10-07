"""Prototype: sentence-importance triage ranking via local Ollama (plan §10.2).

Runs the rubric prompt over defaultTranscript.json twice (forward + reversed
presentation order) and prints the ranked list + a position-bias check.
"""
import json
import time

import httpx

OLLAMA_URL = "http://127.0.0.1:11434"
MODEL = "qwen2.5:7b-instruct"

PROMPT_HEADER = """You are triaging a police-interview transcript for a reviewer with limited time.
The numbered transcript below may contain speech-recognition errors.
For EVERY line, rate how badly the investigation or a court could be misled if
THAT line were transcribed incorrectly (1-5).

The WITNESS's statements carry the evidence. OFFICER lines are questions or
procedure: score them 1, except an officer line that itself asserts a case fact
which the witness then confirms may score up to 3.

For WITNESS lines:
5 = a factual claim central to the case: what happened, who or what was seen,
    weapon mentions, times, places, quantities, identifications,
    admissions/denials, explicit confirmations or corrections of the record;
3 = supporting or contextual detail;
1 = greetings, fillers, pure procedure.
Use the full range; only a handful of lines should score 5.
Output strict JSON only: {"segments":[{"id":<n>,"score":<1-5>,"reason":"<=8 words>"}]}
covering every id exactly once.
TRANSCRIPT:
"""

# Speaker roles for the demo transcript (hand-labelled; REAL study materials
# carry Officer/Witness roles in the script, so this is data we will have).
OFFICER_IDS = {0, 1, 2, 4, 7, 9, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 29, 31}


def load_segments():
    t = json.load(open("src/data/defaultTranscript.json"))
    segs = []
    for s in t["segments"]:
        model = next(iter(s["words"]))
        text = " ".join(w["text"] for w in s["words"][model]).strip()
        segs.append({"id": s["id"], "speaker": s.get("speaker", "?"), "text": text})
    return segs


def numbered(segs):
    return "\n".join(
        f"[{s['id']}] {'OFFICER' if s['id'] in OFFICER_IDS else 'WITNESS'}: {s['text']}"
        for s in segs
    )


def call_ollama(prompt):
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
    content = r.json().get("message", {}).get("content", "")
    return content, time.time() - t0


def parse_scores(content, valid_ids):
    try:
        data = json.loads(content)
    except Exception:
        s, e = content.index("{"), content.rindex("}")
        data = json.loads(content[s : e + 1])
    out = {}
    for item in data.get("segments", []):
        sid = item.get("id")
        if isinstance(sid, str) and sid.lstrip("-").isdigit():
            sid = int(sid)
        if sid in valid_ids and sid not in out:
            try:
                score = max(1, min(5, int(item.get("score", 2))))
            except Exception:
                score = 2
            out[sid] = {"score": score, "reason": str(item.get("reason", ""))[:60]}
    return out


def main():
    segs = load_segments()
    valid_ids = {s["id"] for s in segs}
    by_id = {s["id"]: s for s in segs}

    print(f"== {len(segs)} segments, model {MODEL} ==\n")

    runs = {}
    for label, ordered in [("forward", segs), ("reversed", list(reversed(segs)))]:
        content, dt = call_ollama(PROMPT_HEADER + numbered(ordered))
        scores = parse_scores(content, valid_ids)
        missing = sorted(valid_ids - set(scores))
        runs[label] = scores
        print(f"-- {label}: {dt:.1f}s, scored {len(scores)}/{len(segs)}"
              + (f", MISSING ids {missing}" if missing else ""))

    fwd = runs["forward"]

    print("\n== RANKED (mean of forward+reversed) ==")
    rev_scores = runs["reversed"]
    avg = {
        sid: (fwd[sid]["score"] + rev_scores.get(sid, fwd[sid])["score"]) / 2
        for sid in fwd
    }
    ranked = sorted(avg.items(), key=lambda kv: (-kv[1], kv[0]))
    for sid, score in ranked:
        s = by_id[sid]
        role = "OFF" if sid in OFFICER_IDS else "WIT"
        text = s["text"][:74] + ("…" if len(s["text"]) > 74 else "")
        print(f"  {score:>3.1f} (f{fwd[sid]['score']}/r{rev_scores.get(sid, {}).get('score', '-')}) | [{sid:>2}] {role} | {text}")
        print(f"        ↳ {fwd[sid]['reason']}")

    # Position-bias check: forward vs reversed
    rev = runs["reversed"]
    common = sorted(set(fwd) & set(rev))
    diffs = [(sid, fwd[sid]["score"], rev[sid]["score"]) for sid in common
             if fwd[sid]["score"] != rev[sid]["score"]]
    top10_f = {sid for sid, _ in sorted(fwd.items(), key=lambda kv: (-kv[1]["score"], kv[0]))[:10]}
    top10_r = {sid for sid, _ in sorted(rev.items(), key=lambda kv: (-kv[1]["score"], kv[0]))[:10]}
    exact = len(common) - len(diffs)
    print(f"\n== POSITION-BIAS CHECK (forward vs reversed) ==")
    print(f"  exact score agreement: {exact}/{len(common)}"
          f"  |  top-10 overlap: {len(top10_f & top10_r)}/10")
    if diffs:
        print("  disagreements (id: fwd→rev):")
        for sid, a, b in diffs:
            print(f"    [{sid:>2}] {a}→{b} | {by_id[sid]['text'][:60]}")


if __name__ == "__main__":
    main()
