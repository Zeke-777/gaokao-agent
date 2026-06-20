// src/core/config.ts
// 共享配置 — cli.ts 和 server.ts 共用

export const config = {
  llmApiKey: process.env.LLM_API_KEY || "",
  llmBaseUrl: process.env.LLM_BASE_URL || "https://api.deepseek.com",
  llmModel: process.env.LLM_MODEL || "deepseek-v4-flash",
  embeddingUrl: process.env.EMBEDDING_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
  embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-v4",
  embeddingApiKey: process.env.EMBEDDING_API_KEY || "",
  qdrantUrl: process.env.QDRANT_URL || "http://127.0.0.1:6333",
  stagingRoot: process.env.STAGING_ROOT || "./qdrant/staging",
  searchProvider: process.env.SEARCH_PROVIDER || "tavily",
  searchApiKey: process.env.SEARCH_API_KEY || "",
  port: Number(process.env.PORT) || 3211,
};
