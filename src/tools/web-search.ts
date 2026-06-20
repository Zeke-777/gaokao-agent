// src/tools/web-search.ts
import { createSearchProvider } from "./search-web";
import type { Tool, ToolDefinition } from "./types";

export class WebSearchTool implements Tool {
  private provider: ReturnType<typeof createSearchProvider>;

  constructor(providerName: string, apiKey: string) {
    this.provider = createSearchProvider(providerName, apiKey);
  }

  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "search_web",
      description: "实时搜索互联网，获取最新分数线、招生政策、排名等信息。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索查询词" },
          limit: { type: "number", description: "返回结果数，默认5" },
        },
        required: ["query"],
      },
    },
  };

  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const query = String(args.query || "");
    const limit = Number(args.limit) || 5;
    const results = await this.provider.search(query, limit, signal);
    if (results.length === 0) return "搜索结果为空。";
    return results
      .map((r) => `[${r.title}](${r.url})\n${r.snippet}`)
      .join("\n\n");
  }
}
