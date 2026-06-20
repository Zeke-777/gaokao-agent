import type { SearchProvider, SearchResult } from "./types";

/** Brave Search API — 预留实现 */
export class BraveSearch implements SearchProvider {
  readonly name = "brave";

  constructor(private apiKey: string, private baseUrl = "https://api.search.brave.com") {}

  async search(query: string, limit = 5, signal?: AbortSignal): Promise<SearchResult[]> {
    const res = await fetch(
      `${this.baseUrl}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
      {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": this.apiKey,
        },
        signal,
      },
    );

    if (!res.ok) {
      throw new Error(`Brave search failed: ${res.status}`);
    }

    const data = (await res.json()) as {
      web?: { results?: Array<{ title: string; url: string; description: string }> };
    };
    return (data.web?.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
      raw: r,
    }));
  }
}
