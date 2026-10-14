// Every hook fixture must parse with the @hotline/core schema for its event, Codex
// fixtures must also satisfy Codex's own published JSON schemas, and no fixture
// may carry real-looking personal data.
import { readdirSync, readFileSync } from "node:fs";
import {
  ClaudePermissionRequestInput,
  ClaudePermissionRequestOutput,
  ClaudeStopInput,
  CodexPermissionRequestInput,
  CodexPermissionRequestOutput,
  CodexStopInput,
  StopBlockOutput,
} from "@hotline/core";
import { describe, expect, it } from "vitest";

interface Schema {
  safeParse(value: unknown): { success: boolean; error?: { issues: unknown } };
}

const fixtures = new URL("./fixtures/hooks/", import.meta.url);

function read(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, fixtures), "utf8"));
}

function listJson(dir: string): string[] {
  return readdirSync(new URL(dir, fixtures))
    .filter((name) => name.endsWith(".json"))
    .map((name) => `${dir}${name}`)
    .sort();
}

const coreSchemas: Record<string, Schema> = {
  "claude-code/permission-request.input.json": ClaudePermissionRequestInput,
  "claude-code/permission-request.allow.output.json": ClaudePermissionRequestOutput,
  "claude-code/permission-request.deny.output.json": ClaudePermissionRequestOutput,
  "claude-code/stop.input.json": ClaudeStopInput,
  "claude-code/stop.continued.input.json": ClaudeStopInput,
  "claude-code/stop.block.output.json": StopBlockOutput,
  "codex/permission-request.input.json": CodexPermissionRequestInput,
  "codex/permission-request.apply-patch.input.json": CodexPermissionRequestInput,
  "codex/permission-request.allow.output.json": CodexPermissionRequestOutput,
  "codex/permission-request.deny.output.json": CodexPermissionRequestOutput,
  "codex/stop.input.json": CodexStopInput,
  "codex/stop.continued.input.json": CodexStopInput,
  "codex/stop.block.output.json": StopBlockOutput,
};

// The Codex schema each Codex fixture must satisfy, e.g. codex/stop.continued.input.json
// -> codex/schema/stop.command.input.schema.json.
function codexSchemaFor(fixture: string): string {
  const event = fixture.replace("codex/", "").split(".")[0];
  const direction = fixture.endsWith(".input.json") ? "input" : "output";
  return `codex/schema/${event}.command.${direction}.schema.json`;
}

// Minimal JSON Schema (draft-07) checker covering what Codex's generated schemas
// use: type, const, enum, properties, required, additionalProperties: false,
// $ref into definitions, allOf, and the `true` schema.
type JsonSchema = boolean | { [key: string]: unknown };

function schemaErrors(schema: JsonSchema, value: unknown, root: JsonSchema, at = "$"): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${at}: no value allowed`];
  const errors: string[] = [];
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.replace("#/definitions/", "");
    const definitions = (root as { definitions?: Record<string, JsonSchema> }).definitions ?? {};
    const target = definitions[name];
    if (target === undefined) return [`${at}: unresolved ${schema.$ref}`];
    errors.push(...schemaErrors(target, value, root, at));
  }
  for (const part of (schema.allOf as JsonSchema[] | undefined) ?? [])
    errors.push(...schemaErrors(part, value, root, at));
  if ("const" in schema && value !== schema.const)
    errors.push(`${at}: expected ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${at}: not in enum`);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const matches = types.some((type) => type === actual || (type === "integer" && Number.isInteger(value)));
    if (!matches) errors.push(`${at}: expected ${types.join(" or ")}, got ${actual}`);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in record)) errors.push(`${at}.${key}: required`);
    }
    for (const [key, child] of Object.entries(record)) {
      const childSchema = properties[key];
      if (childSchema !== undefined) errors.push(...schemaErrors(childSchema, child, root, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: not allowed`);
    }
  }
  return errors;
}

describe("hook fixtures", () => {
  it("covers every fixture file with a core schema", () => {
    expect([...listJson("claude-code/"), ...listJson("codex/")]).toEqual(Object.keys(coreSchemas).sort());
  });

  for (const [fixture, schema] of Object.entries(coreSchemas)) {
    it(`${fixture} parses with the @hotline/core schema`, () => {
      const result = schema.safeParse(read(fixture));
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    });
  }

  for (const fixture of Object.keys(coreSchemas).filter((name) => name.startsWith("codex/"))) {
    it(`${fixture} satisfies Codex's published schema`, () => {
      const schemaPath = codexSchemaFor(fixture);
      const schema = read(schemaPath) as JsonSchema;
      expect(schemaErrors(schema, read(fixture), schema), schemaPath).toEqual([]);
    });
  }

  it("the JSON Schema checker catches what it claims to", () => {
    const schema = read("codex/schema/stop.command.input.schema.json") as JsonSchema;
    const good = read("codex/stop.input.json") as Record<string, unknown>;
    const { turn_id: _, ...missing } = good;
    expect(schemaErrors(schema, missing, schema)).toEqual(["$.turn_id: required"]);
    expect(schemaErrors(schema, { ...good, extra: 1 }, schema)).toEqual(["$.extra: not allowed"]);
    expect(schemaErrors(schema, { ...good, hook_event_name: "Start" }, schema)).toEqual([
      '$.hook_event_name: expected "Stop"',
    ]);
    expect(schemaErrors(schema, { ...good, permission_mode: "auto" }, schema)).toEqual([
      "$.permission_mode: not in enum",
    ]);
    expect(schemaErrors(schema, { ...good, last_assistant_message: 3 }, schema)).toEqual([
      "$.last_assistant_message: expected string or null, got number",
    ]);
    const output = read("codex/schema/permission-request.command.output.schema.json") as JsonSchema;
    const deny = {
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "maybe" } },
    };
    expect(schemaErrors(output, deny, output)).toEqual([
      "$.hookSpecificOutput.decision.behavior: not in enum",
    ]);
  });

  it("contains only fake data", () => {
    const files = [...listJson("claude-code/"), ...listJson("codex/")];
    for (const file of files) {
      const text = readFileSync(new URL(file, fixtures), "utf8");
      for (const phone of text.match(/\+[\d\s().-]{7,}\d/g) ?? []) {
        expect(phone, `${file} has a phone-like number`).toMatch(/^\+1555555\d{4}$/);
      }
      for (const path of text.match(/\/Users\/[^/"]+/g) ?? []) {
        expect(path, `${file} names a real home directory`).toBe("/Users/example");
      }
      expect(text, file).not.toMatch(/sk[-_](live|proj|ant)|AKIA[0-9A-Z]{16}|-----BEGIN|ghp_[A-Za-z0-9]/);
    }
  });
});
