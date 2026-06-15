import { QdrantClient, type KnowledgeHit } from "../core/qdrant";
import { EmbeddingService } from "../core/embedding";

/** 6 个 Collection 名 — 与原项目一致 */
const ALL_COLLECTIONS = [
  "gaokao_schools",
  "gaokao_majors",
  "gaokao_policies_rules",
  "gaokao_style_cases",
  "gaokao_province_data",
  "gaokao_score_rules",
] as const;

export class SearchKnowledgeTool {
  private qdrant: QdrantClient;
  private embed: EmbeddingService;

  constructor(qdrant: QdrantClient, embed: EmbeddingService) {
    this.qdrant = qdrant;
    this.embed = embed;
  }

  /** 在全部 6 个 collection 中检索，返回完整文件内容 */
  async query(query: string, topK = 3): Promise<KnowledgeHit[]> {
    const vector = await this.embed.embed(query);

    // 并行搜索所有 collection
    const results = await Promise.all(
      ALL_COLLECTIONS.map((col) =>
        this.qdrant.searchWithFullPage(col, vector, topK),
      ),
    );

    // 合并 + 按 score 排序 + 去重（同文件只保留最高分）
    const seen = new Set<string>();
    return results
      .flat()
      .sort((a, b) => b.score - a.score)
      .filter((hit) => {
        if (seen.has(hit.sourceFile)) return false;
        seen.add(hit.sourceFile);
        return true;
      })
      .slice(0, topK * 2); // 6 个 collection 各 topK，去重后取适量
  }
}
