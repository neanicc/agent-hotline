// Every scenario in docs/eval.md, in the order of its table.
import type { Scenario } from "../scenario.js";
import { answerScenarios } from "./answers.js";
import { failsafeScenarios } from "./failsafe.js";
import { inboundScenarios } from "./inbound.js";
import { policyScenarios } from "./policy.js";
import { stopScenarios } from "./stop.js";
import { webhookScenarios } from "./webhooks.js";

const ORDER = [
  "question-answered-by-voice",
  "question-answered-by-text",
  "permission-approved",
  "permission-denied",
  "high-risk-needs-pin",
  "silence-denies",
  "unclear-answer-denies",
  "no-pickup-falls-back-to-text",
  "two-agents-one-call",
  "quiet-hours-texts-instead",
  "rate-limit-holds-calls",
  "away-mode-continues-claude",
  "away-mode-continues-codex",
  "stop-loop-capped",
  "inbound-status-with-pin",
  "inbound-wrong-pin-rejected",
  "inbound-other-number-rejected",
  "inbound-instruction-delivered",
  "agent-text-cannot-self-approve",
  "unsigned-webhook-rejected",
  "replayed-webhook-rejected",
  "secrets-redacted-before-send",
];

const all = [
  ...answerScenarios,
  ...failsafeScenarios,
  ...policyScenarios,
  ...stopScenarios,
  ...inboundScenarios,
  ...webhookScenarios,
];

export const SCENARIOS: readonly Scenario[] = [...all].sort(
  (a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name),
);
