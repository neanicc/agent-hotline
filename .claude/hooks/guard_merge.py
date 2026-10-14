#!/usr/bin/env python3
"""PreToolUse hook: the only way a `gh pr merge` runs. HUMAN-OWNED.

Blocks the merge (exit 2, reason on stderr) unless all hold:
- the call comes from the main session, not a subagent (no agent_id in the input);
- the command is exactly `gh pr merge <n> --squash --delete-branch --match-head-commit <sha>`;
- scripts/agent/pr_status.py (from the main checkout) reports gate.mechanical_pass
  and its head SHA equals <sha>.

Fails closed: any error or internal timeout exits 2. settings.json also sets
onFailure "block" so a crash or hook timeout blocks the call.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys

COMMAND = re.compile(
    r"^\s*gh\s+pr\s+merge\s+(\d+)\s+--squash\s+--delete-branch\s+--match-head-commit\s+([0-9a-f]{40})\s*$"
)


def block(reason: str) -> None:
    print(f"Merge blocked by .claude/hooks/guard_merge.py: {reason}", file=sys.stderr)
    sys.exit(2)


GH_WORD = re.compile(r"(?:^|[^\w.-])gh(?![\w.-])")      # gh, /opt/homebrew/bin/gh, (gh, ;gh
MERGE_WORD = re.compile(r"(?<![\w-])merge(?![\w-])")   # merge, not mergeable / merged / git-merge-base
GH_EXPANSION = re.compile(r"(?:^|[^\w.-])gh\s+(?:\S+\s+)?[$`]")  # gh $x ..., gh pr $m ...


def looks_like_merge(command: str) -> bool:
    """Fail closed: anything that could be a `gh ... merge` counts as one.

    Quotes and backslashes are removed first, so `gh pr me''rge` and `gh "pr" merge`
    match; a path such as /opt/homebrew/bin/gh matches; and a variable or command
    substitution right after `gh` or `gh <word>` is treated as a possible merge.
    A command that mentions both gh and merge anywhere (for example
    `gh pr checkout 5 && git merge origin/main`) is also treated as a merge; run
    such steps as separate commands.
    """
    normalized = re.sub(r"[\'\"\\]", "", command)
    if not GH_WORD.search(normalized):
        return False
    return bool(MERGE_WORD.search(normalized) or GH_EXPANSION.search(normalized))


def main() -> None:
    event = json.load(sys.stdin)
    command = (event.get("tool_input") or {}).get("command") or ""
    if not looks_like_merge(command):
        sys.exit(0)
    if event.get("agent_id") or event.get("agent_type"):
        block("only the autopilot conductor in the main session may merge; subagents never merge.")
    match = COMMAND.match(command)
    if not match:
        block("this looks like a GitHub merge. Merge only with exactly "
              "`gh pr merge <n> --squash --delete-branch --match-head-commit <40-char head sha>` as a single "
              "command. If you meant `git merge`, run it as its own command without gh in it.")
    number, sha = match.groups()
    project = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    script = os.path.join(project, "scripts", "agent", "pr_status.py")
    try:
        result = subprocess.run([sys.executable, script, number], capture_output=True, text=True,
                                cwd=project, timeout=120)
    except subprocess.TimeoutExpired:
        block("pr_status.py timed out; try again shortly.")
    if result.returncode != 0:
        block(f"pr_status.py failed: {result.stderr.strip()[:500]}")
    status = json.loads(result.stdout)
    if status["head"] != sha:
        block(f"head moved: PR head is {status['head']}, command names {sha}. Re-run the gate.")
    if not status["gate"]["mechanical_pass"]:
        block("gate not passed: " + "; ".join(status["gate"]["reasons"]))
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as error:  # fail closed on anything unexpected
        block(f"hook error: {type(error).__name__}: {error}")
