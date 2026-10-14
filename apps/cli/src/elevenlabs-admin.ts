// The few ElevenLabs management calls the setup commands make: the workspace
// secret for the tool header, the four server tools, the agent, and the voice
// list. A small hand-written REST client like the voice provider's, with an
// injected `fetch` so tests never reach the network. Error messages never quote
// ElevenLabs' responses, which can echo the request.
//
// Endpoints (checked 2026-10-14):
//   POST  /v1/convai/secrets            {type: "new", name, value} -> {secret_id}
//   PATCH /v1/convai/secrets/{secret_id} {type: "update", name, value}
//         https://elevenlabs.io/docs/api-reference/workspace/secrets/create, .../secrets/update
//   POST  /v1/convai/tools              {tool_config} -> {id}
//   PATCH /v1/convai/tools/{tool_id}    {tool_config}
//   GET   /v1/convai/tools/{tool_id}    -> {id, tool_config: {api_schema: {url, request_headers}}}
//         https://elevenlabs.io/docs/api-reference/tools/create, .../tools/update, .../tools/get
//   POST  /v1/convai/agents/create      agent body -> {agent_id}
//   PATCH /v1/convai/agents/{agent_id}  agent body
//   GET   /v1/convai/agents/{agent_id}  -> {agent_id, tags, conversation_config, ...}
//         https://elevenlabs.io/docs/api-reference/agents/create, .../agents/update, .../agents/get
//   GET   /v2/voices?page_size=100[&next_page_token=...]
//                                       -> {voices: [{voice_id, name, category}], has_more, next_page_token}
//         https://elevenlabs.io/docs/api-reference/voices/search
import {
  AGENT_DEFINITION_VERSION,
  hotlineAgentConfig,
  hotlineToolConfigs,
  isVoiceId,
  TOOL_NAMES,
  TOOL_SECRET_HEADER,
} from "@hotline/providers";
import type { CliFetch } from "./setup.js";

export const ELEVENLABS_ORIGIN = "https://api.elevenlabs.io";
const TIMEOUT_MS = 15_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** `voice list` reads at most this many pages of 100 voices, then says the list was cut short. */
export const MAX_VOICE_PAGES = 10;
/** Name of the workspace secret holding `elevenlabs.toolSecret`. */
export const TOOL_SECRET_NAME = "agent-hotline-tool-secret";

export class ElevenLabsAdminError extends Error {
  override readonly name = "ElevenLabsAdminError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface DeployedAgent {
  /** `definition-v<n>` from the agent's tags, or undefined when it has none. */
  definitionVersion?: number;
  voiceId?: string;
  toolIds: string[];
}

export interface DeployedTool {
  /** `tool_config.api_schema.url`: where ElevenLabs sends this tool's calls. */
  url?: string;
  /** The workspace secret id behind the tool-secret header. */
  secretId?: string;
}

export interface VoiceSummary {
  voiceId: string;
  name: string;
  category: string;
}

/** Text from ElevenLabs, made safe to print: one line, no control characters, capped. */
function printable(value: unknown, max = 60): string {
  if (typeof value !== "string") return "";
  const flat = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export class ElevenLabsAdmin {
  constructor(
    private readonly apiKey: string,
    private readonly fetch: CliFetch,
  ) {
    if (apiKey === "") throw new ElevenLabsAdminError("The ElevenLabs API key is empty");
  }

  private async call(
    method: "GET" | "POST" | "PATCH",
    path: string,
    what: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    let response: Awaited<ReturnType<CliFetch>>;
    try {
      response = await this.fetch(`${ELEVENLABS_ORIGIN}${path}`, {
        method,
        headers: {
          "xi-api-key": this.apiKey,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
    } catch {
      throw new ElevenLabsAdminError(`Could not reach ElevenLabs to ${what}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ElevenLabsAdminError(
        `ElevenLabs refused the API key (HTTP ${response.status})`,
        response.status,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ElevenLabsAdminError(
        `ElevenLabs could not ${what} (HTTP ${response.status})`,
        response.status,
      );
    }
    try {
      return record(await response.json());
    } catch {
      throw new ElevenLabsAdminError(`ElevenLabs' answer to ${what} is not JSON`, response.status);
    }
  }

  private static id(value: unknown, what: string): string {
    if (typeof value !== "string" || !ID.test(value)) {
      throw new ElevenLabsAdminError(`ElevenLabs' answer to ${what} has no usable id`);
    }
    return value;
  }

  async createSecret(name: string, value: string): Promise<string> {
    const body = await this.call("POST", "/v1/convai/secrets", "store the tool secret", {
      type: "new",
      name,
      value,
    });
    return ElevenLabsAdmin.id(body.secret_id, "store the tool secret");
  }

  /** Replaces the value of an existing workspace secret, keeping its id. */
  async updateSecret(secretId: string, name: string, value: string): Promise<void> {
    const path = `/v1/convai/secrets/${ElevenLabsAdmin.id(secretId, "the tool secret")}`;
    await this.call("PATCH", path, "update the tool secret", { type: "update", name, value });
  }

  async createTool(toolConfig: unknown): Promise<string> {
    const body = await this.call("POST", "/v1/convai/tools", "create a tool", { tool_config: toolConfig });
    return ElevenLabsAdmin.id(body.id, "create a tool");
  }

  async updateTool(toolId: string, toolConfig: unknown): Promise<void> {
    await this.call("PATCH", `/v1/convai/tools/${ElevenLabsAdmin.id(toolId, "a tool")}`, "update a tool", {
      tool_config: toolConfig,
    });
  }

  async getTool(toolId: string): Promise<DeployedTool> {
    const body = await this.call(
      "GET",
      `/v1/convai/tools/${ElevenLabsAdmin.id(toolId, "a tool")}`,
      "read a tool",
    );
    const schema = record(record(body.tool_config).api_schema);
    const header = record(record(schema.request_headers)[TOOL_SECRET_HEADER]);
    return {
      ...(typeof schema.url === "string" ? { url: schema.url } : {}),
      ...(typeof header.secret_id === "string" ? { secretId: header.secret_id } : {}),
    };
  }

  async createAgent(agent: unknown): Promise<string> {
    const body = await this.call("POST", "/v1/convai/agents/create", "create the agent", agent);
    return ElevenLabsAdmin.id(body.agent_id, "create the agent");
  }

  async updateAgent(agentId: string, agent: unknown): Promise<void> {
    const path = `/v1/convai/agents/${ElevenLabsAdmin.id(agentId, "the agent")}`;
    await this.call("PATCH", path, "update the agent", agent);
  }

  async getAgent(agentId: string): Promise<DeployedAgent> {
    const path = `/v1/convai/agents/${ElevenLabsAdmin.id(agentId, "the agent")}`;
    const body = await this.call("GET", path, "read the agent");
    const tags = Array.isArray(body.tags) ? body.tags : [];
    const versions = tags.flatMap((tag) => {
      const match = typeof tag === "string" ? /^definition-v(\d{1,6})$/.exec(tag) : null;
      return match ? [Number(match[1])] : [];
    });
    const agent = record(record(body.conversation_config).agent);
    const toolIds = record(agent.prompt).tool_ids;
    const voiceId = record(record(body.conversation_config).tts).voice_id;
    return {
      ...(versions.length === 0 ? {} : { definitionVersion: Math.max(...versions) }),
      ...(typeof voiceId === "string" && isVoiceId(voiceId) ? { voiceId } : {}),
      toolIds: Array.isArray(toolIds) ? toolIds.filter((id): id is string => typeof id === "string") : [],
    };
  }

  /** Every voice in the account, page by page, up to `MAX_VOICE_PAGES` pages. */
  async listVoices(): Promise<{ voices: VoiceSummary[]; complete: boolean }> {
    const voices: VoiceSummary[] = [];
    let token: string | undefined;
    for (let page = 0; page < MAX_VOICE_PAGES; page++) {
      const query = token === undefined ? "" : `&next_page_token=${encodeURIComponent(token)}`;
      const body = await this.call("GET", `/v2/voices?page_size=100${query}`, "list voices");
      for (const voice of Array.isArray(body.voices) ? body.voices : []) {
        const { voice_id: voiceId, name, category } = record(voice);
        if (typeof voiceId !== "string" || !isVoiceId(voiceId)) continue;
        voices.push({ voiceId, name: printable(name) || "(no name)", category: printable(category, 20) });
      }
      const next = body.next_page_token;
      if (body.has_more !== true || typeof next !== "string" || next === "")
        return { voices, complete: true };
      token = next;
    }
    return { voices, complete: false };
  }
}

export interface DeployOptions {
  admin: ElevenLabsAdmin;
  /** `config.tunnel.publicUrl`. */
  publicUrl: string;
  /** The `elevenlabs.toolSecret` value, stored in ElevenLabs as a workspace secret. */
  toolSecret: string;
  voiceId?: string;
  /** Ids from earlier runs, so this updates rather than creates. */
  agentId?: string;
  toolSecretId?: string;
  toolIds?: Readonly<Record<string, string>>;
  /** Persists ids as they are created, so a failure part way never orphans one. */
  save(ids: { agentId?: string; toolSecretId?: string; toolIds?: Record<string, string> }): Promise<void>;
  /** One line per step, for the owner. */
  log(line: string): void;
}

/**
 * Creates or updates the workspace secret, the four server tools and the agent
 * from `hotlineToolConfigs` and `hotlineAgentConfig`. Returns the agent id.
 */
export async function deployAgent(options: DeployOptions): Promise<string> {
  const { admin, log } = options;
  let toolSecretId = options.toolSecretId;
  if (toolSecretId === undefined) {
    toolSecretId = await admin.createSecret(TOOL_SECRET_NAME, options.toolSecret);
    await options.save({ toolSecretId });
    log("created the tool secret in the ElevenLabs workspace");
  } else {
    // The local secret may have changed since (another store, a new init), and the
    // daemon checks every tool call against the local one: always send it again.
    await admin.updateSecret(toolSecretId, TOOL_SECRET_NAME, options.toolSecret);
    log("updated the tool secret in the ElevenLabs workspace");
  }
  const toolIds: Record<string, string> = { ...options.toolIds };
  const configs = hotlineToolConfigs({ publicUrl: options.publicUrl, toolSecretId });
  for (const config of configs) {
    const existing = toolIds[config.name];
    if (existing === undefined) {
      toolIds[config.name] = await admin.createTool(config);
      await options.save({ toolIds: { ...toolIds } });
      log(`created tool ${config.name}`);
    } else {
      await admin.updateTool(existing, config);
      log(`updated tool ${config.name}`);
    }
  }
  const agent = hotlineAgentConfig({
    toolIds: TOOL_NAMES.map((name) => toolIds[name] as string),
    ...(options.voiceId === undefined ? {} : { voiceId: options.voiceId }),
  });
  if (options.agentId === undefined) {
    const agentId = await admin.createAgent(agent);
    await options.save({ agentId });
    log(`created the agent (definition v${AGENT_DEFINITION_VERSION})`);
    return agentId;
  }
  await admin.updateAgent(options.agentId, agent);
  log(`updated the agent to definition v${AGENT_DEFINITION_VERSION}`);
  return options.agentId;
}
