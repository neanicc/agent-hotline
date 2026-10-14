# Agent development log

Each PR that makes a substantive decision, design change or measurement appends
one entry at the end of this file in the same PR. Keep entries short and factual.
Earlier entries are history, not current instructions.

Template:

```
## YYYY-MM-DD — HL-xx <title> (#PR)
- Decision / change:
- Evidence: commands run and results (automated / scenarios / real agent / live call)
- Open issues or follow-ups:
```

## 2026-10-13 — Scaffold

- Decision / change: repository created with agent workflows (adapted from the
  Trail/teachAR delivery skills, hardened during the Stream Privacy Guard setup),
  plan, lanes, scenario definitions, human-owned thresholds, CI structure (`check`
  aggregate, protected-path guard, actionlint, Ubuntu and macOS build/test,
  scenario suite through `scripts/ci/run.sh`), Claude staff review on PRs and
  Greptile configuration. License: MIT.
- Evidence: `python3 scripts/check_agent_files.py` and actionlint passed on the
  scaffold. No product code exists yet.
- Open issues: plan section 12 open questions.
