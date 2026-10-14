import { describe, expect, it } from "vitest";
import {
  ClaudePermissionRequestInput,
  ClaudePermissionRequestOutput,
  ClaudeStopInput,
  CodexPermissionRequestInput,
  CodexPermissionRequestOutput,
  CodexStopInput,
  SecretFile,
  SecretName,
  SecretValue,
  StopBlockOutput,
} from "../src/index.js";

// Full payloads live in packages/agents/test/fixtures/hooks; these cover the edges.

const claudeStop = {
  session_id: "00000000-0000-4000-8000-000000000001",
  transcript_path: "/Users/example/.claude/projects/demo-app/transcript.jsonl",
  cwd: "/Users/example/src/demo-app",
  hook_event_name: "Stop",
  stop_hook_active: false,
};

const codexStop = {
  ...claudeStop,
  model: "gpt-fake",
  permission_mode: "default",
  turn_id: "turn-1",
  last_assistant_message: null,
};

describe("hook inputs", () => {
  it("keeps fields a newer agent release adds", () => {
    const parsed = ClaudeStopInput.parse({ ...claudeStop, background_tasks: [], effort: { level: "high" } });
    expect(parsed).toMatchObject({ background_tasks: [], effort: { level: "high" } });
  });

  it("requires the fields adapters rely on", () => {
    const { stop_hook_active: _, ...missing } = claudeStop;
    expect(ClaudeStopInput.safeParse(missing).success).toBe(false);
    expect(ClaudeStopInput.safeParse({ ...claudeStop, hook_event_name: "PermissionRequest" }).success).toBe(
      false,
    );
    expect(
      ClaudePermissionRequestInput.safeParse({ ...claudeStop, hook_event_name: "PermissionRequest" }).success,
    ).toBe(false);
  });

  it("follows Codex's nullable fields and permission modes", () => {
    expect(CodexStopInput.parse({ ...codexStop, transcript_path: null }).transcript_path).toBeNull();
    expect(CodexStopInput.safeParse({ ...codexStop, permission_mode: "auto" }).success).toBe(false);
    const { turn_id: _, ...noTurn } = codexStop;
    expect(CodexStopInput.safeParse(noTurn).success).toBe(false);
    expect(
      CodexPermissionRequestInput.parse({
        ...codexStop,
        hook_event_name: "PermissionRequest",
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch" },
      }).tool_name,
    ).toBe("apply_patch");
  });
});

describe("hook outputs", () => {
  const permission = (decision: unknown) => ({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision },
  });

  it("never rewrites input or adds permission rules", () => {
    for (const schema of [ClaudePermissionRequestOutput, CodexPermissionRequestOutput]) {
      expect(schema.safeParse(permission({ behavior: "allow" })).success).toBe(true);
      expect(schema.safeParse(permission({ behavior: "deny", message: "The owner said no." })).success).toBe(
        true,
      );
      expect(
        schema.safeParse(permission({ behavior: "allow", updatedInput: { command: "ls" } })).success,
      ).toBe(false);
      expect(schema.safeParse(permission({ behavior: "allow", updatedPermissions: [] })).success).toBe(false);
      expect(schema.safeParse(permission({ behavior: "ask" })).success).toBe(false);
      expect(schema.safeParse({ ...permission({ behavior: "allow" }), continue: true }).success).toBe(false);
    }
  });

  it("does not send interrupt to Codex, which fails closed on it", () => {
    const deny = permission({ behavior: "deny", message: "No.", interrupt: true });
    expect(ClaudePermissionRequestOutput.safeParse(deny).success).toBe(true);
    expect(CodexPermissionRequestOutput.safeParse(deny).success).toBe(false);
  });

  it("continues a stopped agent only with a non-blank instruction", () => {
    expect(StopBlockOutput.parse({ decision: "block", reason: "Now write the tests." })).toBeTruthy();
    expect(StopBlockOutput.safeParse({ decision: "block", reason: "   " }).success).toBe(false);
    expect(StopBlockOutput.safeParse({ decision: "block" }).success).toBe(false);
    expect(StopBlockOutput.safeParse({ decision: "approve", reason: "x" }).success).toBe(false);
  });
});

describe("secrets", () => {
  it("names every secret Hotline stores", () => {
    expect(SecretName.options).toEqual([
      "daemon.apiToken",
      "elevenlabs.apiKey",
      "elevenlabs.toolSecret",
      "elevenlabs.webhookSecret",
      "twilio.accountSid",
      "twilio.authToken",
    ]);
  });

  it("accepts one-line printable ASCII values only", () => {
    expect(SecretValue.safeParse("sk_fake_0123456789abcdef").success).toBe(true);
    for (const value of ["", "two words", "line\nbreak", "tab\there", "naïve", "x".repeat(4097)]) {
      expect(SecretValue.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("parses the fallback file and rejects unknown names", () => {
    expect(
      SecretFile.parse({ version: 1, secrets: { "twilio.authToken": "fake-auth-token" } }).secrets,
    ).toEqual({
      "twilio.authToken": "fake-auth-token",
    });
    expect(SecretFile.safeParse({ version: 1, secrets: { "github.token": "x" } }).success).toBe(false);
  });
});
