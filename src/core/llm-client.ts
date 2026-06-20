// src/core/llm-client.ts
import type { LLMMessage, LLMResponse } from "./types";
// LLMResponse is used by chatStream return type
import type { ToolDefinition } from "../tools/types";

export class LLMClient {
  constructor(
    private apiKey: string,
    private baseUrl: string,
    private model: string,
  ) {}

  private async _post(body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LLM call failed: ${res.status} ${errText}`);
    }
    return res.json();
  }

  /** 生成会话标题 — 轻量调用，禁用思考模式 */
  async generateTitle(userPrompt: string): Promise<string> {
    const data = (await this._post({
      model: this.model,
      temperature: 0.3,
      max_tokens: 50,
      thinking: { type: "disabled" },
      messages: [
        { role: "system", content: "根据用户问题生成不超过15个字的标题。只输出标题，无标点。" },
        { role: "user", content: userPrompt },
      ],
    })) as { choices: Array<{ message: { content?: string } }> };
    const raw = data.choices[0]?.message?.content?.trim() || "";
    const cleaned = raw.replace(/^["""「」『』]|["""「」『』]$/g, "").replace(/^[标题：:]\s*/i, "").trim();
    return cleaned || userPrompt.slice(0, 15);
  }

  /** 流式调用 — 逐 token 回调，返回最终结果 */
  async chatStream(
    messages: LLMMessage[],
    tools: ToolDefinition[] | undefined,
    onToken: (token: string) => void,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      temperature: 0.45,
      messages,
      stream: true,
    };
    if (tools?.length) {
      body.tools = tools;
    }

    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LLM call failed: ${res.status} ${errText}`);
    }

    if (!res.body) throw new Error("LLM response body is null");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason = "";

    // tool_calls 累积器：index → { id, name, arguments }
    const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index: number;
                id?: string;
                type?: "function";
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string;
          }>;
        };

        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }

        const delta = choice.delta;
        if (!delta) continue;

        // 文本内容 → 逐 token 回调
        if (delta.content) {
          content += delta.content;
          onToken(delta.content);
        }

        // 工具调用 → 累积参数
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCallMap.get(tc.index);
            if (existing) {
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
            } else {
              toolCallMap.set(tc.index, {
                id: tc.id || "",
                name: tc.function?.name || "",
                arguments: tc.function?.arguments || "",
              });
            }
          }
        }
      }
    }

    // 组装 toolCalls
    const toolCalls = [...toolCallMap.values()].map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: (() => {
        try { return JSON.parse(tc.arguments); }
        catch { console.warn("tool_calls JSON 解析失败，传空对象:", tc.arguments.slice(0, 100)); return {}; }
      })(),
    }));

    return { content, toolCalls, finishReason };
  }
}
