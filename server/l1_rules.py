"""
l1_rules.py
L1 rule baseline for police-interview token importance — ported verbatim from
modelData/train_l1_l2.py (HIGH_LEXICON / MED_LEXICON / number / money /
proper-noun rules) so the online service can reproduce the offline-validated
L1+L2 cascade (C2_gate: HIGH if L1==HIGH else argmax_L2(MEDIUM, LOW)), which
lifts gold HIGH-precision 0.45 -> 0.95 vs. the raw L2.

Why a port (not an import): modelData/ lives outside this repo and is a sibling
project; we copy the rules here so the server has no cross-directory dependency.

Difference from the training l1_predict (deliberate, in the improving
direction): training fed l1_predict the *raw* target_word (so "money?"/"19."
with trailing punctuation could miss the lexicon/number rules) and detected
sentence-start from the punctuation kept in the context string. At serve time
serve_model.build_context() strips punctuation, which would break sentence-start
detection (every capitalised word — including sentence-initial "The"/"But" —
would look like a mid-sentence proper noun and flood HIGH). So here we:
  * match lexicon/number on the punctuation-stripped, lowercased token, and
  * detect sentence-start from the *previous raw token's* trailing . ! ? .
"""

from __future__ import annotations

import re
from typing import Optional, Tuple

# --- lexicons (verbatim from train_l1_l2.py) -------------------------------

HIGH_LEXICON = {
    # weapons
    "gun", "guns", "knife", "knives", "weapon", "weapons", "blade",
    "pistol", "revolver", "rifle", "shotgun", "glock", "machete",
    # negations
    "not", "no", "never", "nothing", "nobody", "none", "neither", "nor",
    "n't", "n’t",
    # critical actions / evidence
    "threaten", "threatened", "threatens", "threats", "threat",
    "stolen", "steal", "stole",
    "hit", "hits", "hitting", "punched", "punch", "kicked", "kick",
    "stabbed", "stab", "shot", "shoot",
    # critical nouns
    "cctv", "dashcam", "footage", "plate", "registration",
    "cash", "money",
    # emergency numbers
    "999", "101", "112",
    # --- extension (this project): serious-violence / homicide / sexual /
    # abduction terms the original lexicon omitted. The validated cascade only
    # had shot/stab/hit, so it missed kill/murder/execute on a homicide
    # confession. Tunable; re-validate on gold as future work. ---
    "kill", "kills", "killed", "killing",
    "murder", "murders", "murdered", "murdering",
    "execute", "executed", "executes", "execution",
    "strangle", "strangled", "strangling", "choke", "choked",
    "attack", "attacked", "attacks", "assault", "assaulted", "assaults",
    "beat", "beaten", "drown", "drowned", "suffocate", "suffocated",
    "kidnap", "kidnapped", "abduct", "abducted", "hostage", "captured",
    "rape", "raped", "rapes", "raping", "abuse", "abused",
    "corpse",
}

MED_LEXICON = {
    # modal / uncertainty
    "maybe", "might", "could", "would", "should", "may", "must",
    "perhaps", "probably", "possibly", "likely", "unlikely",
    "think", "thought", "believe", "believed", "guess", "suppose",
    "seem", "seemed", "seems", "sort", "kind",
    # hedging degree
    "very", "quite", "fairly", "pretty", "really", "rather",
    "about", "around", "approximately", "roughly", "nearly", "almost",
    # vague reference
    "someone", "something", "somewhere", "somebody",
}

_NUM_RE = re.compile(r"\d+(?::\d+)?(?:\.\d+)?")
_MONEY_RE = re.compile(r"^[£$]\d")

# Punctuation stripped before lexicon/number matching. Matches serve_model's
# clean_for_model (keeps internal hyphens/apostrophes and the £/$ prefix).
_PUNCT_STRIP = '.,!?;:"\'()[]'
_SENT_END = (".", "!", "?")

# Reason codes for the HIGH decision (for diagnostics / audit).
REASON_LEXICON = "lexicon"
REASON_NUMBER = "number"
REASON_MONEY = "money"
REASON_PROPER = "propernoun"
REASON_MED = "med"
REASON_LOW = "low"


def _clean(text: str) -> str:
    return text.strip().strip(_PUNCT_STRIP).strip()


def l1_label_explained(
    raw_word: str,
    prev_raw_word: Optional[str] = None,
    is_first: bool = False,
) -> Tuple[str, str]:
    """Return (label, reason) for one token.

    raw_word:      the token as displayed (serve_model's w["text"]) — casing and
                   punctuation preserved.
    prev_raw_word: the previous token's raw text, used for sentence-start
                   detection. None when is_first.
    is_first:      True if this is the first token of the segment.
    """
    cleaned = _clean(raw_word)
    w = cleaned.lower()

    # Priority 1: HIGH lexicon hit.
    if w in HIGH_LEXICON:
        return "HIGH", REASON_LEXICON

    # Priority 2: pure number (date / amount / address / time).
    if w and _NUM_RE.fullmatch(w):
        return "HIGH", REASON_NUMBER

    # Priority 3: money with a currency prefix.
    if _MONEY_RE.match(cleaned):
        return "HIGH", REASON_MONEY

    # Priority 4: capitalised mid-sentence alphabetic token -> likely proper noun.
    # Exclude the pronoun "I", which is always capitalised but never a name.
    is_sentence_start = is_first or (
        prev_raw_word is not None and prev_raw_word.rstrip().endswith(_SENT_END)
    )
    if (cleaned[:1].isupper() and not is_sentence_start
            and cleaned.isalpha() and cleaned != "I"):
        return "HIGH", REASON_PROPER

    # Priority 5: MED lexicon.
    if w in MED_LEXICON:
        return "MEDIUM", REASON_MED

    return "LOW", REASON_LOW


def l1_label(
    raw_word: str,
    prev_raw_word: Optional[str] = None,
    is_first: bool = False,
) -> str:
    return l1_label_explained(raw_word, prev_raw_word, is_first)[0]
