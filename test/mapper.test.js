import test from "node:test";
import assert from "node:assert/strict";
import { mapOpenCodeEvent } from "../bin/opencode-agenthook.js";

test("maps step events to llm hooks", () => {
  const pre = mapOpenCodeEvent({
    type: "step_start",
    sessionID: "ses_test",
    part: { id: "prt_1", messageID: "msg_1" },
  });
  assert.equal(pre[0].event_type, "PreLLMCall");

  const post = mapOpenCodeEvent({
    type: "step_finish",
    sessionID: "ses_test",
    part: { id: "prt_2", messageID: "msg_1", reason: "stop", tokens: { input: 1, output: 1 } },
  });
  assert.equal(post[0].event_type, "PostLLMCall");
});

test("maps text to model response", () => {
  const events = mapOpenCodeEvent(
    {
      type: "text",
      sessionID: "ses_test",
      part: { id: "prt_1", messageID: "msg_1", text: "hello" },
    },
    { reasoningText: "thinking" },
  );
  assert.equal(events[0].event_type, "ModelResponse");
  assert.equal(events[0].metadata.response_content, "hello");
  assert.equal(events[0].metadata.reasoning_content, "thinking");
});

test("extracts inline think tags as reasoning content", () => {
  const events = mapOpenCodeEvent({
    type: "text",
    sessionID: "ses_test",
    part: {
      id: "prt_1",
      messageID: "msg_1",
      text: "<think>private reasoning</think>\n\nanswer",
    },
  });
  assert.equal(events[0].metadata.reasoning_available, true);
  assert.equal(events[0].metadata.reasoning_content, "private reasoning");
  assert.equal(events[0].metadata.reasoning_source, "inline_think_tags");
});

test("maps completed tool events and task handoff", () => {
  const events = mapOpenCodeEvent({
    type: "tool_use",
    sessionID: "ses_test",
    part: {
      id: "prt_tool",
      messageID: "msg_1",
      callID: "call_1",
      tool: "task",
      state: {
        status: "completed",
        input: { subagent_type: "explorer" },
        output: "done",
        metadata: { sessionId: "ses_child" },
      },
    },
  });
  assert.equal(events[0].event_type, "PostToolUse");
  assert.equal(events[1].event_type, "AgentHandoff");
});
