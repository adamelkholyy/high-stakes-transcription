#!/usr/bin/env python3
"""Download an English ASR test set (audio + reference transcript) from Hugging Face.

Uses the Hugging Face datasets-server /rows API, so it only downloads the
individual short clips you ask for — NOT the whole ~350 MB split.

Default = LibriSpeech test-clean: the standard English ASR benchmark
(clean read speech, one speaker per clip, ~2620 utterances available).

Output layout (under --outdir):
    audio/0001_<id>.flac ...   one audio file per clip
    transcripts.tsv            <audio_filename> \\t <reference_text>   (has header row)
    metadata.jsonl             full metadata per clip

Workflow: feed audio/*.flac to your pipeline, then line up your pipeline's
output against the reference_text column to see how accurate it is
(e.g. word error rate with `jiwer`).

Examples:
    python scripts/fetch_asr_testset.py                 # 20 LibriSpeech test-clean clips
    python scripts/fetch_asr_testset.py -n 200          # a bigger sample
    python scripts/fetch_asr_testset.py --config other  # test-other (harder / noisier)
    python scripts/fetch_asr_testset.py --format mp3     # transcode to mp3 via ffmpeg
    # A different HF ASR dataset (columns may differ — set --text-col / --id-col):
    python scripts/fetch_asr_testset.py --dataset mozilla-foundation/common_voice_17_0 \\
        --config en --split test --text-col sentence
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request

ROWS_API = "https://datasets-server.huggingface.co/rows"


def fetch_rows(dataset, config, split, offset, length):
    q = urllib.parse.urlencode(
        {"dataset": dataset, "config": config, "split": split,
         "offset": offset, "length": length}
    )
    with urllib.request.urlopen(f"{ROWS_API}?{q}", timeout=60) as r:
        return json.load(r)


def download(url, path):
    with urllib.request.urlopen(url, timeout=180) as r, open(path, "wb") as f:
        f.write(r.read())


def audio_src(cell):
    if isinstance(cell, list) and cell:
        return cell[0].get("src")
    if isinstance(cell, dict):
        return cell.get("src")
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default="openslr/librispeech_asr")
    ap.add_argument("--config", default="clean", help="clean = test-clean, other = test-other")
    ap.add_argument("--split", default="test")
    ap.add_argument("-n", "--num", type=int, default=20, help="number of clips (default 20)")
    ap.add_argument("--offset", type=int, default=0, help="skip this many rows first")
    ap.add_argument("--outdir", default="test_data/librispeech-test-clean")
    ap.add_argument("--text-col", default="text", help="column holding the reference transcript")
    ap.add_argument("--id-col", default="id", help="column used to name files")
    ap.add_argument("--format", choices=["original", "mp3", "wav"], default="original",
                    help="keep original (flac) or transcode with ffmpeg")
    args = ap.parse_args()

    audio_dir = os.path.join(args.outdir, "audio")
    os.makedirs(audio_dir, exist_ok=True)
    tsv_path = os.path.join(args.outdir, "transcripts.tsv")
    meta_path = os.path.join(args.outdir, "metadata.jsonl")

    got = 0
    offset = args.offset
    with open(tsv_path, "w", encoding="utf-8") as tsv, \
         open(meta_path, "w", encoding="utf-8") as meta:
        tsv.write("audio\treference_text\n")
        while got < args.num:
            length = min(100, args.num - got)  # /rows caps length at 100
            rows = fetch_rows(args.dataset, args.config, args.split, offset, length).get("rows", [])
            if not rows:
                print(f"No more rows at offset {offset}; stopping early.", file=sys.stderr)
                break
            for item in rows:
                row = item["row"]
                src = audio_src(row.get("audio"))
                text = (row.get(args.text_col) or "").strip()
                if not src:
                    continue
                ext = os.path.splitext(urllib.parse.urlparse(src).path)[1] or ".flac"
                uid = str(row.get(args.id_col) or item.get("row_idx") or offset)
                base = f"{got + 1:04d}_{uid}"
                orig = os.path.join(audio_dir, base + ext)
                download(src, orig)

                final = orig
                if args.format != "original":
                    final = os.path.join(audio_dir, base + "." + args.format)
                    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", orig, final],
                                   check=True)
                    os.remove(orig)

                fname = os.path.basename(final)
                tsv.write(f"{fname}\t{text}\n")
                tsv.flush()
                meta.write(json.dumps({"audio": fname, "text": text,
                                       "id": row.get("id"),
                                       "speaker_id": row.get("speaker_id"),
                                       "chapter_id": row.get("chapter_id")},
                                      ensure_ascii=False) + "\n")
                got += 1
                print(f"[{got}/{args.num}] {fname}  <-  {text[:60]}")
                if got >= args.num:
                    break
            offset += len(rows)

    print(f"\nDone. {got} clips saved in {audio_dir}")
    print(f"Reference transcripts: {tsv_path}")


if __name__ == "__main__":
    main()
