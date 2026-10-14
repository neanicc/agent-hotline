// Bounded noise: quiet hours text instead of calling, and the hourly call limit
// holds extra calls back.
import { scriptedHuman } from "@hotline/providers";
import { equal, includes } from "../check.js";
import { BATCH_MS, MINUTE, QUIET } from "../hotline.js";
import { isKind, later, type Scenario } from "../scenario.js";

export const policyScenarios: Scenario[] = [
  {
    name: "quiet-hours-texts-instead",
    async run({ start }) {
      // Default settings: in quiet hours even an ask the agent marked urgent is texted.
      const h = await start({ config: QUIET });
      const claude = await h.mcp("claude-code", "demo-app");
      later(claude.call("ask_human", { question: "Prod is down, roll back?", urgent: true }));
      await h.waitForAsk(isKind("question"), "the urgent question");
      await h.advance(BATCH_MS);
      equal(h.voice.placed.length, 0, "calls placed in quiet hours");
      equal(h.sms.sent.length, 1, "texts sent in quiet hours");
      includes(h.sms.sent[0]?.text, "Prod is down, roll back?", "the text");

      // The owner allowed urgent calls: the urgent ask calls, the other one is still texted.
      const u = await start({ config: { quietHours: { ...QUIET.quietHours, allowUrgentCalls: true } } });
      const agent = await u.mcp("claude-code", "demo-app");
      later(agent.call("ask_human", { question: "Prod is down, roll back?", urgent: true }));
      const urgent = await u.waitForAsk(isKind("question"), "the urgent question");
      later(agent.call("ask_human", { question: "Update the changelog?" }));
      await u.waitForAsk(isKind("question", [urgent.id]), "the ordinary question");
      await u.advance(BATCH_MS);
      equal(
        u.voice.placed.map((p) => p.call.asks.map((a) => a.askId)),
        [[urgent.id]],
        "calls placed with urgent calls allowed",
      );
      equal(u.sms.sent.length, 1, "texts sent with urgent calls allowed");
      includes(u.sms.sent[0]?.text, "Update the changelog?", "the text");
    },
  },
  {
    name: "rate-limit-holds-calls",
    async run({ start }) {
      const h = await start({ config: { rateLimits: { callsPerHour: 1 } } });
      const claude = await h.mcp("claude-code", "demo-app");
      const first = later(claude.call("ask_human", { question: "Run the slow tests?" }));
      await h.waitForAsk(isKind("question"), "the first question");
      await h.advance(BATCH_MS);
      equal(h.voice.placed.length, 1, "calls placed for the first ask");
      h.voice.script(
        scriptedHuman.says({
          kind: "answer",
          ask: 1,
          decision: "text",
          text: "yes run them",
          words: "yes run them",
        }),
      );
      await h.voice.playPending();
      await h.settle();
      equal((await first).answer, "yes run them", "the first answer");
      // Two more asks in the same hour: the limit is used up, so they are texted, not called.
      const seen = h.daemon.store.listAsks().map((a) => a.id);
      later(claude.call("ask_human", { question: "Open a PR for it?" }));
      const second = await h.waitForAsk(isKind("question", seen), "the second question");
      later(claude.call("ask_human", { question: "Tag a release too?" }));
      await h.waitForAsk(isKind("question", [...seen, second.id]), "the third question");
      await h.advance(BATCH_MS);
      equal(h.voice.placed.length, 1, "calls placed in the hour");
      equal(h.sms.sent.length, 2, "texts sent instead");
      includes(h.sms.sent.map((s) => s.text).join("\n"), "Open a PR for it?", "the texts");
      includes(h.sms.sent.map((s) => s.text).join("\n"), "Tag a release too?", "the texts");
      await h.advance(10 * MINUTE);
      equal(h.voice.placed.length, 1, "calls placed ten minutes later");
    },
  },
];
