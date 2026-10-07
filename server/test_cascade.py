"""
test_cascade.py
Unit tests for the L1-gated importance cascade.

Covers:
  * l1_rules.l1_label — lexicon (incl. the serious-violence extension), number,
    money, proper-noun (incl. sentence-start handling + the "I" fix), MED, LOW;
  * serve_model.cascade_importance — C2_gate (HIGH iff L1, else better of MED/LOW);
  * serve_model.combine — the importance x uncertainty 2x2.

serve_model imports sentence_transformers + loads the model at import time, which
isn't needed to test the pure decision logic — so we stub the encoder before
importing it. Run:  python3 test_cascade.py   (or: pytest test_cascade.py)
"""

import sys
import types

# --- stub the heavy encoder dep so `import serve_model` succeeds without it ---
if "sentence_transformers" not in sys.modules:
    _st = types.ModuleType("sentence_transformers")

    class _FakeST:  # never actually used by these tests
        def __init__(self, *a, **k):
            pass

        def encode(self, *a, **k):
            raise RuntimeError("encoder not available in unit tests")

    _st.SentenceTransformer = _FakeST
    sys.modules["sentence_transformers"] = _st

import l1_rules as L            # noqa: E402
import serve_model as sm        # noqa: E402  (loads the real l2_clean.joblib)


# ---------------------------------------------------------------------------
# l1_rules.l1_label
# ---------------------------------------------------------------------------

def test_high_lexicon():
    for w in ("gun", "knife", "not", "no", "cash", "money", "stolen", "999"):
        assert L.l1_label(w, "and", False) == "HIGH", w


def test_violence_extension():
    # the words the original lexicon missed and we added
    for w in ("kill", "killed", "murdered", "executed", "strangled",
              "assault", "kidnapped", "raped", "captured"):
        assert L.l1_label(w, "he", False) == "HIGH", w


def test_lexicon_strips_punctuation():
    # raw tokens carry punctuation; lexicon should still match
    assert L.l1_label("money?", "the", False) == "HIGH"
    assert L.l1_label("gun.", "a", False) == "HIGH"
    assert L.l1_label("No,", "said", False) == "HIGH"


def test_number_and_money():
    assert L.l1_label("19", "were", False) == "HIGH"
    assert L.l1_label("19.", "were", False) == "HIGH"      # trailing punct ok
    assert L.l1_label("10:05", "at", False) == "HIGH"      # time
    assert L.l1_label("£50", "owed", False) == "HIGH"      # currency prefix
    assert L.l1_label("twenty", "the", False) != "HIGH"    # word, not a number


def test_proper_noun_midsentence():
    assert L.l1_label("Navy", "the", False) == "HIGH"          # mid-sentence cap
    assert L.l1_label("Germans.", "the", False) == "HIGH"      # cap + trailing dot
    assert L.l1_label("Jerry", "killed", False) == "HIGH"


def test_proper_noun_sentence_start_not_flagged():
    # capitalised word at the start of a sentence is NOT a proper noun
    assert L.l1_label("The", "boats.", False) == "LOW"        # prev ends with .
    assert L.l1_label("But", "us!", False) == "LOW"
    assert L.l1_label("Navy", None, True) == "LOW"            # first token


def test_pronoun_I_not_flagged():
    # the "I" false-positive fix
    assert L.l1_label("I", "said", False) == "LOW"
    assert L.l1_label("I", "and", False) == "LOW"


def test_med_and_low():
    for w in ("maybe", "might", "think", "probably", "about"):
        assert L.l1_label(w, "and", False) == "MEDIUM", w
    for w in ("the", "was", "and", "boats", "interview"):
        assert L.l1_label(w, "and", False) == "LOW", w


# ---------------------------------------------------------------------------
# serve_model.cascade_importance  (C2_gate)
# ---------------------------------------------------------------------------

def test_cascade_high_gated_by_l1_only():
    # L1 HIGH -> high regardless of L2 probabilities
    assert sm.cascade_importance("HIGH", 0.0, 1.0) == "high"
    # L1 not HIGH -> L2's own HIGH is ignored; pick better of MED/LOW
    assert sm.cascade_importance("LOW", 0.7, 0.3) == "med"
    assert sm.cascade_importance("LOW", 0.2, 0.8) == "low"
    assert sm.cascade_importance("MEDIUM", 0.5, 0.5) == "med"   # tie -> med


# ---------------------------------------------------------------------------
# serve_model.combine  (importance x uncertainty 2x2)
# ---------------------------------------------------------------------------

def test_combine_2x2():
    # importance HIGH -> red at any uncertainty
    for u in ("low", "med", "high"):
        assert sm.combine(u, "high") == "high", u
    # importance MED -> red only when uncertainty is high
    assert sm.combine("low", "med") == "med"
    assert sm.combine("med", "med") == "med"
    assert sm.combine("high", "med") == "high"
    # importance LOW -> uncertainty alone never reaches red
    assert sm.combine("low", "low") == "low"
    assert sm.combine("med", "low") == "med"
    assert sm.combine("high", "low") == "med"


def test_uncertainty_alone_never_red():
    # the key property: no path to 'high' without HIGH (or MED+high-unc) importance
    assert sm.combine("high", "low") != "high"
    assert sm.combine("high", "med") == "high"   # the one MED escalation


# ---------------------------------------------------------------------------
# standalone runner (no pytest needed)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
            passed += 1
        except AssertionError as e:
            print(f"  FAIL  {t.__name__}  {e!r}")
    print(f"\n{passed}/{len(tests)} passed")
    sys.exit(0 if passed == len(tests) else 1)
