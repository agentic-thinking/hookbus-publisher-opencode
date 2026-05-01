import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BUS = "http://localhost:18800/event";
const PUBLISHER = "uk.agenticthinking.publisher.opencode";
const emitted = new Set();

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const FILE_ENV = loadEnvFile(join(PLUGIN_DIR, "hookbus.env"));
const cfg = (name, fallback = "") => process.env[name] || FILE_ENV[name] || fallback;
const SOURCE = cfg("HOOKBUS_SOURCE", "opencode-agenthook");

function uuid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function baseEnvelope(eventType, sessionID, correlationID, metadata = {}) {
  return {
    schema_version: 1,
    event_id: uuid(),
    event_type: eventType,
    timestamp: nowIso(),
    source: SOURCE,
    session_id: sessionID,
    correlation_id: correlationID,
    metadata: {
      publisher: PUBLISHER,
      agenthook_standard: "https://agenthook.org",
      runtime: "opencode",
      plugin: "opencode-agenthook-plugin",
      ...metadata,
    },
  };
}

function hookbusToken() {
  if (cfg("HOOKBUS_TOKEN", "")) return cfg("HOOKBUS_TOKEN", "");
  try {
    return execFileSync("docker", ["exec", "hookbus-light-hookbus-1", "cat", "/root/.hookbus/.token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
  } catch {
    return "";
  }
}

async function publish(event) {
  const url = cfg("HOOKBUS_URL", DEFAULT_BUS);
  const token = hookbusToken();
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(Number(cfg("HOOKBUS_TIMEOUT", "10000"))),
  });
  const body = await res.json().catch(async () => {
    const text = await res.text().catch(() => "");
    return text ? { reason: text } : {};
  });
  if (!res.ok) throw new Error(`HookBus ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

function decisionOf(response) {
  return String(response?.decision || response?.verdict || "allow").toLowerCase();
}

function reasonOf(response) {
  return response?.reason || response?.message || "HookBus policy decision";
}

function textFromParts(parts = []) {
  return parts
    .map((part) => {
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function eventProperties(input) {
  return input?.event?.properties || input?.event || {};
}

function eventType(input) {
  return input?.event?.type || input?.type || "";
}

async function publishOnce(key, fn) {
  if (emitted.has(key)) return;
  emitted.add(key);
  return fn();
}

async function publishObserved(eventTypeName, sessionID, metadata = {}, fields = {}) {
  if (!sessionID && eventTypeName !== "ErrorOccurred") return;
  return publish({
    ...baseEnvelope(eventTypeName, sessionID, metadata.correlation_id || uuid(), metadata),
    ...fields,
  });
}

async function publishTool(eventType, input, output) {
  const sessionID = input.sessionID;
  const callID = input.callID || uuid();
  const envelope = {
    ...baseEnvelope(eventType, sessionID, callID, {
      call_id: callID,
      opencode_plugin_hook: eventType === "PreToolUse" ? "tool.execute.before" : "tool.execute.after",
      tool_result: eventType === "PostToolUse" ? output : undefined,
    }),
    tool_name: input.tool,
    tool_input: input.args || output?.args || {},
  };
  return publish(envelope);
}

export default async function AgentHookHookBusPlugin() {
  return {
    "chat.message": async (input, output) => {
      const prompt = textFromParts(output?.parts);
      await publishObserved(
        "UserPromptSubmit",
        input.sessionID,
        {
          opencode_plugin_hook: "chat.message",
          agent: input.agent,
          model: input.model,
          message_id: input.messageID,
          variant: input.variant,
        },
        { prompt },
      ).catch((error) => {
        if (cfg("HOOKBUS_DEBUG", "")) console.error(`[opencode-agenthook-plugin] chat.message publish failed: ${error.message}`);
        if (cfg("HOOKBUS_FAIL_MODE", "open") === "closed") throw error;
      });
    },

    "chat.params": async (input, output) => {
      await publishObserved("PreLLMCall", input.sessionID, {
        opencode_plugin_hook: "chat.params",
        agent: input.agent,
        provider: input.provider?.id || input.provider?.providerID,
        model: input.model?.id || input.model?.modelID,
        message_id: input.message?.id,
        temperature: output?.temperature,
        max_output_tokens: output?.maxOutputTokens,
      }).catch((error) => {
        if (cfg("HOOKBUS_DEBUG", "")) console.error(`[opencode-agenthook-plugin] chat.params publish failed: ${error.message}`);
        if (cfg("HOOKBUS_FAIL_MODE", "open") === "closed") throw error;
      });
    },

    event: async (input) => {
      const type = eventType(input);
      const props = eventProperties(input);
      const sessionID = props.sessionID || props.session?.id || props.info?.sessionID;

      try {
        if (type === "session.created") {
          await publishObserved("SessionStart", sessionID || props.id, {
            opencode_plugin_hook: "event",
            opencode_event_type: type,
          });
        }

        if (type === "session.error") {
          await publishObserved(
            "ErrorOccurred",
            sessionID,
            {
              opencode_plugin_hook: "event",
              opencode_event_type: type,
              error: props.error,
            },
          );
        }

        if (type === "message.updated") {
          const message = props.info || props.message || {};
          if (message.role === "assistant") {
            await publishOnce(`model:${message.id}`, () =>
              publishObserved("ModelResponse", sessionID || message.sessionID, {
                opencode_plugin_hook: "event",
                opencode_event_type: type,
                message_id: message.id,
              }),
            );
            await publishOnce(`postllm:${message.id}`, () =>
              publishObserved("PostLLMCall", sessionID || message.sessionID, {
                opencode_plugin_hook: "event",
                opencode_event_type: type,
                message_id: message.id,
              }),
            );
          }
        }

        if (type === "message.part.updated") {
          const part = props.part || {};
          if (part.type === "reasoning") {
            await publishOnce(`reasoning:${part.id || props.partID}`, () =>
              publishObserved("ModelResponse", sessionID || part.sessionID || props.sessionID, {
                opencode_plugin_hook: "event",
                opencode_event_type: type,
                message_id: part.messageID || props.messageID,
                part_id: part.id || props.partID,
                reasoning_available: true,
                reasoning_content: part.text,
              }),
            );
          }
        }
      } catch (error) {
        if (cfg("HOOKBUS_DEBUG", "")) console.error(`[opencode-agenthook-plugin] event publish failed: ${error.message}`);
        if (cfg("HOOKBUS_FAIL_MODE", "open") === "closed") throw error;
      }
    },

    "tool.execute.before": async (input, output) => {
      const response = await publishTool("PreToolUse", input, output).catch((error) => {
        if (cfg("HOOKBUS_DEBUG", "")) console.error(`[opencode-agenthook-plugin] pre publish failed: ${error.message}`);
        if (cfg("HOOKBUS_FAIL_MODE", "open") === "closed") throw error;
        return { decision: "allow" };
      });

      const decision = decisionOf(response);
      if (decision === "deny" || decision === "ask") {
        throw new Error(reasonOf(response));
      }
    },

    "tool.execute.after": async (input, output) => {
      await publishTool("PostToolUse", input, output).catch((error) => {
        if (cfg("HOOKBUS_DEBUG", "")) console.error(`[opencode-agenthook-plugin] post publish failed: ${error.message}`);
        if (cfg("HOOKBUS_FAIL_MODE", "open") === "closed") throw error;
      });
    },
  };
}
