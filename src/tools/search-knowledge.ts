import { QdrantClient } from "../core/qdrant";
import { EmbeddingService } from "../core/embedding";
import type { Tool, ToolDefinition } from "./types";

/** LLM 可选择的集合 key → Qdrant 集合名 */
const COLLECTION_MAP: Record<string, string> = {
  schools: "gaokao_schools",
  majors: "gaokao_majors",
  policies_rules: "gaokao_policies_rules",
  province_data: "gaokao_province_data",
  style_cases: "gaokao_style_cases",
};

/** 全部 Qdrant 集合名 */
const ALL_COLLECTIONS = Object.values(COLLECTION_MAP);

export class KnowledgeSearchTool implements Tool {
  constructor(
    private qdrant: QdrantClient,
    private embed: EmbeddingService,
  ) {}

  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "search_knowledge",
      description:
        "在高考知识库中语义检索。包含院校介绍、专业分析、政策规则、填报案例。返回完整文档内容。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "自然语言搜索查询" },
          topK: { type: "number", description: "返回结果数，默认5" },
          collections: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "schools",
                "majors",
                "policies_rules",
                "province_data",
                "style_cases",
              ],
            },
            description: "指定检索的知识库分类。不确定时全选或不传。",
          },
        },
        required: ["query"],
      },
    },
  };

  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const query = String(args.query || "");
    const topK = Number(args.topK) || 5;
    const collections = args.collections as string[] | undefined;

    const vector = await this.embed.embed(query, signal);
    const targetCollections = collections?.length
      ? collections.map((k) => COLLECTION_MAP[k]).filter((v): v is string => !!v)
      : ALL_COLLECTIONS;

    const results = await Promise.all(
      targetCollections.map((col) => this.qdrant.searchWithFullPage(col, vector, topK, signal)),
    );

    const seen = new Set<string>();
    const hits = results
      .flat()
      .sort((a, b) => b.score - a.score)
      .filter((hit) => {
        if (seen.has(hit.sourceFile)) return false;
        seen.add(hit.sourceFile);
        return true;
      })
      .slice(0, topK * 2);

    if (hits.length === 0) return "知识库中未找到相关内容。";
    return hits
      .map(
        (h) =>
          `[文件: ${h.sourceFile}] [相似度: ${h.score.toFixed(2)}]\n${h.fullContent}`,
      )
      .join("\n\n---\n\n");
  }

}
