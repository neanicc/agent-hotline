# Live call check

Fakes cannot prove a real phone call works. This is the human acceptance record.
Never fabricate an entry; "not tested" is a valid result.

## Setup (once)

- Twilio account (upgraded from trial), a Canadian number, Account SID and auth
  token. ElevenLabs Starter plan (voice cloning), API key.
- ngrok with your free static domain (`ngrok http --url=<your-domain> 7777`) or a
  Cloudflare named tunnel.
- `hotline init` (owner number, PIN, quiet hours, voice), then `hotline doctor`
  until everything is green. `hotline voice set <voice id>` to pick a voice, or
  clone yours in ElevenLabs first.
- `hotline install claude` and `hotline install codex`, `hotline daemon`.

## Scenarios

- `hotline test-call`: phone rings, the voice says it's a test, hang up.
- Persona ([voice.md](voice.md)): the call uses your chosen voice, names the
  session ("Claude in <folder>"), reads options as numbers, repeats your
  decision back and sums up before hanging up. With two or more asks, it reads
  each one on its own turn in the ask's own words and waits for your answer
  before the next; your answers count (no `voice.answer-unconfirmed` in the
  daemon log for answers you gave clearly).
- Conversational approval (definition v4): say "yeah, go for it" to a
  permission request; it reads the request back in one short sentence and asks
  for a yes; say "yes" and the agent runs it. Say "nope" to another: it is
  denied at once with no read-back. Mumble twice to a third: it asks "is that a
  yes or a no?", then says it will text you, and the text arrives when the call
  ends. Check the daemon log has no `voice.answer-unconfirmed` for the
  confirmed yes.
- Claude Code: ask it to "use ask_human to ask me which color to use, then
  continue". Answer by voice; check the session continues with your answer.
- Codex: `hotline away on`, give it a task that needs a command approval. Approve
  one by voice, deny another. Check the decisions in the session.
- High risk: a `git push` approval without the PIN is denied; with the PIN it runs.
- Don't pick up: the text arrives; reply `1`; the agent continues.
- Away mode: let an agent finish; say "now add tests"; it keeps working.
- Two agents at once: one call covers both.
- Call the number yourself: PIN, hear status, give an instruction, see it delivered.
- Call from another phone: rejected, nothing disclosed.
- Quiet hours: an ask texts instead of calling.

## Record

Append: date, commit, Claude Code and Codex versions, provider plans, scenarios
run, what happened, latency feel, cost shown in the Twilio and ElevenLabs
dashboards, and remaining issues.

## Results

_No live runs recorded yet._
