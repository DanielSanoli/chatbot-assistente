import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import type { ClaudeClient, ClaudeCreateResult } from "../../src/brain/claude.js";

type StepFn = (ctx: {
  messages: MessageParam[];
  callIndex: number;
}) => ClaudeCreateResult;

export function createScriptedClaude(steps: StepFn[]): ClaudeClient {
  let callIndex = 0;
  return {
    async createMessage(params) {
      const step = steps[Math.min(callIndex, steps.length - 1)];
      if (!step) {
        throw new Error("claude mock sem steps");
      }
      const result = step({ messages: params.messages, callIndex });
      callIndex += 1;
      return result;
    },
  };
}

export function textResult(text: string): ClaudeCreateResult {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as ClaudeCreateResult;
}

export function toolUseResult(
  name: string,
  input: Record<string, unknown>,
  id = "tool_1",
): ClaudeCreateResult {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test",
    content: [
      {
        type: "tool_use",
        id,
        name,
        input,
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as ClaudeCreateResult;
}

/** Extrai o texto do último user message simples. */
export function lastUserText(messages: MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "user" && typeof msg.content === "string") {
      return msg.content;
    }
  }
  return "";
}
