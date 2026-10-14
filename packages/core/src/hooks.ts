// Hook payloads for Claude Code and Codex `PermissionRequest` and `Stop`.
//
// Inputs are what each agent writes to the hook's stdin. They are parsed loosely:
// the agents add fields between releases, so unknown fields are kept, while the
// fields Hotline relies on are required. A payload that fails to parse must make
// the adapter fall back to the agent's own terminal prompt (permission) or let the
// agent stop (Stop); it never approves anything.
//
// Outputs are what Hotline prints. They are strict and narrower than what the
// agents accept: Hotline never rewrites tool input, never adds permission rules
// and never sends a field Codex rejects.
//
// Sources (see packages/agents/test/fixtures/hooks/README.md):
//   Claude Code: https://code.claude.com/docs/en/hooks
//   Codex: https://developers.openai.com/codex/hooks and the generated schemas in
//   openai/codex codex-rs/hooks/schema/generated at e444aa99d76beeb8b5b0610b793c0cdefe58da58
import { z } from "zod";

const nonEmpty = z.string().min(1);

// Claude Code ---------------------------------------------------------------

const claudeCommonInput = {
  session_id: nonEmpty,
  transcript_path: z.string(),
  cwd: nonEmpty,
  /** Documented values include default, plan, acceptEdits, auto, dontAsk, bypassPermissions. */
  permission_mode: z.string().optional(),
};

export const ClaudePermissionRequestInput = z.looseObject({
  ...claudeCommonInput,
  hook_event_name: z.literal("PermissionRequest"),
  tool_name: nonEmpty,
  tool_input: z.record(z.string(), z.unknown()),
  permission_suggestions: z.array(z.unknown()).optional(),
});
export type ClaudePermissionRequestInput = z.infer<typeof ClaudePermissionRequestInput>;

export const ClaudeStopInput = z.looseObject({
  ...claudeCommonInput,
  hook_event_name: z.literal("Stop"),
  /** True when the agent is already continuing because a Stop hook blocked it. */
  stop_hook_active: z.boolean(),
  last_assistant_message: z.string().optional(),
});
export type ClaudeStopInput = z.infer<typeof ClaudeStopInput>;

export const ClaudePermissionRequestOutput = z.strictObject({
  hookSpecificOutput: z.strictObject({
    hookEventName: z.literal("PermissionRequest"),
    decision: z.discriminatedUnion("behavior", [
      z.strictObject({ behavior: z.literal("allow") }),
      z.strictObject({
        behavior: z.literal("deny"),
        /** Tells the agent why. */
        message: nonEmpty.optional(),
        interrupt: z.boolean().optional(),
      }),
    ]),
  }),
});
export type ClaudePermissionRequestOutput = z.infer<typeof ClaudePermissionRequestOutput>;

// Codex ---------------------------------------------------------------------

const codexCommonInput = {
  session_id: nonEmpty,
  transcript_path: z.string().nullable(),
  cwd: nonEmpty,
  model: z.string(),
  /**
   * Documented today as `default`, `acceptEdits`, `plan`, `dontAsk` or
   * `bypassPermissions`. Kept open, as for Claude Code: Hotline does not act on it,
   * and a closed list would make every payload fail to parse when Codex adds a mode.
   */
  permission_mode: z.string(),
  turn_id: z.string(),
};

export const CodexPermissionRequestInput = z.looseObject({
  ...codexCommonInput,
  hook_event_name: z.literal("PermissionRequest"),
  /** `Bash`, `apply_patch` or `mcp__<server>__<tool>`. */
  tool_name: nonEmpty,
  /** Any JSON value; `Bash` and `apply_patch` carry `command`, MCP tools their arguments. */
  tool_input: z.unknown(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
});
export type CodexPermissionRequestInput = z.infer<typeof CodexPermissionRequestInput>;

export const CodexStopInput = z.looseObject({
  ...codexCommonInput,
  hook_event_name: z.literal("Stop"),
  stop_hook_active: z.boolean(),
  last_assistant_message: z.string().nullable(),
});
export type CodexStopInput = z.infer<typeof CodexStopInput>;

/** Codex fails closed on `interrupt`, `updatedInput` and `updatedPermissions`, so Hotline never sends them. */
export const CodexPermissionRequestOutput = z.strictObject({
  hookSpecificOutput: z.strictObject({
    hookEventName: z.literal("PermissionRequest"),
    decision: z.discriminatedUnion("behavior", [
      z.strictObject({ behavior: z.literal("allow") }),
      z.strictObject({ behavior: z.literal("deny"), message: nonEmpty.optional() }),
    ]),
  }),
});
export type CodexPermissionRequestOutput = z.infer<typeof CodexPermissionRequestOutput>;

// Both ----------------------------------------------------------------------

/**
 * Keeps the agent going with `reason` as its next prompt. Both agents use this
 * shape. To let the agent stop, the hook prints nothing and exits 0.
 */
export const StopBlockOutput = z.strictObject({
  decision: z.literal("block"),
  reason: z
    .string()
    .max(4000)
    .refine((reason) => reason.trim().length > 0, "must not be blank"),
});
export type StopBlockOutput = z.infer<typeof StopBlockOutput>;
