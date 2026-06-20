// src/core/types.ts
/** SSE 进度事件（CLI/服务端/前端共用） */
export interface ProgressEvent {
  type: "thinking" | "token" | "tool_call" | "tool_result" | "done";
  message: string;
  tool?: { name: string; args: Record<string, unknown> };
  result?: { preview: string; fullLength: number };
  ms?: number;
}

/** LLM 消息格式 */
export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** LLM 工具调用 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** LLM 调用结果 */
export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
}

/** 进度回调 */
export type ProgressCallback = (event: ProgressEvent) => void;
