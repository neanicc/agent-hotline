#!/usr/bin/env bash
# The single entry point CI calls (.github/workflows/check.yml). Owned by lane:build.
#
#   scripts/ci/run.sh setup            install pinned dependencies (pnpm, frozen lockfile)
#   scripts/ci/run.sh build            lint (Biome), build and typecheck every package and its
#                                      tests, then smoke-run the built hotline CLI
#   scripts/ci/run.sh test             unit and integration tests
#   scripts/ci/run.sh package          build the distributable CLI into dist/ (CI uploads it)
#   scripts/ci/run.sh eval [--local]   setup + build, then run the scenario suite and score it
#                                      against eval/thresholds.toml
#
# A stage whose inputs do not exist yet reports that and succeeds: `package`
# until HL-15 adds the package script, `eval` (CI mode) until HL-12 adds the
# scenario suite. Once a stage's inputs exist, it must do its real work. Never
# make a stage succeed without exercising what it claims to check. CI has no
# real phone, Twilio or ElevenLabs credentials: everything runs against fakes.
set -euo pipefail

stage="${1:-}"
shift || true

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

has_workspace() { [[ -f package.json ]]; }
has_script() { node -e "process.exit(require('./package.json').scripts?.[process.argv[1]] ? 0 : 1)" "$1" 2>/dev/null; }

case "$stage" in
  setup)
    if ! has_workspace; then
      echo "::notice::setup: no package.json yet (HL-01 not landed)."
      exit 0
    fi
    if ! command -v corepack >/dev/null 2>&1; then
      echo "::error::corepack not found. Node 25 and later no longer bundle it: run 'npm install -g corepack'." >&2
      exit 1
    fi
    want_node="$(tr -d '[:space:]' < .node-version)"
    have_node="$(node --version)"
    if [[ "${have_node#v}" != "$want_node" && "${have_node#v}" != "$want_node".* ]]; then
      echo "::warning::Node $have_node does not match .node-version ($want_node); CI uses .node-version."
    fi
    corepack enable
    pnpm install --frozen-lockfile
    ;;

  build)
    if ! has_workspace; then
      echo "::notice::build: no package.json yet (HL-01 not landed)."
      exit 0
    fi
    pnpm run lint
    pnpm run build
    pnpm run typecheck
    # The built CLI must start and resolve its workspace dependencies under plain Node.
    node apps/cli/dist/main.js --version
    ;;

  test)
    if ! has_workspace; then
      echo "::notice::test: no package.json yet (HL-01 not landed)."
      exit 0
    fi
    pnpm run test
    ;;

  package)
    if ! has_workspace || ! has_script package; then
      echo "::notice::package: no package script yet (HL-15)."
      exit 0
    fi
    pnpm run package
    ;;

  eval)
    mode=ci
    if [[ "${1:-}" == "--local" ]]; then mode=local; fi
    if ! has_workspace || ! has_script eval; then
      echo "THRESHOLDS: NOT RUN (scenario suite not implemented yet; HL-12)"
      # CI stays green before the suite exists; local acceptance must not pass.
      [[ "$mode" == ci ]] && exit 0
      exit 1
    fi
    # Always score a fresh build of the current tree, never a stale one.
    bash "$root/scripts/ci/run.sh" setup
    bash "$root/scripts/ci/run.sh" build
    pnpm run eval -- --mode "$mode" --thresholds eval/thresholds.toml --out eval-out
    ;;

  *)
    echo "usage: $0 {setup|build|test|package|eval [--local]}" >&2
    exit 2
    ;;
esac
