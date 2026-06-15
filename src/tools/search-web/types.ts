/** 搜索引擎统一返回格式 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** 原始引擎返回的额外字段 */
  raw?: unknown;
}

/** 搜索引擎抽象接口 — 新增引擎只需实现此接口 */
export interface SearchProvider {
  readonly name: string;
  search(query: string, limit?: number): Promise<SearchResult[]>;
}
