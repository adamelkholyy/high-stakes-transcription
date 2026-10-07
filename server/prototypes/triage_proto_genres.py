"""Generalization probe: v5 triage algorithm on non-interview genres.

Four fictional scenarios (ethics-whitelist themes) stress the assumptions the
police-interview prototype baked in:
  A  911 call        — asymmetric roles, but the facilitator (dispatcher)
                       sometimes CARRIES content (address read-back)
  B  monologue       — one speaker, no dialogue structure at all
  C  multi-party     — 4 speakers, contradicting accounts
  D  casual chat     — mostly small talk, few buried critical lines

v6 prompt = v5 generalized: no hardcoded OFFICER/WITNESS; facilitator remap
only applies to lines ending in '?' (pure questions are proxies for answers;
facilitator statements like read-backs can be evidence themselves).
"""
import json
import time

import httpx

OLLAMA_URL = "http://127.0.0.1:11434"
import os
MODEL = os.environ.get("TRIAGE_MODEL", "qwen2.5:7b-instruct")

PROMPT_V7 = """You are triaging a transcript of a real-world audio recording for a reviewer
who only has time to re-listen to {k} lines against the audio. The transcript
below may contain speech-recognition errors. Speaker labels are shown.

Pick the {k} lines where a transcription error would most badly mislead an
investigation or a court: factual claims about what happened — names, addresses,
times, places, vehicles, descriptions of people, quantities, weapon or tool
mentions, injuries, identifications, denials, and explicit confirmations or
corrections. When speakers disagree, the denial or correction is AS critical as
the claim it answers — cover both sides of any disputed point, and independent
corroborations of one side. Names, contact details, and injury statements given
for the record are also critical. Lines that only manage the conversation
(questions, instructions, greetings, small talk) are almost never worth a slot —
but such a line is worth one if getting IT wrong would itself mislead (e.g. a
wrong address read back).

Order them most-critical first.
Output strict JSON only: {{"top":[{{"id":<n>,"reason":"<=8 words>"}}]}} with
exactly {k} items — you must return exactly {k}, no fewer.
TRANSCRIPT:
"""

# Minimal prompt: task statement only — no rubric, no role guidance, no
# dispute clause. Tests whether a larger model self-derives the rubric (the
# v7 scaffolding was tuned on 7B failure modes and may be baggage elsewhere).
PROMPT_MINIMAL = """Below is a numbered transcript of an audio recording; it may contain
speech-recognition errors. A reviewer has time to re-listen to only {k} lines
against the audio. Pick the {k} lines where a transcription error would most
badly mislead an investigation or a court. Order them most-critical first.
Output strict JSON only: {{"top":[{{"id":<n>,"reason":"<=8 words>"}}]}} with exactly {k} items.
TRANSCRIPT:
"""

PROMPTS = {"v7": PROMPT_V7, "minimal": PROMPT_MINIMAL}
PROMPT_VARIANT = os.environ.get("TRIAGE_PROMPT", "v7")

SCENARIOS = {
    "A-911call": {
        "k": 8,
        "facilitators": {"DISPATCHER"},
        "gold": {3, 7, 9, 10, 16, 18, 21, 23},
        "lines": [
            ("DISPATCHER", "Emergency services, which service do you need?"),
            ("CALLER", "Police, please. There's someone breaking into the house next door."),
            ("DISPATCHER", "Okay. Can you give me the address?"),
            ("CALLER", "It's 47 Mill Lane in Harwick, the house with the green door."),
            ("DISPATCHER", "47 Mill Lane, Harwick. Is that right?"),
            ("CALLER", "Yes, that's right."),
            ("DISPATCHER", "What can you see happening right now?"),
            ("CALLER", "A man just forced the side gate and he's trying the back window."),
            ("DISPATCHER", "Can you describe him?"),
            ("CALLER", "Tall, maybe six foot, grey hoodie, dark jeans, and he's got gloves on."),
            ("CALLER", "He's carrying something long, it looks like a crowbar."),
            ("DISPATCHER", "Is anyone inside the property, do you know?"),
            ("CALLER", "I don't think so, the Pattersons are away this week."),
            ("DISPATCHER", "Okay, stay indoors and keep away from the windows."),
            ("CALLER", "Okay, I'm upstairs, I can see the garden from here."),
            ("CALLER", "There's a white van parked across the drive, engine running."),
            ("CALLER", "The plate starts with V-K-six-three, I can't see the rest."),
            ("DISPATCHER", "V-K-six-three, white van. That's really helpful."),
            ("CALLER", "He's inside now, I heard glass break."),
            ("DISPATCHER", "Officers are on their way, about four minutes out."),
            ("CALLER", "Hang on, he's coming back out, he's got a black holdall."),
            ("CALLER", "He's heading toward the van, they're turning toward the high street."),
            ("DISPATCHER", "And your name and number in case we're cut off?"),
            ("CALLER", "Sandra Okafor, oh seven seven double-two, one four one, nine eight oh."),
        ],
    },
    "B-monologue": {
        "k": 6,
        "facilitators": set(),
        "gold": {2, 4, 5, 7, 10, 11},
        "lines": [
            ("SPEAKER", "Hello, this is a message for DC Rowan at Ashfield CID."),
            ("SPEAKER", "My name is Priya Shah, I run the newsagent on Kingsmead Parade."),
            ("SPEAKER", "It's about the missing boy on the poster, Ethan Cole."),
            ("SPEAKER", "I'm fairly sure I saw him on Tuesday afternoon."),
            ("SPEAKER", "It would have been about quarter past four."),
            ("SPEAKER", "He was outside the retail park on Kingsmead Road, near the bus stop."),
            ("SPEAKER", "He was wearing a red jacket and carrying a blue rucksack."),
            ("SPEAKER", "He was with a tall woman, blonde hair, maybe forty."),
            ("SPEAKER", "I hadn't seen her around before."),
            ("SPEAKER", "They seemed to know each other, he wasn't upset or anything."),
            ("SPEAKER", "They got into a silver estate car parked on the corner."),
            ("SPEAKER", "The plate had K-P-two-two in it, that's all I caught."),
            ("SPEAKER", "The car went off toward the ring road."),
            ("SPEAKER", "I didn't think much of it at the time, sorry."),
            ("SPEAKER", "Then I saw the poster again this morning and it clicked."),
            ("SPEAKER", "I've got CCTV over the till but it only covers the shop inside."),
            ("SPEAKER", "Anyway, my number is oh seven nine, three three one, double four six two."),
            ("SPEAKER", "Call me back if it's useful. Thanks, bye."),
        ],
    },
    "C-multiparty": {
        "k": 8,
        "facilitators": {"OFFICER"},
        "gold": {2, 4, 6, 9, 12, 13, 14, 16},
        "lines": [
            ("OFFICER", "Right, everyone's okay? No one needs an ambulance?"),
            ("DRIVER1", "I'm fine, just shaken."),
            ("DRIVER2", "My wrist is a bit sore but I don't need anyone."),
            ("OFFICER", "Okay. Let's start with what happened."),
            ("DRIVER1", "I was coming down Station Road and the lights were green for me."),
            ("DRIVER1", "She just pulled out of Orchard Way straight across me."),
            ("DRIVER2", "That's not true, my light was green."),
            ("DRIVER2", "I waited for the filter arrow like I always do."),
            ("WITNESS", "I was on the corner by the bakery, I saw the whole thing."),
            ("WITNESS", "The lady's filter arrow wasn't on yet, she moved early."),
            ("DRIVER2", "I can't believe this."),
            ("OFFICER", "One at a time please."),
            ("WITNESS", "The green car was doing maybe thirty, thirty-five tops."),
            ("DRIVER2", "He was on his phone, I saw him look down."),
            ("DRIVER1", "I was not on my phone, it was in the glovebox the whole time."),
            ("OFFICER", "We can check that later."),
            ("WITNESS", "I didn't see a phone, for what it's worth."),
            ("OFFICER", "Sir, your name and details?"),
            ("DRIVER1", "Malik Osei, O-S-E-I, 12 Fenn Court."),
            ("OFFICER", "And yours, madam?"),
            ("DRIVER2", "Jean Harmer, H-A-R-M-E-R, 4 Orchard Way."),
            ("WITNESS", "Tom Bright, I work at the bakery there."),
            ("OFFICER", "Anyone else see it?"),
            ("DRIVER1", "There was a cyclist who stopped for a second, but he's gone."),
            ("DRIVER2", "The front wing is completely gone, look at it."),
            ("OFFICER", "Insurance details before you leave, both of you."),
            ("DRIVER1", "Course. My policy's with Fenchurch Mutual."),
            ("OFFICER", "Thanks. I'll take photos of the junction now."),
        ],
    },
    "D-casualchat": {
        "k": 6,
        "facilitators": set(),
        "gold": {5, 7, 9, 11, 13},
        "lines": [
            ("LEO", "Hey Dana, you still on for Saturday?"),
            ("DANA", "Yeah, thinking the early train, get there by ten."),
            ("LEO", "Perfect, I'll book the table for one o'clock."),
            ("DANA", "Nice. Oh, before I forget, guess what happened yesterday."),
            ("LEO", "Go on."),
            ("DANA", "My bike got nicked from behind the library."),
            ("LEO", "No way. The blue one?"),
            ("DANA", "Yeah, the blue Trek. The lock was cut clean through."),
            ("LEO", "When was this?"),
            ("DANA", "Must have been between five and six, I was in a seminar."),
            ("LEO", "That's brazen, it's right by the cameras."),
            ("DANA", "That's what I said. There was a guy in a green cap hanging round the racks when I locked up."),
            ("LEO", "Did you report it?"),
            ("DANA", "Yeah, online. They gave me a reference, hang on, CR-four-four-seven-one."),
            ("LEO", "Keep that safe. Insurance might want it."),
            ("DANA", "Already emailed them. Anyway, what were you saying about Saturday?"),
            ("LEO", "Just that Marco's joining us after lunch."),
            ("DANA", "Fine by me. He still owe you twenty quid?"),
            ("LEO", "Forty now, but who's counting."),
            ("DANA", "Ha. Right, I need to run, speak later."),
            ("LEO", "See you Saturday. Oh and send me the reference too, I know a guy at the shop."),
            ("DANA", "Will do. Bye."),
        ],
    },
}


INTERVIEW_OFFICER_IDS = {0, 1, 2, 4, 7, 9, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 29, 31}

def _load_interview_lines():
    t = json.load(open("src/data/defaultTranscript.json"))
    lines = []
    for s in t["segments"]:
        model = next(iter(s["words"]))
        text = " ".join(w["text"] for w in s["words"][model]).strip()
        lines.append(("OFFICER" if s["id"] in INTERVIEW_OFFICER_IDS else "WITNESS", text))
    return lines

SCENARIOS["E-interview"] = {
    "k": 8,
    "facilitators": {"OFFICER"},
    "gold": {5, 6, 8, 11, 17, 21, 25, 30},
    "lines": _load_interview_lines(),
}


def numbered(lines, order):
    return "\n".join(f"[{i}] {lines[i][0]}: {lines[i][1]}" for i in order)


def call(prompt):
    body = {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "format": "json",
        "options": {"temperature": 0, "seed": 0, "num_ctx": 4096},
    }
    if "qwen3" in MODEL:
        # Qwen3 is a hybrid thinking model; default off for pipeline speed —
        # TRIAGE_THINK=1 enables it (thinking goes to message.thinking; the
        # format:"json" grammar constrains only the final content).
        body["think"] = os.environ.get("TRIAGE_THINK") == "1"
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


def remap(picks, lines, facilitators):
    """Facilitator lines ending in '?' are proxies for the answer that follows —
    remap to the next non-facilitator line. Facilitator STATEMENTS (read-backs)
    are kept: they can be evidence themselves."""
    out = []
    for sid, reason in picks:
        speaker, text = lines[sid]
        if speaker in facilitators and text.rstrip().endswith("?"):
            nxt = next(
                (i for i in range(sid + 1, len(lines)) if lines[i][0] not in facilitators),
                None,
            )
            if nxt is None:
                continue
            sid, reason = nxt, reason + " (remapped)"
        if sid not in [x[0] for x in out]:
            out.append((sid, reason))
    return out


def run_scenario(name, cfg):
    lines = cfg["lines"]
    valid_ids = set(range(len(lines)))
    k, k_ask = cfg["k"], cfg["k"] + 4

    passes = {}
    for label, order in [("fwd", list(valid_ids)), ("rev", sorted(valid_ids, reverse=True))]:
        content, dt = call(PROMPTS[PROMPT_VARIANT].format(k=k_ask) + numbered(lines, order))
        picks = remap(parse_top(content, valid_ids), lines, cfg["facilitators"])
        passes[label] = picks
        print(f"  {label}: {dt:.1f}s, {len(picks)} picks")

    borda = {}
    for picks in passes.values():
        for rank, (sid, _) in enumerate(picks):
            borda[sid] = borda.get(sid, 0) + (k_ask - rank)
    reasons = {sid: r for picks in passes.values() for sid, r in picks}
    fused = sorted(borda.items(), key=lambda kv: (-kv[1], kv[0]))[:k]

    fused_set = {sid for sid, _ in fused}
    gold = cfg["gold"]
    f_set = {s for s, _ in passes["fwd"]}
    r_set = {s for s, _ in passes["rev"]}

    print(f"  == fused top-{k} ==")
    for rank, (sid, pts) in enumerate(fused, 1):
        mark = "✓" if sid in gold else " "
        print(f"   {mark}{rank}. [{sid:>2}] {lines[sid][0]:<10} | {lines[sid][1][:64]}")
    print(f"  recall: {len(fused_set & gold)}/{len(gold)}"
          f"  | missed: {sorted(gold - fused_set)}"
          f"  | cross-order overlap: {len(f_set & r_set)}/{min(len(f_set), len(r_set))}")
    return len(fused_set & gold), len(gold)


def main():
    total_hit = total_gold = 0
    only = os.environ.get("TRIAGE_ONLY")
    for name, cfg in SCENARIOS.items():
        if only and name != only:
            continue
        print(f"\n== {name} [{MODEL} / {PROMPT_VARIANT}] ({len(cfg['lines'])} lines, {len(set(s for s, _ in cfg['lines']))} speakers, K={cfg['k']}) ==")
        hit, gold = run_scenario(name, cfg)
        total_hit += hit
        total_gold += gold
    print(f"\n== OVERALL informal recall: {total_hit}/{total_gold} ==")


if __name__ == "__main__":
    main()
