// src/core/message-builder.ts
import type { LLMMessage } from "./types";
import { SYSTEM_PROMPT } from "../prompts/system";
import type { MessageRepo } from "./repo/message-repo";

export interface BuildMessagesInput {
  sessionId: string;
  userPrompt: string;
  messageRepo: MessageRepo;
}

export function buildMessages(input: BuildMessagesInput): LLMMessage[] {
  const messages: LLMMessage[] = [];

  // 1. 系统提示词
  messages.push({ role: "system", content: SYSTEM_PROMPT });

  // 2. 加载历史对话
  const history = input.messageRepo.loadHistory(input.sessionId);
  for (const msg of history) {
    if (msg.role === "user") {
      messages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      if (msg.tool_calls) {
        try {
          messages.push({
            role: "assistant",
            content: msg.content,
            tool_calls: JSON.parse(msg.tool_calls),
          });
        } catch {
          messages.push({ role: "assistant", content: msg.content });
        }
      } else {
        messages.push({ role: "assistant", content: msg.content });
      }
    } else if (msg.role === "tool") {
      messages.push({
        role: "tool",
        content: msg.content,
        tool_call_id: msg.tool_call_id || "",
      });
    }
  }

  // 3. 当前用户提问
  messages.push({ role: "user", content: input.userPrompt });

  return messages;
}
