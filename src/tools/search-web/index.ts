export type { SearchProvider, SearchResult } from "./types";
export { TavilySearch } from "./tavily";
export { BraveSearch } from "./brave";

import type { SearchProvider } from "./types";
import { TavilySearch } from "./tavily";
import { BraveSearch } from "./brave";

/** 工厂函数 — 按名称创建搜索引擎，新增引擎只改这里 */
export function createSearchProvider(
  name: string,
  apiKey: string,
  baseUrl?: string,
): SearchProvider {
  switch (name) {
    case "tavily":
      return new TavilySearch(apiKey, baseUrl);
    case "brave":
      return new BraveSearch(apiKey, baseUrl);
    default:
      throw new Error(`Unknown search provider: ${name}. Available: tavily, brave`);
  }
}
