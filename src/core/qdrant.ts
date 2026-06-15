import * as fs from "node:fs";
import * as path from "node:path";

/** Qdrant 返回的 point */
interface QdrantPoint {
  id: string;
  score: number;
  payload?: Record<string, unknown>;
}

/** 检索单个结果 */
export interface KnowledgeHit {
  score: number;
  sourceFile: string; // 如 "04_专业库/计算机科学与技术.md"
  /** 完整文件内容 */
  fullContent: string;
  /** Qdrant 中存储的片段文本（用于排序参考） */
  snippet: string;
}

export class QdrantClient {
  private baseUrl: string;
  /** staging 目录 — 向量库源文件所在位置 */
  private stagingRoot: string;

  constructor(
    baseUrl = "http://127.0.0.1:6333",
    stagingRoot: string,
  ) {
    this.baseUrl = baseUrl;
    this.stagingRoot = stagingRoot;
  }

  /** 搜索单个 collection */
  async search(
    collection: string,
    vector: number[],
    limit = 3,
  ): Promise<QdrantPoint[]> {
    const res = await fetch(
      `${this.baseUrl}/collections/${collection}/points/query`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: vector, limit, with_payload: true }),
      },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      result?: { points?: QdrantPoint[] };
    };
    return data.result?.points || [];
  }

  /** 读取完整 Markdown 文件（去 frontmatter） */
  readFullPage(sourceFile: string): string {
    const filePath = path.join(this.stagingRoot, sourceFile);
    if (!fs.existsSync(filePath)) return "";
    let text = fs.readFileSync(filePath, "utf8");
    // 去掉 YAML frontmatter
    text = text.replace(/^---[\s\S]*?---\s*/m, "");
    // 去掉 [[链接]] 语法保留文字
    text = text.replace(/\[\[([^\]]+)\]\]/g, "$1");
    return text.trim();
  }

  /** 搜索并返回完整文件内容 */
  async searchWithFullPage(
    collection: string,
    vector: number[],
    limit = 3,
  ): Promise<KnowledgeHit[]> {
    const points = await this.search(collection, vector, limit);
    return points
      .filter((p) => p.payload?.source)
      .map((p) => ({
        score: p.score,
        sourceFile: p.payload!.source as string,
        fullContent: this.readFullPage(p.payload!.source as string),
        snippet: (p.payload!.text as string) || "",
      }));
  }
}
