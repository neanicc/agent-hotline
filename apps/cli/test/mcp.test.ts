// `hotline mcp` end to end: the CLI command on in-process stdin/stdout streams,
// driven by the MCP SDK client over the same newline-delimited JSON-RPC framing
// a real stdio client uses, against a `hotline daemon` started by the CLI.
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { hotlinePaths, writePrivateFile } from "@hotline/daemon";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliContext, run } from "../src/cli.js";

const CONFIG = {
  version: 1,
  owner: { phoneNumber: "+15555550100", pinHash: `scrypt$15$8$1$${"s".repeat(22)}$${"h".repeat(43)}` },
  quietHours: { timeZone: "America/Toronto" },
  secrets: { store: "file" },
};

let dir: string;
let signals: EventEmitter;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hotline-cli-mcp-"));
  signals = new EventEmitter();
});

afterEach(async () => {
  signals.emit("SIGTERM");
  await rm(dir, { recursive: true, force: true });
});

const home = () => join(dir, "home");
const paths = () => hotlinePaths({ env: { HOTLINE_HOME: home() }, homeDir: "/nonexistent" });

function context(extra: Partial<CliContext> = {}): CliContext {
  return {
    // Never the real ~/.hotline.
    env: { HOTLINE_HOME: home() },
    homeDir: join(dir, "nonexistent-home"),
    platform: process.platform,
    signals,
    logDestination: { write: () => {} },
    ...extra,
  };
}

/** The client half of a stdio connection, over the server's stdout and stdin. */
class StreamTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private readonly buffer = new ReadBuffer();

  constructor(
    private readonly fromServer: PassThrough,
    private readonly toServer: PassThrough,
  ) {}

  async start(): Promise<void> {
    this.fromServer.on("data", (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (let message = this.buffer.readMessage(); message !== null; message = this.buffer.readMessage()) {
        this.onmessage?.(message);
      }
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.toServer.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    this.toServer.end();
    this.onclose?.();
  }
}

function startMcp(argv: string[]) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const raw: string[] = [];
  stdout.on("data", (chunk: Buffer) => raw.push(chunk.toString("utf8")));
  const stderr: string[] = [];
  const code = run(
    ["mcp", ...argv],
    { stdout: (text) => raw.push(`[out.stdout] ${text}`), stderr: (text) => stderr.push(text) },
    context({ stdin, stdout, cwd: "/work/demo-app" }),
  );
  const client = new Client({ name: "codex-mcp-client", version: "1.0.0" });
  return { client, transport: new StreamTransport(stdout, stdin), code, raw, stderr };
}

function json(result: unknown): Record<string, unknown> {
  const first = (result as CallToolResult).content[0];
  if (first?.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text) as Record<string, unknown>;
}

async function startDaemon(): Promise<{ port: string; stop: () => Promise<number> }> {
  await writePrivateFile(paths().config, JSON.stringify(CONFIG));
  let ready: (line: string) => void = () => {};
  const line = new Promise<string>((resolve) => {
    ready = resolve;
  });
  const code = run(["daemon", "--port", "0"], { stdout: (text) => ready(text), stderr: () => {} }, context());
  const port = /127\.0\.0\.1:(\d+),/.exec(await line)?.[1] ?? "";
  return {
    port,
    stop: async () => {
      signals.emit("SIGTERM");
      return code;
    },
  };
}

describe("hotline mcp", () => {
  it("prints its usage to stderr, never stdout", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(
      ["mcp", "--help"],
      { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
      context(),
    );
    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("Usage: hotline mcp");
  });

  it.each([[["--agent"]], [["--agent", "cursor"]], [["--port", "0"]], [["--port", "x"]], [["--verbose"]]])(
    "rejects %j with exit 2",
    async (argv) => {
      const err: string[] = [];
      const code = await run(["mcp", ...argv], { stdout: () => {}, stderr: (t) => err.push(t) }, context());
      expect(code).toBe(2);
      expect(err.join("\n")).toContain("Usage: hotline mcp");
    },
  );

  it("serves the tools over stdio, registers with the daemon and exits 0 when stdin closes", async () => {
    const daemon = await startDaemon();
    const mcp = startMcp(["--agent", "codex", "--port", daemon.port]);
    await mcp.client.connect(mcp.transport);

    const { tools } = await mcp.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["ask_human", "check_inbox", "notify_human"]);
    const note = await mcp.client.callTool({
      name: "notify_human",
      arguments: { message: "Build finished." },
    });
    expect(json(note)).toMatchObject({ queued: true });
    const inbox = json(await mcp.client.callTool({ name: "check_inbox", arguments: {} }));
    expect(inbox).toMatchObject({
      session: { nickname: "Codex in demo-app" },
      instructions: [],
      asks: [{ kind: "notify", status: "pending", text: "Build finished." }],
    });

    await mcp.client.close();
    expect(await mcp.code).toBe(0);
    // Every byte on stdout is a JSON-RPC message: nothing else may reach the protocol stream.
    for (const line of mcp.raw
      .join("")
      .split("\n")
      .filter((text) => text !== "")) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    }
    const secrets = JSON.parse(await readFile(paths().secrets, "utf8")) as {
      secrets: Record<string, string>;
    };
    expect(mcp.stderr.join("\n")).not.toContain(secrets.secrets["daemon.apiToken"]);
    expect(await daemon.stop()).toBe(0);
  });

  it("answers 'no answer' when Hotline is not set up, and says why on stderr", async () => {
    const mcp = startMcp(["--agent", "claude"]);
    await mcp.client.connect(mcp.transport);
    const result = json(
      await mcp.client.callTool({ name: "ask_human", arguments: { question: "Ship it?" } }),
    );
    expect(result).toMatchObject({ outcome: "no-answer", reason: "failed" });
    expect(mcp.stderr.join("\n")).toContain('run "hotline init"');
    await mcp.client.close();
    expect(await mcp.code).toBe(0);
  });
});
