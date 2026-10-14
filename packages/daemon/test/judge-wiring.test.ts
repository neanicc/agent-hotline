// HL-09d: the running daemon uses the selected reply judge. End to end through
// `runDaemon`, call orchestration and the fake voice provider, with the
// Claude Code backend on a fake agent CLI (`FakeJudgeHost`): no real claude.
import { type Ask, permissionVerdict } from "@hotline/core";
import { scriptedHuman } from "@hotline/providers";
import { afterEach, describe, expect, it } from "vitest";
import type { JudgeOutput } from "../src/index.js";
import { FakeJudgeHost } from "./fake-judge.js";
import { answerOf, type Hotline, type HotlineOptions, startHotline } from "./hotline-harness.js";

const BATCH_MS = 20_000;

let hotline: Hotline | undefined;
afterEach(async () => {
  await hotline?.stop();
  hotline = undefined;
});

const verdicts: Record<string, JudgeOutput> = {
  "yeah let's ship that one": { verdict: "agreed", conditional: false, retracted: false },
  "yes if the tests pass": { verdict: "agreed", conditional: false, retracted: false },
  "nah, leave it": { verdict: "declined", conditional: false, retracted: false },
};

/** The Claude Code backend on a fake CLI whose model answers from `verdicts`, else unclear. */
const scriptedModel = () =>
  new FakeJudgeHost(
    { claude: "/fake/bin/claude" },
    (reply) => verdicts[reply.join(" ")] ?? { verdict: "unclear", conditional: false, retracted: false },
  );

/** The owner chose the judge (`hotline init` records `judge.backend`). */
const CHOSEN = { judge: { backend: "auto" } };

async function replyToReadBack(
  said: string,
  judgeHost?: FakeJudgeHost,
  options: Omit<HotlineOptions, "judgeHost"> = { config: CHOSEN },
) {
  hotline = await startHotline(judgeHost === undefined ? options : { ...options, judgeHost });
  const h = hotline;
  const session = await h.registerSession();
  const request: Ask = h.addAsk(session, {
    kind: "permission",
    toolName: "Bash",
    text: "pnpm test",
    risk: "low",
  });
  await h.advance(BATCH_MS);
  h.voice.script(scriptedHuman.confirms(1, "sure", said));
  await h.voice.playPending();
  await h.settle();
  const result = await h.outcome(request.id);
  return {
    h,
    request,
    result,
    verdict: result.outcome === undefined ? "waiting" : permissionVerdict(request, result.outcome),
  };
}

describe("the reply judge in the running daemon (HL-09d)", () => {
  it("approves a natural yes the fast path cannot decide, judged on the owner's words only", async () => {
    const host = scriptedModel();
    const { h, result, verdict } = await replyToReadBack("yeah let's ship that one", host);
    expect(verdict).toBe("allow");
    expect(answerOf(result)).toMatchObject({ channel: "voice", ownerExcerpt: "yeah let's ship that one" });
    expect(host.runs.map((run) => run.reply)).toEqual([["yeah let's ship that one"]]);
    expect(host.runs[0]?.options.input).not.toContain("pnpm test");
    expect(h.sms.sent).toHaveLength(0);
  });

  it("does not approve a conditional yes even when the model agrees: the ask is texted", async () => {
    const host = scriptedModel();
    const { h, verdict } = await replyToReadBack("yes if the tests pass", host);
    expect(verdict).toBe("waiting");
    expect(host.runs).toHaveLength(1);
    expect(h.sms.sent).toHaveLength(1);
  });

  it("ends the request as no answer when the judge hears a no", async () => {
    const host = scriptedModel();
    const { h, result, verdict } = await replyToReadBack("nah, leave it", host);
    expect(result.outcome).toMatchObject({ outcome: "no-answer" });
    expect(verdict).toBe("deny");
    expect(h.sms.sent).toHaveLength(0);
  });

  it("texts the same reply when no judge is available", async () => {
    const { h, verdict } = await replyToReadBack("yeah let's ship that one");
    expect(verdict).toBe("waiting");
    expect(h.sms.sent).toHaveLength(1);
  });

  it("sends the owner's words nowhere until a judge was chosen, even with claude on the PATH", async () => {
    const host = scriptedModel();
    const { h, verdict } = await replyToReadBack("yeah let's ship that one", host, {});
    expect(verdict).toBe("waiting");
    expect(host.found).toEqual([]);
    expect(host.runs).toEqual([]);
    expect(h.sms.sent).toHaveLength(1);
    const started = h.daemon.store.listAudit().find((entry) => entry.event === "daemon.started");
    expect(started?.detail).toMatchObject({ judge: "none" });
  });

  it("judges only after the call has ended: no tool call during the call waits for it", async () => {
    const host = scriptedModel();
    const runsDuringToolCalls: number[] = [];
    let runsBeforePostCall: number | undefined;
    const { verdict } = await replyToReadBack("yeah let's ship that one", host, {
      config: CHOSEN,
      voiceClient: (real) => ({
        tool: async (name, body) => {
          const answer = await real.tool(name, body);
          runsDuringToolCalls.push(host.runs.length);
          return answer;
        },
        postCall: async (payload) => {
          runsBeforePostCall = host.runs.length;
          await real.postCall(payload);
        },
      }),
    });
    expect(verdict).toBe("allow");
    // The live call's submit_answer returned before the judge was ever asked;
    // the judge ran for the post-call webhook, once the owner had hung up.
    expect(runsDuringToolCalls.length).toBeGreaterThan(0);
    expect(runsDuringToolCalls.every((runs) => runs === 0)).toBe(true);
    expect(runsBeforePostCall).toBe(0);
    expect(host.runs).toHaveLength(1);
  });
});
