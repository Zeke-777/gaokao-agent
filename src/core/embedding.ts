/** Embedding 服务 — 调用 LM Studio 或云端 OpenAI 兼容接口 */
export class EmbeddingService {
  private url: string;
  private model: string;
  private apiKey?: string;

  constructor(
    url = "http://127.0.0.1:1234/v1/embeddings",
    model = "text-embedding-qwen3-embedding-4b",
    apiKey?: string,
  ) {
    this.url = url;
    this.model = model;
    this.apiKey = apiKey;
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    const res = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.model, input: text }),
      signal,
    });
    if (!res.ok) throw new Error(`Embedding failed: ${res.status}`);
    const data = (await res.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    if (!data.data?.length) throw new Error("Embedding 返回空结果");
    return data.data[0]!.embedding;
  }
}
