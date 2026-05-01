#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_BUS = "http://localhost:18800/event";
const SOURCE = process.env.HOOKBUS_SOURCE || "opencode-agenthook";
const PUBLISHER = "uk.agenticthinking.publisher.opencode";

function uuid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function sessionFrom(event, fallback) {
  return event?.sessionID || event?.part?.sessionID || fallback;
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
      host: os.hostname(),
      ...metadata,
    },
  };
}

function extractThinkTags(text) {
  const value = String(text || "");
  const matches = [...value.matchAll(/<think>([\s\S]*?)<\/think>/gi)];
  return matches.map((match) => match[1].trim()).filter(Boolean).join("\n\n");
}

export function mapOpenCodeEvent(event, context = {}) {
  const sessionID = sessionFrom(event, context.sessionID);
  const correlationID = context.correlationID || sessionID || uuid();
  const part = event.part || {};
  const mapped = [];

  if (event.type === "step_start") {
    mapped.push({
      ...baseEnvelope("PreLLMCall", sessionID, correlationID, {
        opencode_event: event.type,
        part_id: part.id,
        message_id: part.messageID,
      }),
      tool_name: "llm.chat",
      tool_input: {},
    });
  }

  if (event.type === "step_finish") {
    mapped.push({
      ...baseEnvelope("PostLLMCall", sessionID, correlationID, {
        opencode_event: event.type,
        part_id: part.id,
        message_id: part.messageID,
        finish_reason: part.reason,
        cost: part.cost,
        tokens: part.tokens,
        reasoning_chars: context.reasoningText ? context.reasoningText.length : 0,
        reasoning_available: Boolean(context.reasoningText),
      }),
      tool_name: "llm.chat",
      tool_input: {},
    });
  }

  if (event.type === "text") {
    const inlineReasoning = extractThinkTags(part.text);
    const reasoningText = context.reasoningText || inlineReasoning;
    mapped.push({
      ...baseEnvelope("ModelResponse", sessionID, correlationID, {
        opencode_event: event.type,
        part_id: part.id,
        message_id: part.messageID,
        response_content: part.text || "",
        response_chars: (part.text || "").length,
        reasoning_available: Boolean(reasoningText),
        reasoning_content: reasoningText || undefined,
        reasoning_chars: reasoningText ? reasoningText.length : 0,
        reasoning_source: inlineReasoning && !context.reasoningText ? "inline_think_tags" : undefined,
      }),
      tool_name: "model.response",
      tool_input: {},
    });
  }

  if (event.type === "reasoning") {
    mapped.push({
      ...baseEnvelope("ModelResponse", sessionID, correlationID, {
        opencode_event: event.type,
        part_id: part.id,
        message_id: part.messageID,
        reasoning_available: true,
        reasoning_content: part.text || "",
        reasoning_chars: (part.text || "").length,
      }),
      tool_name: "model.reasoning",
      tool_input: {},
    });
  }

  if (event.type === "tool_use") {
    const tool = part.tool || "tool";
    const state = part.state || {};
    const toolInput = state.input || {};
    const status = state.status || "completed";

    mapped.push({
      ...baseEnvelope("PostToolUse", sessionID, correlationID, {
        opencode_event: event.type,
        part_id: part.id,
        message_id: part.messageID,
        call_id: part.callID,
        tool_status: status,
        tool_result: state.output,
        tool_error: state.error,
        provider_executed: Boolean(part.metadata?.providerExecuted),
      }),
      tool_name: tool,
      tool_input: toolInput,
    });

    if (tool === "task" && state?.metadata?.sessionId) {
      mapped.push({
        ...baseEnvelope("AgentHandoff", sessionID, correlationID, {
          opencode_event: event.type,
          from_agent: "opencode",
          to_agent: state.input?.subagent_type,
          child_session_id: state.metadata.sessionId,
          call_id: part.callID,
        }),
        tool_name: "agent.handoff",
        tool_input: {
          from_agent: "opencode",
          to_agent: state.input?.subagent_type,
        },
      });
    }
  }

  if (event.type === "error") {
    mapped.push({
      ...baseEnvelope("ErrorOccurred", sessionID, correlationID, {
        opencode_event: event.type,
        error: event.error,
      }),
      tool_name: "error",
      tool_input: {},
    });
  }

  return mapped;
}

async function publish(event) {
  const url = process.env.HOOKBUS_URL || DEFAULT_BUS;
  const token = process.env.HOOKBUS_TOKEN || "";
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(Number(process.env.HOOKBUS_TIMEOUT || 10000)),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HookBus ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json().catch(() => ({}));
}

async function publishAll(events) {
  for (const event of events) {
    try {
      await publish(event);
    } catch (error) {
      if (process.env.HOOKBUS_FAIL_MODE === "closed") throw error;
      if (process.env.HOOKBUS_DEBUG) {
        console.error(`[opencode-agenthook] publish failed: ${error.message}`);
      }
    }
  }
}

function parseArgs(argv) {
  const args = [...argv];
  const passthrough = [];
  let sawRun = false;
  let prompt = [];
  let skipNext = false;

  for (let i = 0; i < args.length; i++) {
    if (skipNext) {
      skipNext = false;
      passthrough.push(args[i]);
      continue;
    }
    const arg = args[i];
    if (arg === "--") {
      passthrough.push(...args.slice(i + 1));
      break;
    }
    if (arg === "--format") {
      skipNext = true;
      continue;
    }
    passthrough.push(arg);
    if (arg === "run") sawRun = true;
    if (sawRun && !arg.startsWith("-") && arg !== "run") prompt.push(arg);
  }

  return { passthrough, prompt: prompt.join(" ") };
}

async function main() {
  const { passthrough, prompt } = parseArgs(process.argv.slice(2));
  const sessionID = `opencode-${uuid()}`;
  const correlationID = uuid();
  const command = passthrough[0] === "run" ? passthrough : ["run", ...passthrough];
  const finalArgs = [command[0], "--format", "json", ...command.slice(1)];

  await publishAll([
    {
      ...baseEnvelope("SessionStart", sessionID, correlationID, { opencode_adapter_session: true }),
      tool_name: "session.start",
      tool_input: {},
    },
    {
      ...baseEnvelope("UserPromptSubmit", sessionID, correlationID, { prompt }),
      tool_name: "user.prompt",
      tool_input: { prompt },
    },
  ]);

  const child = spawn("opencode", finalArgs, { stdio: ["inherit", "pipe", "inherit"], env: process.env });
  let buffer = "";
  let observedSession = sessionID;
  let reasoningText = "";

  child.stdout.on("data", async (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      process.stdout.write(line + "\n");
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.sessionID) observedSession = parsed.sessionID;
      if (parsed.type === "reasoning" && parsed.part?.text) reasoningText += parsed.part.text;
      if (parsed.type === "tool_use" && process.env.OPENCODE_AGENTHOOK_PLUGIN_TOOLS !== "0") continue;
      await publishAll(mapOpenCodeEvent(parsed, { sessionID: observedSession, correlationID, reasoningText }));
    }
  });

  const code = await new Promise((resolve) => child.on("close", resolve));

  await publishAll([
    {
      ...baseEnvelope("SessionEnd", observedSession, correlationID, {
        exit_code: code,
      }),
      tool_name: "session.end",
      tool_input: {},
    },
  ]);

  process.exit(code ?? 0);
}

const invoked = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  main().catch((error) => {
    console.error(`[opencode-agenthook] ${error.message}`);
    process.exit(1);
  });
}
