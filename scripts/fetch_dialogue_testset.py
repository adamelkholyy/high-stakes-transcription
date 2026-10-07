#!/usr/bin/env python3
"""Build ~2-minute multi-speaker DIALOGUE test clips from the AMI Meeting Corpus.

AMI is real recorded meetings (spontaneous, multi-speaker, with diarisation
labels), but on Hugging Face it is stored as tiny utterance-level segments
(~0.5-3 s each). This script stitches consecutive utterances from the SAME
meeting into ~2-minute conversational clips, and writes a speaker-labelled
reference transcript for each — so you can test both transcription accuracy
(WER) and speaker diarisation on realistic dialogue.

Data source: edinburghcstr/ami (config `ihm` = individual headset mics = clean
per-speaker audio). Reconstructed audio is 16 kHz mono WAV.

Output (under --outdir):
    audio/0001_<meeting>.wav          one ~2-min stitched dialogue per file
    transcripts.tsv                   <audio> \\t <plain reference text>   (for WER)
    segments.jsonl                    one JSON line per clip with the turn list:
                                      {audio, meeting_id, duration_s, num_speakers,
                                       turns:[{speaker,start,end,text}]}
    <audio>.labeled.txt               human-readable [SPEAKER] text per turn

Examples:
    python scripts/fetch_dialogue_testset.py                 # 3 clips of ~120 s
    python scripts/fetch_dialogue_testset.py -n 5 --seconds 90
    python scripts/fetch_dialogue_testset.py --gap 0.0        # no silence between turns
"""
import argparse
import io
import json
import os
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import soundfile as sf

ROWS_API = "https://datasets-server.huggingface.co/rows"
SR = 16000


def urlread(url, timeout=120, retries=6):
    """GET with retry/backoff — the datasets-server 502s while warming up."""
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            raise
        except urllib.error.URLError:
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            raise


def fetch_rows(dataset, config, split, offset, length):
    q = urllib.parse.urlencode({"dataset": dataset, "config": config, "split": split,
                                "offset": offset, "length": length})
    return json.loads(urlread(f"{ROWS_API}?{q}", timeout=60))


def audio_src(cell):
    if isinstance(cell, list) and cell:
        return cell[0].get("src")
    if isinstance(cell, dict):
        return cell.get("src")
    return None


def fetch_audio(url):
    data = urlread(url, timeout=120)
    arr, sr = sf.read(io.BytesIO(data), dtype="float32")
    if arr.ndim > 1:
        arr = arr.mean(axis=1)  # to mono
    return arr, sr


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default="edinburghcstr/ami")
    ap.add_argument("--config", default="ihm")
    ap.add_argument("--split", default="test")
    ap.add_argument("-n", "--num", type=int, default=3, help="number of clips (default 3)")
    ap.add_argument("--seconds", type=float, default=120.0, help="target length per clip")
    ap.add_argument("--gap", type=float, default=0.15, help="silence between turns (s)")
    ap.add_argument("--offset", type=int, default=0, help="skip this many source rows first")
    ap.add_argument("--outdir", default="test_data/ami-dialogue-2min")
    args = ap.parse_args()

    # --- 1. Plan clips from row metadata (begin/end times), no audio yet ---
    clips = []            # each = list of utterance dicts
    cur, cur_meeting, cur_dur = [], None, 0.0
    offset = args.offset
    speaker_map = {}      # raw speaker_id -> SPEAKER_A, SPEAKER_B ...

    def label(sid):
        if sid not in speaker_map:
            speaker_map[sid] = "SPEAKER_" + chr(ord("A") + len(speaker_map))
        return speaker_map[sid]

    while len(clips) < args.num:
        rows = fetch_rows(args.dataset, args.config, args.split, offset, 100).get("rows", [])
        if not rows:
            break
        for it in rows:
            row = it["row"]
            text = (row.get("text") or "").strip()
            src = audio_src(row.get("audio"))
            if not text or not src:
                continue
            mid = row.get("meeting_id")
            dur = float(row.get("end_time", 0)) - float(row.get("begin_time", 0))
            new_meeting = cur_meeting is not None and mid != cur_meeting
            if cur and (new_meeting or cur_dur >= args.seconds):
                clips.append(cur)
                cur, cur_dur = [], 0.0
                speaker_map = {}
                if len(clips) >= args.num:
                    break
            cur_meeting = mid
            cur.append({"src": src, "text": text, "meeting_id": mid,
                        "speaker": label(row.get("speaker_id")), "planned_dur": dur})
            cur_dur += dur + args.gap
        offset += len(rows)
    if cur and len(clips) < args.num:
        clips.append(cur)
    clips = clips[:args.num]

    # --- 2. Download all needed audio in parallel ---
    all_utts = [u for clip in clips for u in clip]
    print(f"Planned {len(clips)} clips, {len(all_utts)} utterances. Downloading audio...")
    with ThreadPoolExecutor(max_workers=8) as ex:
        for u, (arr, sr) in zip(all_utts, ex.map(lambda u: fetch_audio(u["src"]), all_utts)):
            u["arr"], u["sr"] = arr, sr

    # --- 3. Assemble each clip, write audio + references ---
    audio_dir = os.path.join(args.outdir, "audio")
    os.makedirs(audio_dir, exist_ok=True)
    gap_samples = np.zeros(int(args.gap * SR), dtype="float32")
    tsv = open(os.path.join(args.outdir, "transcripts.tsv"), "w", encoding="utf-8")
    tsv.write("audio\treference_text\n")
    seg = open(os.path.join(args.outdir, "segments.jsonl"), "w", encoding="utf-8")

    for i, clip in enumerate(clips, 1):
        chunks, turns, t = [], [], 0.0
        for u in clip:
            arr = u["arr"]
            if u["sr"] != SR:  # AMI is 16 kHz; guard anyway
                continue
            start = t
            chunks.append(arr)
            t += len(arr) / SR
            turns.append({"speaker": u["speaker"], "start": round(start, 2),
                          "end": round(t, 2), "text": u["text"]})
            chunks.append(gap_samples)
            t += len(gap_samples) / SR
        wave = np.concatenate(chunks) if chunks else np.zeros(1, dtype="float32")
        meeting = clip[0]["meeting_id"]
        base = f"{i:04d}_{meeting}"
        wav_path = os.path.join(audio_dir, base + ".wav")
        sf.write(wav_path, wave, SR)

        plain = " ".join(x["text"] for x in turns)
        n_spk = len({x["speaker"] for x in turns})
        tsv.write(f"{base}.wav\t{plain}\n")
        seg.write(json.dumps({"audio": base + ".wav", "meeting_id": meeting,
                              "duration_s": round(len(wave) / SR, 1),
                              "num_speakers": n_spk, "turns": turns},
                             ensure_ascii=False) + "\n")
        with open(os.path.join(audio_dir, base + ".wav.labeled.txt"), "w", encoding="utf-8") as f:
            for x in turns:
                f.write(f"[{x['speaker']}] {x['text']}\n")
        print(f"[{i}/{len(clips)}] {base}.wav  {len(wave)/SR:5.1f}s  "
              f"{n_spk} speakers  {len(turns)} turns")

    tsv.close()
    seg.close()
    print(f"\nDone. Clips in {audio_dir}")
    print(f"Plain refs (WER): {os.path.join(args.outdir, 'transcripts.tsv')}")
    print(f"Speaker turns (diarisation): {os.path.join(args.outdir, 'segments.jsonl')}")


if __name__ == "__main__":
    main()
