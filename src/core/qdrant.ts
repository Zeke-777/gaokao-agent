import * as path from "node:path";
import { normalizePathSep, readMarkdown } from "../tools/wiki-resolve";

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
    signal?: AbortSignal,
  ): Promise<QdrantPoint[]> {
    const res = await fetch(
      `${this.baseUrl}/collections/${collection}/points/query`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: vector, limit, with_payload: true }),
        signal,
      },
    );
    if (!res.ok) {
      throw new Error(`Qdrant search ${collection} failed: ${res.status}`);
    }
    const data = (await res.json()) as {
      result?: { points?: QdrantPoint[] };
    };
    return data.result?.points || [];
  }

  /** 读取完整 Markdown 文件（去 frontmatter，解析 [[wiki链接]]） */
  readFullPage(sourceFile: string): string {
    const filePath = path.join(this.stagingRoot, sourceFile);
    // sourceFile 格式: "majors/04_专业库/计算机科学与技术.md"
    // 剥掉第一段 collection key 得到 wiki 内目录，用于相对链接解析
    const wikiDir = normalizePathSep(path.dirname(sourceFile)).replace(/^[^/]+\/?/, "");
    return readMarkdown(filePath, this.stagingRoot, wikiDir);
  }

  /** 搜索并返回完整文件内容 */
  async searchWithFullPage(
    collection: string,
    vector: number[],
    limit = 3,
    signal?: AbortSignal,
  ): Promise<KnowledgeHit[]> {
    const points = await this.search(collection, vector, limit, signal);
    return points
      .filter((p) => p.payload?.source)
      .map((p) => {
        const rawSource = p.payload!.source as string;
        const category = (p.payload!.category as string) || "";
        // 入库脚本在 source 前拼接了 category 前缀，这里剥离
        // rawSource: "majors/04_专业库/矿业工程.md" → sourceFile: "04_专业库/矿业工程.md"
        const sourceFile = category && rawSource.startsWith(category + "/")
          ? rawSource.slice(category.length + 1)
          : rawSource;
        const stagingPath = `${category}/${sourceFile}`;
        return {
          score: p.score,
          sourceFile,
          fullContent: this.readFullPage(stagingPath),
          snippet: (p.payload!.text as string) || "",
        };
      });
  }
}
