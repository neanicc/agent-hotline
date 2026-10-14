// Away mode's Stop hooks: the owner's instruction continues the agent, in each
// agent's documented output, and the loop guards stop runaway continuations.
import { type HumanScript, scriptedHuman } from "@hotline/providers";
import { equal, includes } from "../check.js";
import type { Hotline } from "../hotline.js";
import { BATCH_MS } from "../hotline.js";
import { claudeStop, codexStop, stopOutput } from "../payloads.js";
import { isKind, later, type Scenario } from "../scenario.js";

const says = (instruction: string): HumanScript =>
  scriptedHuman.says({ kind: "answer", ask: 1, decision: "text", text: instruction, words: instruction });

/** One Stop hook run the owner answers on a call; returns the hook's output. */
async function stopAnswered(
  h: Hotline,
  agent: "claude-code" | "codex",
  payload: Record<string, unknown>,
  script: HumanScript,
) {
  const seen = h.daemon.store.listAsks().map((a) => a.id);
  const hook = later(h.hook(agent, "stop", payload));
  const stop = await h.waitForAsk(isKind("stop", seen), "the stop ask");
  await h.advance(BATCH_MS);
  h.voice.script(script);
  await h.voice.playPending();
  await h.settle();
  return { stop, output: stopOutput(await hook) };
}

export const stopScenarios: Scenario[] = [
  {
    name: "away-mode-continues-claude",
    async run({ start }) {
      const h = await start();
      await h.away(true);
      const { stop, output } = await stopAnswered(
        h,
        "claude-code",
        claudeStop(false, "I've finished the refactoring."),
        says("now write the tests"),
      );
      includes(stop.text, "finished the refactoring", "the stop ask's summary");
      equal(output, { decision: "block", reason: "now write the tests" }, "Claude Code Stop hook output");
    },
  },
  {
    name: "away-mode-continues-codex",
    async run({ start }) {
      const h = await start();
      await h.away(true);
      const { stop, output } = await stopAnswered(
        h,
        "codex",
        codexStop(false, "The Windows build is fixed."),
        says("now write the tests"),
      );
      includes(stop.text, "Windows build is fixed", "the stop ask's summary");
      equal(output, { decision: "block", reason: "now write the tests" }, "Codex Stop hook output");
    },
  },
  {
    name: "stop-loop-capped",
    async run({ start }) {
      const h = await start({ config: { policy: { maxConsecutiveContinuations: 2 } } });
      await h.away(true);
      // stop_hook_active with no continuation of Hotline's own (another Stop hook's): left alone.
      equal(
        stopOutput(await h.hook("claude-code", "stop", claudeStop(true))),
        undefined,
        "foreign continuation",
      );
      equal(h.daemon.store.listAsks().length, 0, "asks after a foreign continuation");

      // Hotline's own continuations, up to the cap of two in a row.
      for (const [index, instruction] of ["now write the tests", "now update the docs"].entries()) {
        const { output } = await stopAnswered(h, "claude-code", claudeStop(index > 0), says(instruction));
        equal(output, { decision: "block", reason: instruction }, `continuation ${index + 1}`);
      }
      // The third in a row stops the agent, and a notification tells the owner.
      equal(stopOutput(await h.hook("claude-code", "stop", claudeStop(true))), undefined, "at the cap");
      equal(h.daemon.store.listAsks().filter(isKind("stop")).length, 2, "stop asks at the cap");
      const note = await h.waitForAsk(isKind("notify"), "the cap notification");
      includes(note.text, "Stopped after 2 away-mode continuations in a row", "the notification");
      await h.advance(BATCH_MS);
      includes(h.sms.sent.at(-1)?.text, "Stopped after 2", "the text about the cap");
      equal(h.voice.placed.length, 2, "calls placed");

      // A turn the human started counts afresh; "that's it" lets the agent stop.
      const fresh = await stopAnswered(
        h,
        "claude-code",
        claudeStop(false),
        scriptedHuman.says({ kind: "answer", ask: 1, decision: "done", words: "that's it" }),
      );
      equal(fresh.output, undefined, "after the owner's that's it");
    },
  },
];
