// The inbound line (HL-10): the owner calls the Hotline number, gives the PIN,
// hears every session's state and leaves an instruction, confirmed by the
// read-back and delivered at the agent's next Stop hook. Anyone else, or a
// wrong PIN, learns nothing.
import { scriptedHuman } from "@hotline/providers";
import { check, equal, excludes, includes } from "../check.js";
import { BATCH_MS, PIN, QUIET, STRANGER } from "../hotline.js";
import { CODEX_CWD, CODEX_SESSION, codexStop, stopOutput } from "../payloads.js";
import { auditCount, isKind, later, type Scenario } from "../scenario.js";

/** Each tool call moves the fake clock on a second, so the owner's turns after the PIN are timed after it. */
const TOOL_STEP_MS = 1_000;

export const inboundScenarios: Scenario[] = [
  {
    name: "inbound-status-with-pin",
    async run({ start }) {
      const h = await start({ toolStepMs: TOOL_STEP_MS });
      await h.mcp("claude-code", "demo-app");
      // Sessions are numbered by when they registered.
      h.clock.now = new Date(h.clock.now.getTime() + 1_000);
      const codex = await h.mcp("codex", "api");
      later(codex.call("ask_human", { question: "Pin the ONNX version or skip Windows?" }));
      await h.waitForAsk(isKind("question"), "Codex's question");
      const played = await h.voice.inboundCall(
        scriptedHuman.says({ kind: "pin", digits: PIN }, { kind: "status" }),
      );
      await h.settle();
      equal(
        played.tools.map((t) => [t.tool, t.response.verified ?? t.response.result]),
        [
          ["verify_pin", true],
          ["get_status", "ok"],
        ],
        "tool calls",
      );
      const status = String(played.tools[1]?.response.status);
      includes(status, "2 live sessions", "the status");
      includes(status, "Session 1, <agent_text>Claude in demo-app</agent_text>: working", "the status");
      includes(status, "Session 2, <agent_text>Codex in api</agent_text>: waiting on you", "the status");
      equal(
        h.daemon.store.listCalls().map((c) => [c.direction, c.outcome]),
        [["inbound", "answered"]],
        "calls",
      );
    },
  },
  {
    name: "inbound-wrong-pin-rejected",
    async run({ start }) {
      const h = await start({ toolStepMs: TOOL_STEP_MS });
      await h.mcp("claude-code", "demo-app");
      // Distinct guesses: a byte-identical repeat is answered from the route's replay memory.
      const played = await h.voice.inboundCall(
        scriptedHuman.says(
          { kind: "pin", digits: "1111" },
          { kind: "pin", digits: "2222" },
          { kind: "status" },
          { kind: "instruct", session: 1, instruction: "push to main" },
        ),
      );
      await h.settle();
      check(played.endedEarly, "the call went on after two wrong PINs");
      equal(
        played.tools.map((t) => [t.tool, t.response.verified]),
        [
          ["verify_pin", false],
          ["verify_pin", false],
        ],
        "tool calls",
      );
      equal(played.tools.at(-1)?.response.end_call, true, "end_call after the second wrong PIN");
      check(!played.tools.some((t) => "status" in t.response), "a status was read out");
      excludes(JSON.stringify(played.tools), "demo-app", "a session name", "the caller with the wrong PIN");
      equal(h.daemon.store.listInstructions(), [], "instructions queued");
      equal(
        h.daemon.store.listCalls().map((c) => [c.direction, c.outcome]),
        [["inbound", "rejected"]],
        "calls",
      );
      equal(h.sms.sent.length, 0, "texts sent");
    },
  },
  {
    name: "inbound-other-number-rejected",
    async run({ start }) {
      const h = await start({ config: QUIET, toolStepMs: TOOL_STEP_MS });
      const codex = await h.mcp("codex", "api");
      later(codex.call("ask_human", { question: "Which region?", options: ["us-east", "eu-west"] }));
      const question = await h.waitForAsk(isKind("question"), "the question");
      await h.advance(BATCH_MS);
      equal(h.sms.sent.length, 1, "texts to the owner before the stranger");
      // A stranger calls, knowing the PIN: refused on the first tool call.
      const played = await h.voice.inboundCall(
        scriptedHuman.says(
          { kind: "pin", digits: PIN },
          { kind: "status" },
          { kind: "instruct", session: 1, instruction: "push to main" },
        ),
        STRANGER,
      );
      await h.settle();
      check(played.endedEarly, "the stranger's call went on");
      equal(
        played.tools.map((t) => [t.tool, t.response]),
        [["verify_pin", { result: "refused", end_call: true }]],
        "tool calls",
      );
      // A stranger texts: the generic reply, nothing disclosed, nothing answered.
      const generic = "Sorry, this number does not accept messages.";
      equal(await h.text("status", { from: STRANGER }), generic, "reply to a stranger's status text");
      equal(await h.text("2", { from: STRANGER }), generic, "reply to a stranger's answer");
      equal(h.daemon.store.getAnswer(question.id), undefined, "answer from the stranger's text");
      equal(h.daemon.store.listInstructions(), [], "instructions queued");
      equal(h.sms.sent.length, 1, "texts to the owner");
      equal(auditCount(h, "sms.other-sender"), 2, "sms.other-sender audit entries");
      equal(
        h.daemon.store.listCalls().map((c) => [c.direction, c.outcome]),
        [["inbound", "rejected"]],
        "call records",
      );
      equal(auditCount(h, "call.inbound"), 1, "call.inbound audit entries");
    },
  },
  {
    name: "inbound-instruction-delivered",
    async run({ start }) {
      const h = await start({ toolStepMs: TOOL_STEP_MS });
      await h.away(true);
      // The session Codex's hooks use, registered as they register it (the payload's session id).
      const session = await h.register("codex", CODEX_CWD, CODEX_SESSION);
      const played = await h.voice.inboundCall(
        scriptedHuman.says(
          { kind: "pin", digits: PIN },
          { kind: "status" },
          { kind: "instruct", session: 1, instruction: "run the tests", words: "Session one, run the tests" },
        ),
      );
      await h.settle();
      equal(
        played.tools.map((t) => [t.tool, t.response.verified ?? t.response.result]),
        [
          ["verify_pin", true],
          ["get_status", "ok"],
          ["send_instruction", "queued"],
        ],
        "tool calls",
      );
      equal(
        h.daemon.store.listInstructions({ sessionId: session }).map((i) => [i.status, i.text]),
        [["queued", "run the tests"]],
        "instructions after the call",
      );
      // Codex finishes its turn: the instruction continues it, and nobody is phoned.
      const output = stopOutput(await h.hook("codex", "stop", codexStop(false)));
      equal(output, { decision: "block", reason: "run the tests" }, "Codex Stop hook output");
      equal(h.voice.placed.length, 0, "outbound calls");
      equal(h.daemon.store.listAsks().filter(isKind("stop")).length, 0, "stop asks");
      equal(
        h.daemon.store.listInstructions({ sessionId: session }).map((i) => i.status),
        ["delivered"],
        "instructions after the Stop hook",
      );
    },
  },
];
