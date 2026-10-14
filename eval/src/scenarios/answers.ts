// The owner answers: questions by voice and by text, permission requests by
// voice (the HL-14c/HL-09c read-back before every allow, the PIN for high risk),
// and two agents' asks on one call.
import { scriptedHuman } from "@hotline/providers";
import { check, equal, includes } from "../check.js";
import { ASK_TIMEOUT_MS, BATCH_MS, PIN, QUIET } from "../hotline.js";
import { claudeBash, expectAllow, expectDeny } from "../payloads.js";
import { answer, isKind, later, type Scenario } from "../scenario.js";

export const answerScenarios: Scenario[] = [
  {
    name: "question-answered-by-voice",
    async run({ start }) {
      const h = await start();
      const claude = await h.mcp("claude-code", "demo-app");
      const asking = later(
        claude.call("ask_human", {
          question: "The Windows build broke on the ONNX download. Pin the older version or skip Windows?",
          options: ["Pin the older version", "Skip Windows"],
        }),
      );
      const ask = await h.waitForAsk(isKind("question"), "the question");
      await h.advance(BATCH_MS);
      equal(
        h.voice.placed.map((p) => p.call.asks.map((a) => a.askId)),
        [[ask.id]],
        "calls placed after the batch window",
      );
      h.voice.script(
        scriptedHuman.says({
          kind: "answer",
          ask: 1,
          decision: "option",
          option: 2,
          words: "the second one, skip Windows",
        }),
      );
      await h.voice.playPending();
      await h.settle();
      const result = await asking;
      equal(result.outcome, "answered", "ask_human outcome");
      equal(result.choice, { option: 2, text: "Skip Windows" }, "ask_human choice");
      equal(result.channel, "voice", "answer channel");
      // The transcript excerpt: the owner's own turn, verbatim.
      equal(result.ownerWords, "the second one, skip Windows", "ask_human ownerWords");
      equal(answer(h, ask)?.ownerExcerpt, "the second one, skip Windows", "stored excerpt");
      equal(h.sms.sent.length, 0, "texts sent");
    },
  },
  {
    name: "question-answered-by-text",
    async run({ start }) {
      // Quiet hours: the question goes out by text, and the owner replies "2".
      const h = await start({ config: QUIET });
      const codex = await h.mcp("codex", "api");
      const asking = later(
        codex.call("ask_human", {
          question: "Pin the older ONNX runtime or skip the Windows build?",
          options: ["Pin ONNX", "Skip Windows"],
        }),
      );
      const ask = await h.waitForAsk(isKind("question"), "the question");
      await h.advance(BATCH_MS);
      equal(h.voice.placed.length, 0, "calls placed");
      equal(h.sms.sent.length, 1, "texts sent");
      includes(h.sms.sent[0]?.text, "2) Skip Windows", "the text");
      equal(await h.text("2"), "Hotline: got it.", "reply to the owner's text");
      const result = await asking;
      equal(result.outcome, "answered", "ask_human outcome");
      equal(result.choice, { option: 2, text: "Skip Windows" }, "ask_human choice");
      equal(result.channel, "sms", "answer channel");
      equal(result.ownerWords, "2", "ask_human ownerWords");
      equal(answer(h, ask)?.channel, "sms", "stored answer channel");
    },
  },
  {
    name: "permission-approved",
    async run({ start }) {
      const h = await start();
      await h.away(true);
      const hook = later(h.hook("claude-code", "permission", claudeBash("pnpm test", "Run the test suite")));
      const ask = await h.waitForAsk(isKind("permission"), "the permission request");
      equal([ask.toolName, ask.risk], ["Bash", "low"], "tool and risk");
      await h.advance(BATCH_MS);
      equal(h.voice.placed.length, 1, "calls placed");
      // Definition v4: "yes", the read-back ("Allow Bash to ... ? Yes?"), and the owner's yes to it.
      h.voice.script(scriptedHuman.confirms(1, "yeah, go for it", "yes"));
      await h.voice.playPending();
      await h.settle();
      expectAllow(await hook, "after the owner confirmed the read-back");
      const stored = answer(h, ask);
      equal(stored?.decision, { type: "allow" }, "stored decision");
      equal([stored?.channel, stored?.ownerExcerpt], ["voice", "yes"], "stored channel and excerpt");
      equal(h.sms.sent.length, 0, "texts sent");
    },
  },
  {
    name: "permission-denied",
    async run({ start }) {
      const h = await start();
      await h.away(true);
      const hook = later(h.hook("claude-code", "permission", claudeBash("pnpm test", "Run the test suite")));
      const ask = await h.waitForAsk(isKind("permission"), "the permission request");
      await h.advance(BATCH_MS);
      h.voice.script(
        scriptedHuman.says({ kind: "answer", ask: 1, decision: "deny", words: "no, don't run that" }),
      );
      await h.voice.playPending();
      await h.settle();
      const message = expectDeny(await hook, "after the owner said no");
      includes(message, "The owner denied this by phone", "deny message");
      includes(message, "no, don't run that", "deny message carries the owner's words");
      equal(answer(h, ask)?.decision, { type: "deny" }, "stored decision");
    },
  },
  {
    name: "high-risk-needs-pin",
    async run({ start }) {
      const h = await start();
      await h.away(true);
      // A yes, read back and confirmed, but no PIN: never an approval.
      const first = later(h.hook("claude-code", "permission", claudeBash("git push origin main")));
      const push = await h.waitForAsk(isKind("permission"), "the push request");
      equal(push.risk, "high", "risk of git push");
      await h.advance(BATCH_MS);
      h.voice.script(
        scriptedHuman.says({
          kind: "read-back",
          ask: 1,
          words: "yes, push it",
          reply: "yes",
          decision: "allow",
        }),
      );
      const [unpinned] = await h.voice.playPending();
      await h.settle();
      equal(
        unpinned?.tools.map((t) => t.response.result),
        ["needs-pin"],
        "submit_answer without the PIN",
      );
      check(answer(h, push) === undefined, "an answer was stored for a high-risk yes without the PIN");
      // Left open, it is texted with a code; a bare "yes" without the code approves nothing either.
      includes(h.sms.sent[0]?.text, "HIGH RISK. Reply YES", "the text about the push");
      equal(
        await h.text("yes"),
        "Hotline: not recorded. Reply YES with the code from the text, or NO.",
        "reply to a bare yes",
      );
      await h.advance(ASK_TIMEOUT_MS);
      expectDeny(await first, "a high-risk yes without the PIN");
      check(answer(h, push) === undefined, "an answer was stored for the unpinned push");

      // The same request again, approved with the PIN and the read-back.
      const second = later(h.hook("claude-code", "permission", claudeBash("git push origin main")));
      const again = await h.waitForAsk(isKind("permission", [push.id]), "the second push request");
      await h.advance(BATCH_MS);
      equal(h.voice.placed.length, 2, "calls placed");
      h.voice.script(
        scriptedHuman.says(
          { kind: "pin", digits: PIN },
          { kind: "read-back", ask: 1, words: "yes, push it", reply: "yes", decision: "allow" },
        ),
      );
      const [pinned] = await h.voice.playPending();
      await h.settle();
      equal(
        pinned?.tools.map((t) => t.response.verified ?? t.response.result),
        [true, "recorded"],
        "verify_pin, then submit_answer",
      );
      expectAllow(await second, "a high-risk yes with the PIN");
      equal(answer(h, again)?.confirmation, "pin", "stored confirmation");
    },
  },
  {
    name: "two-agents-one-call",
    async run({ start }) {
      const h = await start();
      await h.away(true);
      const codex = await h.mcp("codex", "api");
      // Claude Code's permission hook and Codex's ask_human, within one batch window.
      const hook = later(h.hook("claude-code", "permission", claudeBash("pnpm test")));
      const permission = await h.waitForAsk(isKind("permission"), "Claude Code's permission request");
      const asking = later(
        codex.call("ask_human", {
          question: "Use Postgres or SQLite for the cache?",
          options: ["Postgres", "SQLite"],
        }),
      );
      const question = await h.waitForAsk(isKind("question"), "Codex's question");
      await h.advance(BATCH_MS);
      // One call covers both, the permission request first.
      equal(
        h.voice.placed.map((p) => p.call.asks.map((a) => a.askId)),
        [[permission.id, question.id]],
        "calls placed",
      );
      includes(h.voice.placed[0]?.variables.opening, "A few of your agents", "the call's opening");
      h.voice.script(
        scriptedHuman.says(
          { kind: "read-back", ask: 1, words: "sure", reply: "yes", decision: "allow" },
          { kind: "answer", ask: 2, decision: "option", option: 2, words: "the second one, SQLite" },
        ),
      );
      await h.voice.playPending();
      await h.settle();
      expectAllow(await hook, "Claude Code's request");
      const result = await asking;
      equal(result.outcome, "answered", "Codex's ask_human outcome");
      equal(result.choice, { option: 2, text: "SQLite" }, "Codex's choice");
      equal(answer(h, permission)?.ownerExcerpt, "yes", "Claude Code's answer excerpt");
      equal(answer(h, question)?.ownerExcerpt, "the second one, SQLite", "Codex's answer excerpt");
      equal(h.voice.placed.length, 1, "calls placed in all");
    },
  },
];
