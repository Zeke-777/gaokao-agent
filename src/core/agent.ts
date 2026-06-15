import { SearchKnowledgeTool } from "../tools/search-knowledge";
import type { SearchProvider } from "../tools/search-web/types";
import { SYSTEM_PROMPT } from "../prompts/system";
import { buildMemoryPrompt } from "./memory";
import { loadFullHistory, saveMessage } from "./session";

export interface ProgressEvent {
  type: "thinking" | "tool_call" | "tool_result" | "done";
  message: string;
  tool?: { name: string; args: Record<string, unknown> };
  result?: { preview: string; fullLength: number };
  ms?: number;
}

interface AgentConfig {
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  searchKnowledge: SearchKnowledgeTool;
  searchProvider: SearchProvider;
}

interface ToolCall {
  id: string;
  name: "search_knowledge" | "search_web";
  arguments: Record<string, unknown>;
}

interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export class GaokaoAgent {
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  /** 执行工具调用 */
  private async executeToolCall(call: ToolCall): Promise<string> {
    switch (call.name) {
      case "search_knowledge": {
        const query = String(call.arguments.query || "");
        const topK = Number(call.arguments.topK) || 3;
        const hits = await this.config.searchKnowledge.query(query, topK);
        if (hits.length === 0) return "知识库中未找到相关内容。";
        return hits
          .map(
            (h) =>
              `[文件: ${h.sourceFile}] [相似度: ${h.score.toFixed(2)}]\n${h.fullContent}`,
          )
          .join("\n\n---\n\n");
      }
      case "search_web": {
        const query = String(call.arguments.query || "");
        const limit = Number(call.arguments.limit) || 5;
        const results = await this.config.searchProvider.search(query, limit);
        if (results.length === 0) return "搜索结果为空。";
        return results
          .map((r) => `[${r.title}](${r.url})\n${r.snippet}`)
          .join("\n\n");
      }
      default:
        return "未知工具";
    }
  }

  /** 构建消息列表 */
  private buildMessages(
    sessionId: string,
    userPrompt: string,
  ): LLMMessage[] {
    const messages: LLMMessage[] = [];

    // 1. 系统提示词
    messages.push({ role: "system", content: SYSTEM_PROMPT });

    // 2. 注入本会话记忆
    const memoryPrompt = buildMemoryPrompt(sessionId);
    if (memoryPrompt) {
      messages.push({ role: "system", content: memoryPrompt });
    }

    // 3. 加载历史对话
    const history = loadFullHistory(sessionId);
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
      }
    }

    // 4. 当前用户提问
    messages.push({ role: "user", content: userPrompt });

    return messages;
  }

  private toolsDef = [
    {
      type: "function" as const,
      function: {
        name: "search_knowledge",
        description:
          "在高考知识库中语义检索。包含院校介绍、专业分析、政策规则、填报案例。返回完整文档内容。",
        parameters: {
          type: "object" as const,
          properties: {
            query: { type: "string", description: "自然语言搜索查询" },
            topK: { type: "number", description: "返回结果数，默认3" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "search_web",
        description: "实时搜索互联网，获取最新分数线、招生政策、排名等信息。",
        parameters: {
          type: "object" as const,
          properties: {
            query: { type: "string", description: "搜索查询词" },
            limit: { type: "number", description: "返回结果数，默认5" },
          },
          required: ["query"],
        },
      },
    },
  ];

  /** 调用 LLM */
  private async callLLM(
    messages: LLMMessage[],
    withTools = true,
  ): Promise<{
    content: string;
    toolCalls: ToolCall[];
    finishReason: string;
  }> {
    const body: Record<string, unknown> = {
      model: this.config.llmModel,
      temperature: 0.45,
      messages,
    };
    if (withTools) {
      body.tools = this.toolsDef;
    }

    const res = await fetch(
      `${this.config.llmBaseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.llmApiKey}`,
        },
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LLM call failed: ${res.status} ${errText}`);
    }

    const data = (await res.json()) as {
      choices: Array<{
        finish_reason?: string;
        message: {
          content?: string;
          tool_calls?: Array<{
            id: string;
            type: "function";
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };

    const msg = data.choices[0]!.message;
    return {
      content: msg.content || "",
      toolCalls: (msg.tool_calls || []).map((tc) => ({
        id: tc.id,
        name: tc.function.name as ToolCall["name"],
        arguments: JSON.parse(tc.function.arguments),
      })),
      finishReason: data.choices[0]!.finish_reason || "",
    };
  }

  /** 进度回调 */
  onProgress?: (event: ProgressEvent) => void;

  /** 一次完整对话 */
  async chat(
    userPrompt: string,
    sessionId: string,
  ): Promise<string> {
    const messages = this.buildMessages(sessionId, userPrompt);
    const maxRounds = 5;
    const startTime = Date.now();

    for (let round = 0; round < maxRounds; round++) {
      this.onProgress?.({ type: "thinking", message: `思考中... (第 ${round + 1} 轮)` });
      const llmStart = Date.now();
      const { content, toolCalls, finishReason } = await this.callLLM(messages);
      const llmMs = Date.now() - llmStart;

      // 没有工具调用 → 最终回答
      if (toolCalls.length === 0) {
        const totalMs = Date.now() - startTime;
        this.onProgress?.({ type: "done", message: `完成 (${(totalMs / 1000).toFixed(1)}s, ${llmMs}ms LLM)` });
        saveMessage(sessionId, "user", userPrompt);
        saveMessage(sessionId, "assistant", content);
        return content;
      }

      // 展示工具调用
      for (const tc of toolCalls) {
        this.onProgress?.({
          type: "tool_call",
          message: `${tc.name}`,
          tool: { name: tc.name, args: tc.arguments },
        });
      }

      messages.push({
        role: "assistant",
        content: "",
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      });

      for (const tc of toolCalls) {
        const toolStart = Date.now();
        const result = await this.executeToolCall(tc);
        const toolMs = Date.now() - toolStart;
        const preview = result.slice(0, 300).replace(/\n/g, " ");
        this.onProgress?.({
          type: "tool_result",
          message: preview + (result.length > 300 ? "..." : ""),
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

    // 达到最大轮数 → 最后一次不带 tools 强制生成回答
    this.onProgress?.({ type: "thinking", message: "达到最大搜索轮数，正在汇总..." });
    const final = await this.callLLM(messages, false);
    const totalMs = Date.now() - startTime;
    this.onProgress?.({ type: "done", message: `完成 (${(totalMs / 1000).toFixed(1)}s)` });
    saveMessage(sessionId, "user", userPrompt);
    saveMessage(sessionId, "assistant", final.content);
    return final.content || "抱歉，无法生成回答。";
  }

  /** 轻量 LLM 调用（用于记忆提取等） */
  async lightCall(systemPrompt: string, userPrompt: string): Promise<string> {
    const res = await fetch(
      `${this.config.llmBaseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.llmApiKey}`,
        },
        body: JSON.stringify({
          model: this.config.llmModel,
          temperature: 0,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      },
    );
    if (!res.ok) throw new Error(`Light LLM call failed: ${res.status}`);
    const data = (await res.json()) as {
      choices: Array<{ message: { content?: string } }>;
    };
    return data.choices[0]!.message!.content || "";
  }
}
