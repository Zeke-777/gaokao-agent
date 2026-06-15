/** Embedding 服务 — 调用 LM Studio 或其他 OpenAI 兼容接口 */
export class EmbeddingService {
  private url: string;
  private model: string;

  constructor(
    url = "http://127.0.0.1:1234/v1/embeddings",
    model = "text-embedding-qwen3-embedding-4b",
  ) {
    this.url = url;
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) throw new Error(`Embedding failed: ${res.status}`);
    const data = (await res.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return data.data[0]!.embedding;
  }
}
