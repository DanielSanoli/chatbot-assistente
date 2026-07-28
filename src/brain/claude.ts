import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages/messages";

export type ClaudeCreateParams = {
  model: string;
  system: string;
  messages: MessageParam[];
  tools: Tool[];
  max_tokens?: number;
};

export type ClaudeCreateResult = Anthropic.Messages.Message;

export type ClaudeClient = {
  createMessage: (params: ClaudeCreateParams) => Promise<ClaudeCreateResult>;
};

export function createAnthropicClient(apiKey: string): ClaudeClient {
  const client = new Anthropic({ apiKey });
  return {
    async createMessage(params) {
      return client.messages.create({
        model: params.model,
        system: params.system,
        messages: params.messages,
        tools: params.tools,
        max_tokens: params.max_tokens ?? 1024,
      });
    },
  };
}
