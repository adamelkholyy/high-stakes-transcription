"""
focus.py
Component 2b — case-focused evidence retrieval.

A *retrieval overlay* on top of the trained importance scorer (2a). It trains
nothing: it reuses the same frozen MiniLM encoder that serve_model.py already
loads. Given a transcript and a small set of reviewer-supplied focus items
(`{label, aliases}`), it returns, per item, a top-K ranked list of evidence
snippets — combining

  - exact   : literal (case-insensitive) match of the focus *label*   (names,
              plates, amounts, weapons — where sentence embeddings are weak)
  - alias   : literal match of a reviewer-supplied *alias* of the label —
              either a surface variant ("gun"/"knife" for label "weapon") or a
              built-in *pattern alias* (`@clock`/`@money`/`@plate`/`@date`) that
              regex-matches identifier categories embeddings are weak on
              (e.g. "9.36" / "half past" for label "time")
  - semantic: cosine similarity between an alias-expanded query and the
              segment embedding (meaning spread — generalises to unseen wording)

Why aliases matter (measured on case447): the bare single-word query "weapon"
sits at cosine ~0.26 against the knife sentences — barely above noise (~0.18).
Expanding the query to "weapon such as gun, knife" lifts those to ~0.42 while
pushing unrelated sentences to ~0.10, i.e. it is the alias expansion (NOT a
lower threshold alone) that makes semantic recall usable on this encoder.
Aliases are reviewer-typed only — no LLM call, nothing leaves the machine.

The endpoint never mutates the transcript's 2a scores. It records each hit's
`original_combined_risk` so the front-end can apply a *traceable* HIGH upgrade
as an overlay and restore the default view on "Clear focus".
"""

from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Optional, Pattern

import numpy as np

# Match-type ranking: a literal hit outranks an alias hit outranks a purely
# semantic hit. Segments are sorted by (priority, semantic_score) descending so
# "why it matched" and "how relevant it is" stay separable (design v2 §3.1).
MATCH_PRIORITY = {"exact": 3, "alias": 2, "semantic": 1}

# ---------------------------------------------------------------------------
# Built-in pattern aliases (identifier categories)
# ---------------------------------------------------------------------------
# Sentence embeddings are weak on identifiers — times, amounts, plates, dates
# (design v2 §1). Literal-string aliases can't enumerate them all ("9.36",
# "9.42", "half past"...). So a focus item may reference a *pattern* alias by
# writing `@name` in its alias list (e.g. `time: morning, @clock`); the pattern
# is matched by regex over the segment text, not by the encoder. Reviewer-typed
# trigger only — still no LLM, nothing leaves the machine.
#
# NB the example transcript tokenises clock times oddly ("9 .42"), so the clock
# pattern tolerates whitespace around the separator.
# A number can be digits ("9", "1,200") or spelled out ("two", "twenty",
# "a few"), so quantity patterns (age/duration/distance/weight) catch both
# "20 metres" and "twenty metres". Multi-word forms come first so they win.
_NUM = (
    r"(?:a\s+couple\s+of|a\s+few|several|\d+(?:,\d{3})*"
    r"|one|two|three|four|five|six|seven|eight|nine|ten"
    r"|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen"
    r"|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|an|a)"
)

# Month names, anchored so "may" matches "May"/"may" but NOT "maybe", "mayor".
_MONTH = (
    r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?"
    r"|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
)

PATTERN_ALIASES: Dict[str, Pattern[str]] = {
    # --- time / date ---------------------------------------------------------
    "clock": re.compile(
        r"\b\d{1,2}\s*[.:]\s*\d{2}\b"          # 9.36 / 9:36 / "9 .36"
        r"|\bhalf\s+past\b|\b(?:a\s+)?quarter\s+(?:past|to)\b"
        r"|\bo'?clock\b|\b\d{1,2}\s*(?:am|pm|a\.m\.|p\.m\.)\b",
        re.I,
    ),
    "date": re.compile(
        r"\b\d{1,2}(?:st|nd|rd|th)?\s+" + _MONTH + r"\b"   # 14 March / 3rd Apr
        r"|\b" + _MONTH + r"\s+\d{1,2}\b"                  # March 14
        r"|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b",        # 14/03 or 14-03-2024
        re.I,
    ),
    # --- money / quantities --------------------------------------------------
    "money": re.compile(
        r"£\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?k)?"
        r"|\$\s?\d[\d,]*(?:\.\d{1,2})?"
        rf"|\b{_NUM}\s?(?:pounds?|quid|dollars?|euros?|pence|grand)\b",
        re.I,
    ),
    "age": re.compile(
        rf"\baged\s+{_NUM}\b"
        rf"|\b{_NUM}[\s-]years?[\s-]old\b"
        rf"|\b{_NUM}[\s-]months?[\s-]old\b",
        re.I,
    ),
    "duration": re.compile(
        rf"\b{_NUM}\s?(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|fortnights?)\b"
        r"|\bhalf\s+an?\s+hour\b|\bquarter\s+of\s+an\s+hour\b",
        re.I,
    ),
    "distance": re.compile(
        rf"\b{_NUM}\s?(?:millimetres?|millimeters?|centimetres?|centimeters?|cm"
        r"|metres?|meters?|kilometres?|kilometers?|km|miles?|feet|foot|yards?)\b",
        re.I,
    ),
    "weight": re.compile(
        rf"\b{_NUM}\s?(?:grams?|grammes?|kilograms?|kilos?|kg|ounces?|oz|stones?|pounds?|lbs?)\b",
        re.I,
    ),
    # --- identifiers (police / forensic) ------------------------------------
    "plate": re.compile(
        r"\b[A-Z]{2}\d{2}\s?[A-Z]{3}\b"        # current UK: BX17 ABC
        r"|\b[A-Z]\d{1,3}\s?[A-Z]{3}\b",        # older styles
        re.I,
    ),
    "phone": re.compile(
        r"(?:\+44\s?|\b0)\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b",
        re.I,
    ),
    "email": re.compile(
        r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
    ),
    "postcode": re.compile(  # UK: SW1A 1AA / M1 1AE / B33 8TH
        r"\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b",
        re.I,
    ),
    "ni": re.compile(  # UK National Insurance no.: AB123456C
        r"\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b",
        re.I,
    ),
    "caseref": re.compile(  # case 447 / crime reference 12345/AB / CRN AB12
        r"\bcase\s+(?:no\.?\s*|number\s+)?\d+\b"
        r"|\b(?:crime\s+reference|crime\s+ref|reference|ref)\s*(?:no\.?|number)?\s*"
        r"[:#]?\s*(?=[A-Za-z0-9/-]*\d)[A-Za-z0-9/-]+\b"
        r"|\bcrn\s*[:#]?\s*[A-Za-z0-9/-]+\b",
        re.I,
    ),
    "exhibit": re.compile(  # exhibit AB/1, exhibit reference JS1
        r"\bexhibit\s+(?:no\.?|number|reference|ref)?\s*[:#]?\s*[A-Za-z]{1,4}[\s/-]?\d+[A-Za-z0-9/-]*\b",
        re.I,
    ),
}
# Friendly synonyms so reviewers don't have to memorise the canonical key.
_PATTERN_SYNONYMS = {
    "time": "clock", "times": "clock", "oclock": "clock",
    "amount": "money", "amounts": "money", "cash": "money", "price": "money", "cost": "money",
    "registration": "plate", "reg": "plate", "numberplate": "plate",
    "licenceplate": "plate", "licenseplate": "plate", "vrm": "plate",
    "telephone": "phone", "mobile": "phone", "cell": "phone", "phonenumber": "phone",
    "mail": "email", "e-mail": "email", "emailaddress": "email",
    "zip": "postcode", "zipcode": "postcode", "postal": "postcode",
    "nino": "ni", "ninumber": "ni", "nationalinsurance": "ni",
    "crimeref": "caseref", "crimereference": "caseref", "reference": "caseref",
    "ref": "caseref", "case": "caseref", "crn": "caseref",
    "length": "distance", "dist": "distance",
    "mass": "weight", "weights": "weight",
    "exhibitref": "exhibit",
}


def resolve_pattern_alias(name: str) -> Optional[Pattern[str]]:
    """Map an `@name` alias token to its compiled regex, or None if unknown."""
    key = name.lstrip("@").strip().lower()
    key = _PATTERN_SYNONYMS.get(key, key)
    return PATTERN_ALIASES.get(key)


def auto_pattern_for(word: str) -> Optional[Pattern[str]]:
    """Default mapping so ordinary users need not type "@": if a plain word
    *is* a category name (or its synonym/plural), return that pattern's regex.
    e.g. focus label "time" -> @clock, "phone" -> @phone, "ages" -> @age.
    Matches whole tokens only (despaced), never substrings ("update" ≠ date)."""
    key = "".join(word.lower().split())
    if not key:
        return None
    for k in (key, key[:-1] if key.endswith("s") else key):
        rx = PATTERN_ALIASES.get(_PATTERN_SYNONYMS.get(k, k))
        if rx is not None:
            return rx
    return None

# Tiny stopword set used only to pick which words of a *semantic* match get the
# inline highlight (content words). Exact matches highlight their literal span,
# so this list does not need to be exhaustive.
_STOPWORDS = {
    "a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on", "at",
    "by", "for", "with", "from", "into", "is", "was", "are", "were", "be",
    "been", "being", "i", "you", "he", "she", "it", "we", "they", "him", "her",
    "them", "me", "my", "his", "your", "their", "its", "this", "that", "these",
    "those", "as", "so", "not", "no", "do", "did", "does", "have", "has", "had",
    "will", "would", "can", "could", "there", "what", "when", "where", "who",
    "how", "about", "up", "out", "down", "just", "then", "than", "too", "very",
}


def _norm(text: str, clean_for_model: Callable[[str], str]) -> str:
    """Lowercased, punctuation-stripped token for literal matching."""
    return clean_for_model(text).lower()


# ---------------------------------------------------------------------------
# Approximate literal matching (handles messy ASR output)
# ---------------------------------------------------------------------------
# Transcripts are noisy: names are mis-heard ("Reece"/"Rees"/"Reese"), words
# carry typos, and morphology varies ("supply"/"supplied"/"supplying"). Strict
# string equality misses all of these, so the literal matcher layers four
# signals, best first: exact == > stem (morphology) > partial (compounds) >
# phonetic (sounds-alike, for names) > fuzzy (edit distance, for typos). Each
# hit reports HOW it matched (`match_detail`) for transparency + ranking.

# How strong each kind of literal match is (used for ranking + display).
# "expanded" = a literal hit on an auto-derived semantic neighbour (ranks below
# the reviewer's own term/aliases but above purely-phonetic/fuzzy guesses).
_DETAIL_RANK = {
    "literal": 4, "pattern": 4, "stem": 3, "partial": 3,
    "expanded": 2, "phonetic": 1, "fuzzy": 1,
}

# Inflectional suffixes, longest/safest first. Deliberately conservative: no
# generic "-es"/"-ly" (they over-strip, e.g. machines->machin, supply->supp).
_STEM_RULES = [
    ("ies", "y"), ("ied", "y"), ("ying", "y"),
    ("sses", "ss"), ("ches", "ch"), ("shes", "sh"), ("xes", "x"), ("zes", "z"),
    ("edly", ""), ("ing", ""), ("ed", ""), ("er", ""), ("s", ""),
]

# Irregular plurals / forms a suffix rule can't reach (knife<->knives etc.).
# A "-ves" rule would wrongly hit moves/loves, so list the real cases instead.
_IRREGULAR = {
    "knives": "knife", "wives": "wife", "lives": "life", "leaves": "leaf",
    "thieves": "thief", "halves": "half", "wolves": "wolf", "shelves": "shelf",
    "scarves": "scarf", "men": "man", "women": "woman", "children": "child",
    "people": "person", "feet": "foot", "teeth": "tooth", "mice": "mouse",
}


def _stem(w: str) -> str:
    """Very small, conservative inflectional stemmer (drugs->drug,
    supplied/supplying->supply, dealer/dealing->deal, knives->knife)."""
    if w in _IRREGULAR:
        return _IRREGULAR[w]
    if len(w) <= 3:
        return w
    for suf, rep in _STEM_RULES:
        # Guard against over-stripping: the remaining base (incl. replacement)
        # must stay >= 3 chars (so "boxes"->"box" via -xes, not "boxe" via -s).
        if w.endswith(suf) and len(w) - len(suf) + len(rep) >= 3:
            base = w[: -len(suf)] + rep
            # collapse a doubled final consonant left by -ing/-ed (running->run)
            if rep == "" and len(base) >= 4 and base[-1] == base[-2] and base[-1] not in "aeiou":
                base = base[:-1]
            return base
    return w


_SOUNDEX_CODES = {**dict.fromkeys("BFPV", "1"), **dict.fromkeys("CGJKQSXZ", "2"),
                  **dict.fromkeys("DT", "3"), "L": "4", **dict.fromkeys("MN", "5"), "R": "6"}


def _soundex(s: str) -> str:
    """Standard Soundex code — groups names that sound alike
    (Reece/Rees/Reese -> R200, Millend/Milland -> M453)."""
    s = "".join(c for c in s.upper() if c.isalpha())
    if not s:
        return ""
    out = s[0]
    prev = _SOUNDEX_CODES.get(s[0], "")
    for ch in s[1:]:
        code = _SOUNDEX_CODES.get(ch, "")
        if code and code != prev:
            out += code
        if ch not in "HW":  # H/W are transparent; vowels reset (code "")
            prev = code
    return (out + "000")[:4]


def _edit_ratio(a: str, b: str) -> float:
    """Normalised Levenshtein similarity in [0,1] (1.0 == identical)."""
    if a == b:
        return 1.0
    la, lb = len(a), len(b)
    if not la or not lb:
        return 0.0
    prev = list(range(lb + 1))
    for i in range(1, la + 1):
        cur = [i] + [0] * lb
        for j in range(1, lb + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return 1 - prev[lb] / max(la, lb)


_FUZZY_MIN = 0.85  # min edit similarity for a typo/ASR-variant match


def _tok_match(term: str, tok: str, *, approx: bool = True) -> Optional[str]:
    """Compare a query token to a transcript token; return the match detail
    ("literal"/"stem"/"partial"/"phonetic"/"fuzzy") or None. `approx=False`
    restricts to literal+stem (used inside multi-word phrases to limit noise)."""
    if term == tok:
        return "literal"
    if len(term) >= 3 and len(tok) >= 3 and _stem(term) == _stem(tok):
        return "stem"
    # compound / prefix ("gun"->"gunpoint", "drug"->"drugstore"), either way
    if len(term) >= 3 and len(tok) >= 3 and (tok.startswith(term) or term.startswith(tok)):
        return "partial"
    if approx and len(term) >= 4 and len(tok) >= 4:
        if _soundex(term) == _soundex(tok) and _edit_ratio(term, tok) >= 0.5:
            return "phonetic"
        if _edit_ratio(term, tok) >= _FUZZY_MIN:
            return "fuzzy"
    return None


def _literal_match(tokens: List[str], term_tokens: List[str]):
    """Find `term_tokens` in `tokens` allowing approximate matches.
    Returns (matched_word_indices, match_detail) or ([], None)."""
    if not term_tokens:
        return [], None
    n, m = len(tokens), len(term_tokens)
    if m == 1:
        t = term_tokens[0]
        best = None  # (indices, detail, rank)
        for i, tok in enumerate(tokens):
            d = _tok_match(t, tok)
            if d:
                rank = _DETAIL_RANK[d]
                if best is None or rank > best[2]:
                    best = ([i], d, rank)
                if d == "literal":
                    break
        return (best[0], best[1]) if best else ([], None)
    # Multi-word: contiguous window, literal/stem per token only.
    for i in range(n - m + 1):
        details = [_tok_match(term_tokens[j], tokens[i + j], approx=False) for j in range(m)]
        if all(details):
            worst = min(details, key=lambda d: _DETAIL_RANK[d])
            return list(range(i, i + m)), worst
    return [], None


def _content_indices(
    words: List[Dict[str, Any]], clean_for_model: Callable[[str], str]
) -> List[int]:
    """Indices of content words (drop stopwords + pure-punctuation tokens).
    Used to highlight a purely-semantic match at sentence granularity."""
    out: List[int] = []
    for i, w in enumerate(words):
        norm = _norm(w.get("text", ""), clean_for_model)
        if norm and norm not in _STOPWORDS:
            out.append(i)
    return out


def _salient_indices(
    words: List[Dict[str, Any]],
    sim_map: Dict[str, float],
    clean_for_model: Callable[[str], str],
    top_k: int = 3,
    floor: float = 0.30,
) -> List[int]:
    """For a SEMANTIC match, highlight only the few content words closest in
    meaning to the query — not the whole sentence. Reuses the per-word query
    similarities already computed for auto-expansion (`sim_map`: normalised word
    -> cosine to the label), so there's no extra embedding cost. Keeps the
    top-`top_k` words above `floor`; if none clear the floor the single best
    word still anchors the hit so a semantic match is never left un-marked."""
    scored: List[tuple] = []
    for i, w in enumerate(words):
        norm = _norm(w.get("text", ""), clean_for_model)
        if not norm or norm in _STOPWORDS:
            continue
        s = sim_map.get(norm)
        if s is None:
            s = sim_map.get(_stem(norm), -1.0)
        scored.append((s, i))
    if not scored:
        return []
    scored.sort(key=lambda t: t[0], reverse=True)
    keep = [i for s, i in scored if s >= floor][:top_k]
    if not keep:
        keep = [scored[0][1]]
    return sorted(keep)


def original_combined_risk(seg: Dict[str, Any], words: List[Dict[str, Any]]) -> str:
    """What 2a's default scoring showed for this segment: per-word max of
    `combined_risk`, falling back to the segment's upstream `paraRisk`. Recorded
    on every snippet so the focus HIGH upgrade stays a traceable, reversible
    overlay. Shared by the lexical and LLM retrieval paths."""
    out = seg.get("paraRisk", "low")
    for w in words:
        cr = w.get("combined_risk")
        if cr == "high":
            return "high"
        if cr == "med" and out != "high":
            out = "med"
    return out


def _build_vocab(seg_tokens: List[List[str]]) -> List[str]:
    """Distinct content words in the transcript (the expansion vocabulary).
    Tokens are already normalised; keep alphabetic words >=3 chars, drop
    stopwords/numbers."""
    vocab = set()
    for toks in seg_tokens:
        for t in toks:
            if len(t) >= 3 and t.isalpha() and t not in _STOPWORDS:
                vocab.add(t)
    return sorted(vocab)


def _word_offsets(words: List[Dict[str, Any]]) -> List[tuple]:
    """Char [start, end) of each word inside `" ".join(word texts)`, so a regex
    match over the joined segment text can be mapped back to word indices."""
    offs: List[tuple] = []
    pos = 0
    for w in words:
        t = w.get("text", "")
        offs.append((pos, pos + len(t)))
        pos += len(t) + 1  # +1 for the joining space
    return offs


def _pattern_indices(
    seg_text: str, offsets: List[tuple], regex: Pattern[str]
) -> List[int]:
    """Word indices overlapped by any regex match of `regex` in `seg_text`."""
    idx: List[int] = []
    for m in regex.finditer(seg_text):
        ms, me = m.start(), m.end()
        for i, (ws, we) in enumerate(offsets):
            if ws < me and we > ms:  # span overlap
                idx.append(i)
    return sorted(set(idx))


def _build_query(label: str, literal_aliases: List[str]) -> str:
    """Alias-expanded query string for the encoder. With literal aliases this is
    the natural-language template measured to separate best on case447
    ("weapon such as gun, knife"); without them it is just the bare label.
    Pattern aliases (@clock, @money...) are NOT embedded — they are identifier
    regexes, meaningless to the encoder — so they are excluded here."""
    aliases = [a.strip() for a in literal_aliases if a and a.strip()]
    if aliases:
        return f"{label} such as {', '.join(aliases)}"
    return label


def run_focus(
    transcript: Dict[str, Any],
    focus_terms: List[Dict[str, Any]],
    *,
    encoder: Any,
    pick_model: Callable[[Dict[str, Any], Optional[str]], str],
    clean_for_model: Callable[[str], str],
    threshold: float = 0.30,
    top_k: int = 8,
    model_name: Optional[str] = None,
    auto_expand: bool = True,
    expand_threshold: float = 0.55,
    expand_top_k: int = 4,
) -> Dict[str, Any]:
    """Hybrid exact + alias + semantic retrieval over the transcript's segments.

    `focus_terms` is a list of {label, aliases?} items. Returns
    {"terms": [{focus_label, snippets: [...]}], ...} where each snippet carries
    match_type (exact/alias/semantic), focus_score, evidence text, the word
    indices to highlight, and the segment's untouched combined_risk
    (original_combined_risk).
    """
    segments = transcript.get("segments") or []

    # ----- Per-segment: selected model branch, words, readable text, norm tokens
    seg_words: List[List[Dict[str, Any]]] = []
    seg_text: List[str] = []
    seg_tokens: List[List[str]] = []
    seg_offsets: List[List[tuple]] = []
    for seg in segments:
        mname = pick_model(seg, model_name)
        words = seg["words"][mname]
        seg_words.append(words)
        seg_text.append(" ".join(w.get("text", "") for w in words).strip())
        seg_tokens.append([_norm(w.get("text", ""), clean_for_model) for w in words])
        seg_offsets.append(_word_offsets(words))

    # ----- Normalise the focus items. Aliases split into literal strings (which
    # widen the embedded query) and @pattern references (identifier regexes,
    # matched literally, never embedded).
    items: List[Dict[str, Any]] = []
    for raw in focus_terms:
        label = (raw.get("label") or "").strip()
        if not label:
            continue
        raw_aliases = [a.strip() for a in (raw.get("aliases") or []) if a and a.strip()]
        literal_aliases = [a for a in raw_aliases if not a.startswith("@")]
        patterns = [rx for a in raw_aliases if a.startswith("@")
                    for rx in (resolve_pattern_alias(a),) if rx is not None]
        # Default mapping: ordinary users need not type "@". If the label (any of
        # its words) or a literal alias *is* a category name, apply that pattern
        # automatically too. e.g. focus "time" -> @clock, "phone" -> @phone.
        for tok in [label, *label.split(), *literal_aliases,
                    *(w for a in literal_aliases for w in a.split())]:
            rx = auto_pattern_for(tok)
            if rx is not None and rx not in patterns:
                patterns.append(rx)
        items.append({
            "label": label,
            "aliases": literal_aliases,
            "patterns": patterns,
            "auto_aliases": [],
            "query": _build_query(label, literal_aliases),
        })

    # ----- Auto query expansion (no user aliases needed) ---------------------
    # Embed the transcript's own content words and, per focus label, pull the
    # nearest ones as auto-aliases. These both widen the embedded query AND get
    # literal-matched (precise spans). Because the expansion vocabulary IS the
    # transcript, this generalises to whatever wording a case happens to use —
    # search "weapon" and it discovers this case says "knife"/"gun".
    # encoder=None -> degraded mode (no semantic leg): exact/alias/@pattern
    # matching still runs in full. Useful on machines that cannot comfortably
    # load SentenceTransformer.
    # Per-item {normalised word -> cosine to the label}: powers BOTH the auto-
    # expansion below AND the salient-word highlighting of semantic matches.
    word_sims: List[Dict[str, float]] = [{} for _ in items]
    vocab = _build_vocab(seg_tokens) if (auto_expand and items and encoder is not None) else []
    if vocab:
        vocab_emb = encoder.encode(vocab, batch_size=64, convert_to_numpy=True)
        vocab_emb = vocab_emb / (np.linalg.norm(vocab_emb, axis=1, keepdims=True) + 1e-9)
        label_emb = encoder.encode([it["label"] for it in items], batch_size=64, convert_to_numpy=True)
        label_emb = label_emb / (np.linalg.norm(label_emb, axis=1, keepdims=True) + 1e-9)
        for i, it in enumerate(items):
            # Don't re-add the term itself, its inflections, or existing aliases.
            excl = set()
            for phrase in [it["label"], *it["aliases"]]:
                for tok in phrase.split():
                    c = _norm(tok, clean_for_model)
                    if c:
                        excl.add(c)
                        excl.add(_stem(c))
            sims_w = vocab_emb @ label_emb[i]
            word_sims[i] = {vocab[j]: float(sims_w[j]) for j in range(len(vocab))}
            autos: List[str] = []
            for j in np.argsort(-sims_w):
                if sims_w[j] < expand_threshold:
                    break
                w = vocab[j]
                if w in excl or _stem(w) in excl:
                    continue
                autos.append(w)
                if len(autos) >= expand_top_k:
                    break
            if autos:
                it["auto_aliases"] = autos
                it["query"] = _build_query(it["label"], it["aliases"] + autos)

    # ----- One batched encode for all segments + all (possibly expanded) queries
    if segments and items and encoder is not None:
        seg_emb = encoder.encode(seg_text, batch_size=64, convert_to_numpy=True)
        q_emb = encoder.encode([it["query"] for it in items], batch_size=64, convert_to_numpy=True)
        seg_emb = seg_emb / (np.linalg.norm(seg_emb, axis=1, keepdims=True) + 1e-9)
        q_emb = q_emb / (np.linalg.norm(q_emb, axis=1, keepdims=True) + 1e-9)
        sims = q_emb @ seg_emb.T  # (n_items, n_seg) cosine
    else:
        sims = np.zeros((len(items), len(segments)))

    terms_out: List[Dict[str, Any]] = []
    for qi, item in enumerate(items):
        label = item["label"]
        label_tokens = [t for t in (_norm(tok, clean_for_model) for tok in label.split()) if t]
        # Each alias as its own normalised token sequence, for literal matching.
        alias_token_seqs = [
            [t for t in (_norm(tok, clean_for_model) for tok in a.split()) if t]
            for a in item["aliases"]
        ]
        # Auto-expansion words are single normalised vocab tokens.
        auto_alias_seqs = [[w] for w in item["auto_aliases"]]

        candidates: List[Dict[str, Any]] = []
        for s_idx, seg in enumerate(segments):
            sem_score = float(sims[qi, s_idx])
            # Label match (exact/stem/phonetic/fuzzy) ...
            exact_idx, exact_detail = _literal_match(seg_tokens[s_idx], label_tokens)
            alias_idx: List[int] = []
            alias_detail: Optional[str] = None
            if not exact_idx:
                # ... then literal aliases (same approximate matching) ...
                for seq in alias_token_seqs:
                    alias_idx, alias_detail = _literal_match(seg_tokens[s_idx], seq)
                    if alias_idx:
                        break
                # ... then auto-expanded semantic-neighbour words ...
                if not alias_idx:
                    for seq in auto_alias_seqs:
                        idx, _d = _literal_match(seg_tokens[s_idx], seq)
                        if idx:
                            alias_idx, alias_detail = idx, "expanded"
                            break
                # ... then @pattern aliases (times/amounts/plates/dates).
                if not alias_idx:
                    for rx in item["patterns"]:
                        alias_idx = _pattern_indices(seg_text[s_idx], seg_offsets[s_idx], rx)
                        if alias_idx:
                            alias_detail = "pattern"
                            break

            # Keep literal (exact/alias) matches regardless of similarity; keep
            # purely-semantic matches only above threshold (over-flag fix §3.2).
            if not exact_idx and not alias_idx and sem_score < threshold:
                continue

            if exact_idx:
                match_type, hi_idx, detail = "exact", exact_idx, exact_detail
            elif alias_idx:
                match_type, hi_idx, detail = "alias", alias_idx, alias_detail
            else:
                # Highlight only the few words closest to the query, not the
                # whole sentence — semantic matches used to paint every content
                # word purple, which read as noise.
                match_type, hi_idx, detail = "semantic", _salient_indices(
                    seg_words[s_idx], word_sims[qi], clean_for_model
                ), None

            words = seg_words[s_idx]
            is_literal = match_type in ("exact", "alias")
            spans = [words[i].get("text", "") for i in hi_idx] if is_literal else []
            original = original_combined_risk(seg, words)

            candidates.append(
                {
                    "segment_id": seg.get("id"),
                    "segment_start": seg.get("start"),
                    "match_type": match_type,
                    "match_detail": detail,
                    "focus_score": round(sem_score, 4),
                    "evidence": seg_text[s_idx],
                    "highlight_word_indices": hi_idx,
                    "highlight_spans": spans,
                    "original_combined_risk": original,
                    # Rank: match type, then how literal the match is (exact >
                    # stem/partial > phonetic/fuzzy), then semantic similarity.
                    "_sort": (MATCH_PRIORITY[match_type], _DETAIL_RANK.get(detail, 0), sem_score),
                }
            )

        candidates.sort(key=lambda c: c["_sort"], reverse=True)
        for c in candidates:
            del c["_sort"]
        terms_out.append({
            "focus_label": label,
            "query": item["query"],
            "auto_aliases": item["auto_aliases"],
            "snippets": candidates[:top_k],
        })

    return {"terms": terms_out, "_threshold": threshold, "_top_k": top_k}
