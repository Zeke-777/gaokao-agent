// src/core/chat-loop.ts
import type { LLMMessage, ProgressCallback } from "./types";
import type { LLMClient } from "./llm-client";
import type { ToolExecutor } from "./tool-executor";

export class ChatLoop {
  constructor(
    private llm: LLMClient,
    private tools: ToolExecutor,
    private maxRounds = 5,
  ) {}

  async run(
    messages: LLMMessage[],
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<{ answer: string; newMessages: LLMMessage[] }> {
    const startTime = Date.now();
    // -1: 包含 buildMessages 最后 push 的 user 消息
    const before = messages.length - 1;

    for (let round = 0; round < this.maxRounds; round++) {
      signal?.throwIfAborted();
      onProgress?.({ type: "thinking", message: `思考中... (第 ${round + 1} 轮)` });
      const llmStart = Date.now();

      // 流式调用 LLM — 文本生成时逐 token 推送
      const { content, toolCalls } = await this.llm.chatStream(
        messages,
        this.tools.getDefinitions(),
        (token) => onProgress?.({ type: "token", message: token }),
        signal,
      );
      const llmMs = Date.now() - llmStart;

      // 无工具调用 → 最终回答
      if (toolCalls.length === 0) {
        messages.push({ role: "assistant", content: content || "" });
        const totalMs = Date.now() - startTime;
        onProgress?.({ type: "done", message: `完成 (${(totalMs / 1000).toFixed(1)}s, ${llmMs}ms LLM)` });
        return { answer: content || "抱歉，无法生成回答。", newMessages: messages.slice(before) };
      }

      // 通知工具调用
      for (const tc of toolCalls) {
        onProgress?.({
          type: "tool_call",
          message: tc.name,
          tool: { name: tc.name, args: tc.arguments },
        });
      }

      // 添加 assistant 消息（含 tool_calls + 可能的推理文本）
      messages.push({
        role: "assistant",
        content: content || "",
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      });

      // 执行工具并添加结果
      for (const tc of toolCalls) {
        signal?.throwIfAborted();
        const toolStart = Date.now();
        let result: string;
        try {
          result = await this.tools.execute(tc.name, tc.arguments, signal);
        } catch (err) {
          result = `工具执行错误: ${err instanceof Error ? err.message : String(err)}`;
        }
        const toolMs = Date.now() - toolStart;
        const preview = result.slice(0, 300).replace(/\n/g, " ");
        onProgress?.({
          type: "tool_result",
          message: preview + (result.length > 300 ? "..." : ""),
          tool: { name: tc.name, args: tc.arguments },
          result: { preview, fullLength: result.length },
          ms: toolMs,
        });
        messages.push({
          role: "tool",
          content: result,
          tool_call_id: tc.id,
        });
      }
    }

    // 达到最大轮数 → 注入系统消息强制直接回答，不带 tools
    onProgress?.({ type: "thinking", message: "达到最大搜索轮数，正在汇总..." });
    messages.push({
      role: "system",
      content: "你已经进行了足够多的搜索。不要再调用任何工具，直接根据已有信息给出完整回答。",
    });
    const final = await this.llm.chatStream(
      messages,
      undefined,
      (token) => onProgress?.({ type: "token", message: token }),
      signal,
    );
    messages.push({ role: "assistant", content: final.content || "" });
    const totalMs = Date.now() - startTime;
    onProgress?.({ type: "done", message: `完成 (${(totalMs / 1000).toFixed(1)}s)` });
    return { answer: final.content || "抱歉，无法生成回答。", newMessages: messages.slice(before) };
  }
}
