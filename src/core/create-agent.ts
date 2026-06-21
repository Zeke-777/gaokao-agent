// src/core/create-agent.ts
// 共享 Agent 工厂 — cli.ts 和 server.ts 共用

import { GaokaoAgent } from "./agent";
import { QdrantClient } from "./qdrant";
import { EmbeddingService } from "./embedding";
import { KnowledgeSearchTool } from "../tools/search-knowledge";
import { SearchWikiTool } from "../tools/search-wiki";
import { WebSearchTool } from "../tools/web-search";
import { config } from "./config";

export function createAgent(): GaokaoAgent {
  const qdrant = new QdrantClient(config.qdrantUrl, config.stagingRoot);
  const embed = new EmbeddingService(config.embeddingUrl, config.embeddingModel, config.embeddingApiKey);
  const searchWiki = new SearchWikiTool("./wiki");

  return new GaokaoAgent({
    llmApiKey: config.llmApiKey,
    llmBaseUrl: config.llmBaseUrl,
    llmModel: config.llmModel,
    tools: [
      new KnowledgeSearchTool(qdrant, embed),
      new WebSearchTool(config.searchProvider, config.searchApiKey),
      searchWiki,
    ],
  });
}
