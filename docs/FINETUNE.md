# Making Laya better at *your* decisions

Base Laya checkpoints are near chance zero-shot on typed decisions (0.36 vs 0.318 random); a fine-tune on your own data reaches ~0.77 in Laya's own benchmark. This plugin collects exactly the data needed.

## What gets logged
`~/.laya/decisions.jsonl` — one line per decision (`laya.decision/1`, see `templates/decision.schema.json`) plus one `{type:"outcome"}` line per turn from the Stop hook: which picks were **used**, **ignored**, or **failed**. Prompts are redacted and truncated to 500 chars; set `log_prompts: false` in `~/.laya/state.json` to log hashes only.

## Export
```bash
laya-conductor export-train            # → ~/.laya/train.jsonl, rows {state, questions, gold}
```
Gold is a *weak* label: a pick that was used and did not fail gets ~0.9, otherwise `none`. Skim the file, delete rows you disagree with, add hand-labelled ones.

## Train (Apple Silicon, ~hours for real data)
```bash
git clone https://github.com/NandhaKishorM/laya && cd laya
python notebooks/laya_finetune_typed_decisions_mps.py --items ~/.laya/train.jsonl --epochs 4
```
Calibration is part of that script (temperatures per question type) — do not skip it, the daemon gates on confidence.

## Use it
Point the daemon at the result: `LAYA_MODEL=<name>` / a local checkpoint dir per Laya's docs, then `laya-conductor daemon-stop` (it restarts on the next prompt). Gate regressions with `laya eval` and `evals/golden.json` (`node tests/selfcheck.js`).
