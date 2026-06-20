import type { SearchProvider, SearchResult } from "./types";

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export class TavilySearch implements SearchProvider {
  readonly name = "tavily";

  constructor(private apiKey: string, private baseUrl = "https://api.tavily.com") {}

  async search(query: string, limit = 5, signal?: AbortSignal): Promise<SearchResult[]> {
    const res = await fetch(`${this.baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: limit,
        search_depth: "basic",
      }),
      signal,
    });

    if (!res.ok) {
      throw new Error(`Tavily search failed: ${res.status}`);
    }

    const data = (await res.json()) as { results: TavilyResult[] };
    return (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      raw: r,
    }));
  }
}
