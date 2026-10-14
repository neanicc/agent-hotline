// `hotline doctor`: checks the setup and prints one PASS, WARN or FAIL line per
// check, then INFO lines with the monthly cost estimate. Exits 1 when anything
// fails. It never prints a secret's value, only whether it is set, and shows the
// owner's number as its last four digits.
import {
  type Config,
  DEFAULT_VOICE_LLM,
  type SecretName,
  SecretName as SecretNames,
  type SecretStore,
} from "@hotline/core";
import {
  type AgentFlag,
  CODEX_TOOL_TIMEOUT_SECONDS,
  readClaudeMcp,
  readCodexMcp,
  readHooks,
} from "./agent-config.js";
import type { CliContext, Output } from "./cli.js";
import { costLines, readUsage } from "./cost.js";
import { ElevenLabsAdmin } from "./elevenlabs-admin.js";
import { JUDGE_CHOICES } from "./init.js";
import { agentConfigFiles, type ConfigLocation, configLocation, readConfigFile } from "./install.js";
import { keychainCheck, usesKeychain } from "./keychain-check.js";
import { fetchFor, lastFour, secretStoreFor } from "./setup.js";

/** `info` lines report, they never pass or fail: the cost estimate. */
export type CheckStatus = "pass" | "warn" | "fail" | "info";
export interface Check {
  status: CheckStatus;
  name: string;
  detail: string;
}

export function doctorUsage(): string {
  return [
    "Usage: hotline doctor [--home <dir>] [--command <path>] [--check-judge]",
    "",
    "Checks the config, secrets (set or not, never their values), the daemon and its",
    "token, the reply judge, the Claude Code and Codex installs and their timeouts,",
    "the deployed ElevenLabs agent and the webhook URL. With the Keychain store on",
    "macOS it also adds, reads back and deletes a throwaway Keychain item (never a",
    "real secret). Exits 1 if any check fails. Then prints an estimated monthly cost",
    "from the last 30 days in the local store, priced with the config's costs.* rate",
    "assumptions; it makes no network call for that.",
    "",
    "  --home <dir>       Look for agent configs under <dir> instead of your home folder",
    "  --command <path>   The --command the hooks were installed with, if any",
    "  --check-judge      Also ask the reply judge one tiny fixed question (one model call)",
  ].join("\n");
}

const SECRET_LABELS: Record<SecretName, string> = {
  "anthropic.apiKey": "Anthropic API key",
  "daemon.apiToken": "daemon API token",
  "elevenlabs.apiKey": "ElevenLabs API key",
  "elevenlabs.toolSecret": "ElevenLabs tool secret",
  "elevenlabs.webhookSecret": "ElevenLabs webhook secret",
  "twilio.accountSid": "Twilio account SID",
  "twilio.authToken": "Twilio auth token",
};

/** Seconds a hook should leave between its own wait and the agent's kill. */
const HOOK_MARGIN_SECONDS = 30;

function neededSecrets(config: Config): Set<SecretName> {
  const needed = new Set<SecretName>();
  if (config.voice.provider === "elevenlabs") {
    for (const name of ["elevenlabs.apiKey", "elevenlabs.toolSecret", "elevenlabs.webhookSecret"] as const) {
      needed.add(name);
    }
  }
  if (config.sms.provider === "twilio") {
    needed.add("twilio.accountSid");
    needed.add("twilio.authToken");
  }
  return needed;
}

async function secretChecks(
  config: Config,
  secrets: SecretStore,
): Promise<{ checks: Check[]; values: Map<SecretName, string> }> {
  const needed = neededSecrets(config);
  const checks: Check[] = [];
  const values = new Map<SecretName, string>();
  for (const name of SecretNames.options) {
    const value = await secrets.get(name);
    if (value !== undefined) values.set(name, value);
    const label = SECRET_LABELS[name];
    if (name === "daemon.apiToken") {
      checks.push(
        value === undefined
          ? {
              status: "warn",
              name: "secret",
              detail: `${label} not set yet; hotline daemon creates it on first start`,
            }
          : { status: "pass", name: "secret", detail: `${label} is set` },
      );
    } else if (needed.has(name)) {
      checks.push(
        value === undefined
          ? { status: "fail", name: "secret", detail: `${label} is not set; run hotline init --force` }
          : { status: "pass", name: "secret", detail: `${label} is set` },
      );
    }
  }
  return { checks, values };
}

async function daemonCheck(context: CliContext, config: Config, token: string | undefined): Promise<Check> {
  if (token === undefined) return { status: "warn", name: "daemon", detail: "not checked: no API token yet" };
  const url = `http://127.0.0.1:${config.daemon.port}/v1/health`;
  try {
    const response = await fetchFor(context)(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
      redirect: "error",
    });
    if (response.status === 401) {
      return {
        status: "fail",
        name: "daemon",
        detail: "the daemon refused the API token; restart hotline daemon",
      };
    }
    const body = (await response.json().catch(() => undefined)) as { ok?: unknown } | undefined;
    if (response.status === 200 && body?.ok === true) {
      return {
        status: "pass",
        name: "daemon",
        detail: `reachable on 127.0.0.1:${config.daemon.port}, token accepted`,
      };
    }
    return { status: "fail", name: "daemon", detail: `something else answers on port ${config.daemon.port}` };
  } catch {
    return {
      status: "warn",
      name: "daemon",
      detail: `not running on 127.0.0.1:${config.daemon.port}; start hotline daemon`,
    };
  }
}

async function agentChecks(
  agent: AgentFlag,
  where: ConfigLocation,
  config: Config,
  launcher: string,
): Promise<Check[]> {
  const name = agent === "claude" ? "claude code" : "codex";
  const scope = where.project === undefined ? "user" : "project";
  const files = agentConfigFiles(agent, where);
  const checks: Check[] = [];
  const askSeconds = config.policy.askTimeoutMinutes * 60;
  try {
    const hooksText = (await readConfigFile(files.hooks))?.text;
    const mcpText = (await readConfigFile(files.mcp))?.text;
    const hooks = readHooks(hooksText, files.hooks, agent, launcher);
    const claudeMcp = agent === "claude" ? readClaudeMcp(mcpText, files.mcp) : undefined;
    const codexMcp = agent === "codex" ? readCodexMcp(mcpText) : undefined;
    const installed = claudeMcp?.installed === true || codexMcp?.installed === true;
    if (hooks.length === 0 && !installed) {
      return scope === "user"
        ? [{ status: "warn", name, detail: `not installed (${scope}); run hotline install ${agent}` }]
        : [];
    }
    checks.push(
      installed
        ? { status: "pass", name, detail: `MCP server installed (${scope}, ${files.mcp})` }
        : { status: "warn", name, detail: `MCP server missing (${scope}); run hotline install ${agent}` },
    );
    for (const event of ["permission", "stop"] as const) {
      const found = hooks.filter((hook) => hook.event === event);
      if (found.length === 0) {
        checks.push({
          status: "warn",
          name,
          detail: `${event} hook missing (${scope}); run hotline install ${agent}`,
        });
      }
      for (const hook of found) {
        const what = `${event} hook waits ${hook.waitSeconds}s, timeout ${hook.timeoutSeconds}s`;
        if (hook.waitSeconds >= hook.timeoutSeconds) {
          checks.push({
            status: "fail",
            name,
            detail: `${what}: the wait must be below the timeout, or the answer is lost`,
          });
        } else if (hook.timeoutSeconds - hook.waitSeconds < HOOK_MARGIN_SECONDS) {
          checks.push({
            status: "warn",
            name,
            detail: `${what}: leave at least ${HOOK_MARGIN_SECONDS}s between them`,
          });
        } else if (hook.waitSeconds < askSeconds) {
          checks.push({
            status: "warn",
            name,
            detail: `${what}: shorter than policy.askTimeoutMinutes (${config.policy.askTimeoutMinutes} min), so late answers are lost`,
          });
        } else {
          checks.push({ status: "pass", name, detail: what });
        }
      }
    }
    if (codexMcp?.installed) {
      const seconds = codexMcp.toolTimeoutSeconds;
      checks.push(
        seconds > askSeconds
          ? {
              status: "pass",
              name,
              detail: `tool_timeout_sec ${seconds} is above the ask timeout (${askSeconds}s)`,
            }
          : {
              status: "fail",
              name,
              detail: `tool_timeout_sec ${seconds} is not above the ask timeout (${askSeconds}s); set it to ${CODEX_TOOL_TIMEOUT_SECONDS} or more`,
            },
      );
    }
    const timeoutMs = claudeMcp?.timeoutMs;
    if (timeoutMs !== undefined) {
      checks.push(
        timeoutMs > askSeconds * 1000
          ? {
              status: "warn",
              name,
              detail: `mcpServers.hotline.timeout is set; it is a hard limit, better removed`,
            }
          : {
              status: "fail",
              name,
              detail: `mcpServers.hotline.timeout (${timeoutMs} ms) cuts asks off before the ask timeout; remove it`,
            },
      );
    }
  } catch (error) {
    checks.push({ status: "fail", name, detail: (error as Error).message });
  }
  return checks;
}

function claudeIdleCheck(context: CliContext, config: Config): Check {
  const name = "claude code";
  const needed = config.policy.askTimeoutMinutes * 60_000;
  const value = context.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT;
  const ms = value === undefined || !/^\d{1,10}$/.test(value) ? undefined : Number(value);
  if (ms === undefined) {
    return {
      status: "warn",
      name,
      detail: `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT is not set here (default 30 min); set it above ${needed} ms, such as ${needed + 600_000}`,
    };
  }
  return ms > needed
    ? { status: "pass", name, detail: `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT ${ms} ms is above the ask timeout` }
    : {
        status: "fail",
        name,
        detail: `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT ${ms} ms is not above the ask timeout (${needed} ms)`,
      };
}

async function elevenLabsChecks(
  context: CliContext,
  config: Config,
  apiKey: string | undefined,
): Promise<Check[]> {
  const name = "elevenlabs";
  if (config.voice.provider !== "elevenlabs") {
    return [{ status: "pass", name, detail: "voice.provider is fake; no ElevenLabs agent needed" }];
  }
  const checks: Check[] = [];
  checks.push(
    config.voice.agentPhoneNumberId === undefined
      ? {
          status: "fail",
          name,
          detail: "voice.agentPhoneNumberId is not set; hotline init --force --agent-phone-number-id",
        }
      : { status: "pass", name, detail: "phone number id is set" },
  );
  const agentId = config.voice.agentId;
  if (agentId === undefined) {
    checks.push({ status: "fail", name, detail: "no agent yet; run hotline voice apply" });
    return checks;
  }
  if (apiKey === undefined) {
    checks.push({ status: "fail", name, detail: "cannot read the agent without the API key" });
    return checks;
  }
  const { AGENT_DEFINITION_VERSION, TOOL_NAMES, toolPath } = await import("@hotline/providers");
  try {
    const admin = new ElevenLabsAdmin(apiKey, fetchFor(context));
    const deployed = await admin.getAgent(agentId);
    const version = deployed.definitionVersion;
    checks.push(
      version === AGENT_DEFINITION_VERSION
        ? { status: "pass", name, detail: `agent definition v${version} is deployed` }
        : {
            status: "fail",
            name,
            detail: `the deployed agent is ${version === undefined ? "not a Hotline definition" : `definition v${version}`}, this hotline has v${AGENT_DEFINITION_VERSION}; run hotline voice apply`,
          },
    );
    // Another model changes cost and latency, not safety: the daemon checks every decision.
    const llm = config.voice.llm ?? DEFAULT_VOICE_LLM;
    checks.push(
      deployed.llm === llm
        ? { status: "pass", name, detail: `the agent runs on ${llm}` }
        : {
            status: "warn",
            name,
            detail: `the agent runs on ${deployed.llm ?? "ElevenLabs' default LLM"}, this config wants ${llm}; run hotline voice apply`,
          },
    );
    if (config.voice.voiceId !== undefined && deployed.voiceId !== config.voice.voiceId) {
      checks.push({
        status: "warn",
        name,
        detail: "the agent's voice differs from voice.voiceId; run hotline voice apply",
      });
    }
    // Without all four tools the agent cannot record an answer, check a PIN or read status.
    const recorded = config.voice.toolIds ?? {};
    const missing = TOOL_NAMES.filter((tool) => {
      const id = recorded[tool];
      return id === undefined || !deployed.toolIds.includes(id);
    });
    // A tool that still calls an old tunnel URL, or sends another secret, fails every
    // answer closed while everything else looks healthy.
    const stale: string[] = [];
    if (missing.length === 0) {
      const origin =
        config.tunnel.publicUrl === undefined ? undefined : new URL(config.tunnel.publicUrl).origin;
      for (const tool of TOOL_NAMES) {
        const deployedTool = await admin.getTool(recorded[tool] as string);
        const urlOk = origin !== undefined && deployedTool.url === `${origin}/hooks${toolPath(tool)}`;
        const secretOk =
          config.voice.toolSecretId !== undefined && deployedTool.secretId === config.voice.toolSecretId;
        if (!urlOk || !secretOk) stale.push(tool);
      }
    }
    if (stale.length > 0) {
      checks.push({
        status: "fail",
        name,
        detail: `the tools ${stale.join(", ")} call another URL or use another secret than this config; run hotline voice apply`,
      });
    }
    checks.push(
      missing.length === 0
        ? { status: "pass", name, detail: `the agent has all ${TOOL_NAMES.length} Hotline tools` }
        : {
            status: "fail",
            name,
            detail: `the agent lacks the tools ${missing.join(", ")} (or their ids are not recorded); run hotline voice apply`,
          },
    );
  } catch (error) {
    checks.push({ status: "fail", name, detail: (error as Error).message });
  }
  return checks;
}

/** The fixed reply `--check-judge` sends: no owner words, a clear yes the judge must agree to. */
export const JUDGE_CHECK_REPLY = "yes, go ahead";

/**
 * Which reply judge the daemon would use (HL-09d), found the way the daemon
 * finds it: a CLI on the PATH or a stored key, with no model call. With
 * `--check-judge`, one tiny call with a fixed reply that must come back agreed.
 */
async function judgeCheck(
  context: CliContext,
  config: Config,
  apiKey: string | undefined,
  callJudge: boolean,
): Promise<Check[]> {
  const name = "judge";
  const { nodeJudgeHost, selectReplyJudge } = await import("@hotline/daemon");
  const searchPath = context.env.PATH;
  const selection = await selectReplyJudge({
    choice: config.judge.backend,
    host: context.judgeHost ?? nodeJudgeHost(context.env),
    ...(searchPath === undefined ? {} : { searchPath }),
    ...(apiKey === undefined ? {} : { apiKey }),
    // Only the API backend uses it, and only for --check-judge.
    fetch: (url, init) => fetchFor(context)(url, init),
  });
  if (selection.backend === "none") {
    if (config.judge.backend === undefined) {
      return [
        {
          status: "warn",
          name,
          detail: `not chosen: nothing is sent, and a reply that is not a plain yes or no is texted; choose with hotline init --force --non-interactive --judge <${JUDGE_CHOICES}> (see docs/install.md)`,
        },
      ];
    }
    if (config.judge.backend === "off") {
      return [
        {
          status: "pass",
          name,
          detail: "off (judge.backend): a reply that is not a plain yes or no is texted",
        },
      ];
    }
    return [
      {
        status: "warn",
        name,
        detail: `none: ${selection.detail}; a spoken reply that is not a plain yes or no is texted instead (install Claude Code or Codex, see docs/install.md)`,
      },
    ];
  }
  const checks: Check[] = [
    {
      status: "pass",
      name,
      detail: `${selection.backend}: ${selection.detail}; only your short spoken reply is sent to it`,
    },
  ];
  if (callJudge) {
    const verdict = await selection.judge.judge([JUDGE_CHECK_REPLY]).catch(() => "failed");
    checks.push(
      verdict === "agreed"
        ? { status: "pass", name, detail: `a test question ("${JUDGE_CHECK_REPLY}") came back agreed` }
        : {
            status: "fail",
            name,
            detail: `a test question ("${JUDGE_CHECK_REPLY}") came back ${verdict}, not agreed; check the CLI's login (claude or codex) or the API key`,
          },
    );
  }
  return checks;
}

function webhookCheck(config: Config): Check {
  const needed = config.voice.provider === "elevenlabs" || config.sms.provider === "twilio";
  const url = config.tunnel.publicUrl;
  if (url !== undefined) return { status: "pass", name: "webhooks", detail: `public URL ${url}/hooks/*` };
  return needed
    ? {
        status: "fail",
        name: "webhooks",
        detail: "tunnel.publicUrl is not set; Twilio and ElevenLabs cannot reach the daemon",
      }
    : { status: "pass", name: "webhooks", detail: "no public URL needed with fake providers" };
}

export async function runChecks(
  context: CliContext,
  home: string | undefined,
  launcher = "hotline",
  callJudge = false,
): Promise<Check[]> {
  const { hotlinePaths, loadConfig, readAwayState } = await import("@hotline/daemon");
  const checks: Check[] = [];
  let paths: ReturnType<typeof hotlinePaths>;
  let config: Config;
  try {
    paths = hotlinePaths({ env: context.env, homeDir: context.homeDir });
    config = await loadConfig(paths.config);
  } catch (error) {
    return [{ status: "fail", name: "config", detail: (error as Error).message }];
  }
  checks.push({
    status: "pass",
    name: "config",
    detail: `${paths.config} (owner ${lastFour(config.owner.phoneNumber)}, PIN hash set)`,
  });
  const values = new Map<SecretName, string>();
  try {
    const secrets = await secretStoreFor(context, config.secrets.store, paths);
    const result = await secretChecks(config, secrets);
    checks.push(...result.checks);
    for (const [key, value] of result.values) values.set(key, value);
  } catch (error) {
    checks.push({ status: "fail", name: "secret", detail: (error as Error).message });
  }
  if (usesKeychain(context, config.secrets.store)) checks.push(await keychainCheck(context));
  checks.push(await daemonCheck(context, config, values.get("daemon.apiToken")));
  checks.push(...(await judgeCheck(context, config, values.get("anthropic.apiKey"), callJudge)));
  const away = await readAwayState(paths.away);
  checks.push(
    away.problem === undefined
      ? { status: "pass", name: "away", detail: `away mode is ${away.away ? "on" : "off"}` }
      : { status: "warn", name: "away", detail: `away mode reads as off: ${away.problem}` },
  );
  const scopes: ConfigLocation[] = [];
  try {
    const user = configLocation(context, home, false);
    const project = configLocation(context, home, true);
    scopes.push(user);
    // In the home folder itself, `.claude/settings.json` is the user file: check it once.
    const inHome = project.project === user.home;
    if (!inHome) scopes.push(project);
  } catch (error) {
    checks.push({ status: "fail", name: "agents", detail: (error as Error).message });
    return checks;
  }
  for (const agent of ["claude", "codex"] as const) {
    for (const scope of scopes) checks.push(...(await agentChecks(agent, scope, config, launcher)));
  }
  checks.push(claudeIdleCheck(context, config));
  checks.push(...(await elevenLabsChecks(context, config, values.get("elevenlabs.apiKey"))));
  checks.push(webhookCheck(config));
  const reading = await readUsage(paths.database, context.now?.() ?? new Date());
  for (const detail of costLines(reading, config.costs, paths.database)) {
    checks.push({ status: "info", name: "cost", detail });
  }
  return checks;
}

export async function doctorCommand(
  args: readonly string[],
  out: Output,
  context: CliContext,
): Promise<number> {
  let home: string | undefined;
  let launcher = "hotline";
  let callJudge = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      out.stdout(doctorUsage());
      return 0;
    }
    if (arg === "--check-judge") {
      callJudge = true;
      continue;
    }
    if (arg === "--home" && args[index + 1]) {
      home = args[++index];
      continue;
    }
    if (arg === "--command" && args[index + 1]) {
      launcher = args[++index] as string;
      continue;
    }
    out.stderr(`hotline doctor: unexpected "${arg}"\n\n${doctorUsage()}`);
    return 2;
  }
  const checks = await runChecks(context, home, launcher, callJudge);
  const width = Math.max(...checks.map((check) => check.name.length));
  for (const check of checks) {
    out.stdout(`${check.status.toUpperCase().padEnd(4)}  ${check.name.padEnd(width)}  ${check.detail}`);
  }
  const count = (status: CheckStatus) => checks.filter((check) => check.status === status).length;
  out.stdout(`doctor: ${count("pass")} pass, ${count("warn")} warn, ${count("fail")} fail`);
  return count("fail") > 0 ? 1 : 0;
}
