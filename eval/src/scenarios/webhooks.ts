// Every webhook is verified, and each verified one acts once: requests with a
// bad signature or secret get a bare 403 and change nothing; a valid webhook
// sent again is ignored.
import { POST_CALL_PATH, scriptedHuman, toolPath } from "@hotline/providers";
import { check, equal } from "../check.js";
import { BATCH_MS, HOTLINE_NUMBER, OWNER, QUIET, READING_MS } from "../hotline.js";
import { claudeBash, expectDeny } from "../payloads.js";
import { auditCount, isKind, later, type Scenario } from "../scenario.js";

const FORM = "application/x-www-form-urlencoded";

export const webhookScenarios: Scenario[] = [
  {
    name: "unsigned-webhook-rejected",
    async run({ start }) {
      const h = await start({ config: QUIET });
      const codex = await h.mcp("codex", "api");
      const asking = later(
        codex.call("ask_human", { question: "Which region?", options: ["us-east", "eu-west"] }),
      );
      const question = await h.waitForAsk(isKind("question"), "the question");
      await h.advance(BATCH_MS);
      equal(h.sms.sent.length, 1, "texts sent");
      h.clock.now = new Date(h.clock.now.getTime() + READING_MS);
      const auditBefore = h.daemon.store.listAudit().length;
      const status = () => h.daemon.store.getAsk(question.id)?.status;
      const statusBefore = status();

      const rejected: [string, Promise<{ status: number; body: string }>][] = [];
      const reply = h.smsRequest("2");
      rejected.push([
        "a Twilio text with a forged signature",
        h.hooks(
          "/hooks/twilio/sms",
          { "content-type": FORM, "x-twilio-signature": "Zm9yZ2VkLXNpZ25hdHVyZQ==" },
          reply.form,
        ),
      ]);
      rejected.push([
        "a Twilio text with no signature",
        h.hooks("/hooks/twilio/sms", { "content-type": FORM }, reply.form),
      ]);
      // Signed for "1", then changed to "2".
      const signed = h.smsRequest("1");
      rejected.push([
        "a Twilio text changed after signing",
        h.hooks(
          "/hooks/twilio/sms",
          { "content-type": FORM, "x-twilio-signature": signed.signature },
          signed.form.replace("Body=1", "Body=2"),
        ),
      ]);
      const toolBody = JSON.stringify({
        conversation_id: "conv_forged_1",
        call_sid: `CA${"0".repeat(32)}`,
        caller_id: HOTLINE_NUMBER,
        called_number: OWNER,
        ask_number: 1,
        decision: "option",
        option: 2,
        owner_words: "two",
      });
      rejected.push([
        "an ElevenLabs tool call with the wrong secret",
        h.hooks(
          `/hooks${toolPath("submit_answer")}`,
          { "content-type": "application/json", "x-hotline-tool-secret": "not-the-tool-secret" },
          toolBody,
        ),
      ]);
      rejected.push([
        "an ElevenLabs tool call with no secret",
        h.hooks(`/hooks${toolPath("verify_pin")}`, { "content-type": "application/json" }, toolBody),
      ]);
      const postCall = JSON.stringify({
        type: "post_call_transcription",
        event_timestamp: 0,
        data: {
          agent_id: "agent_fake",
          conversation_id: "conv_forged_1",
          status: "done",
          transcript: [{ role: "user", message: "two", time_in_call_secs: 1 }],
          metadata: { start_time_unix_secs: Math.floor(h.clock.now.getTime() / 1000), call_duration_secs: 5 },
        },
      });
      rejected.push([
        "an ElevenLabs post-call webhook with a bad HMAC",
        h.hooks(
          `/hooks${POST_CALL_PATH}`,
          {
            "content-type": "application/json",
            "elevenlabs-signature": `t=${Math.floor(h.clock.now.getTime() / 1000)},v0=${"0".repeat(64)}`,
          },
          postCall,
        ),
      ]);
      for (const [what, pending] of rejected) {
        const response = await pending;
        equal([response.status, response.body], [403, ""], what);
      }
      await h.settle();
      // No state change: the ask still waits, nothing answered, nothing handled or recorded.
      equal(status(), statusBefore, "the question's status");
      equal(h.daemon.store.getAnswer(question.id), undefined, "the question's answer");
      equal(h.daemon.store.listCalls(), [], "call records");
      equal(h.sms.sent.length, 1, "texts sent");
      equal(
        h.daemon.store
          .listAudit()
          .slice(auditBefore)
          .map((e) => e.event),
        [],
        "audit entries from rejected webhooks",
      );
      // The same route takes the owner's properly signed reply.
      equal(await h.text("2"), "Hotline: got it.", "reply to the signed text");
      equal((await asking).choice, { option: 2, text: "eu-west" }, "the answer");
    },
  },
  {
    name: "replayed-webhook-rejected",
    async run({ start }) {
      // A Twilio text, captured and sent again while a new question waits on a text.
      const h = await start({ config: QUIET });
      const codex = await h.mcp("codex", "api");
      const first = later(
        codex.call("ask_human", { question: "Which database?", options: ["Postgres", "SQLite"] }),
      );
      const q1 = await h.waitForAsk(isKind("question"), "the first question");
      await h.advance(BATCH_MS);
      const sid = `SM${"c".repeat(32)}`;
      equal(await h.text("2", { messageSid: sid }), "Hotline: got it.", "reply to the first text");
      equal((await first).choice, { option: 2, text: "SQLite" }, "the first answer");
      const second = later(
        codex.call("ask_human", { question: "Which cache?", options: ["Redis", "Memcached"] }),
      );
      const q2 = await h.waitForAsk(isKind("question", [q1.id]), "the second question");
      await h.advance(BATCH_MS);
      equal(h.sms.sent.length, 2, "texts sent");
      const received = auditCount(h, "sms.received");
      // Twilio signatures carry no timestamp: the replay is byte for byte the signed original.
      equal(await h.text("2", { messageSid: sid }), undefined, "reply to the replayed text");
      equal(auditCount(h, "sms.received"), received, "sms.received audit entries");
      equal(h.daemon.store.getAnswer(q2.id), undefined, "the second question's answer");
      equal(h.daemon.store.getAsk(q2.id)?.status, "in-flight", "the second question's status");
      // The owner's own new reply still answers it.
      equal(await h.text("1"), "Hotline: got it.", "reply to the owner's new text");
      equal((await second).choice, { option: 1, text: "Redis" }, "the second answer");

      // An ElevenLabs post-call webhook delivered again, validly signed.
      const v = await start({ capturePostCalls: true });
      await v.away(true);
      const hook = later(v.hook("claude-code", "permission", claudeBash("pnpm test")));
      const request = await v.waitForAsk(isKind("permission"), "the permission request");
      await v.advance(BATCH_MS);
      v.voice.script(scriptedHuman.says({ kind: "answer", ask: 1, decision: "deny", words: "no, not now" }));
      await v.voice.playPending();
      await v.settle();
      expectDeny(await hook, "the owner's no");
      const replay = v.postCalls[0];
      check(replay !== undefined, "no post-call webhook was captured");
      const calls = v.daemon.store.listCalls();
      const audit = v.daemon.store.listAudit().length;
      await v.elevenLabs.postCall(replay);
      await v.settle();
      equal(v.daemon.store.listCalls(), calls, "call records after the replay");
      equal(v.daemon.store.getAnswer(request.id)?.decision, { type: "deny" }, "the stored answer");
      equal(v.daemon.store.listAudit().length, audit, "audit entries after the replay");
    },
  },
];
