// src/core/agent.ts
import { LLMClient } from "./llm-client";
import { ChatLoop } from "./chat-loop";
import { ToolExecutor } from "./tool-executor";
import { buildMessages } from "./message-builder";
import { SessionRepo } from "./repo/session-repo";
import { MessageRepo } from "./repo/message-repo";
import type { ProgressCallback } from "./types";
import type { Tool } from "../tools/types";
import { stripSpecialTags } from "./text-utils";

export interface AgentConfig {
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  tools: Tool[];
  onClose?: () => void;
}

export class GaokaoAgent {
  private llm: LLMClient;
  private chatLoop: ChatLoop;
  private toolExecutor: ToolExecutor;
  private onClose?: () => void;
  readonly sessionRepo = new SessionRepo();
  readonly messageRepo = new MessageRepo();

  constructor(config: AgentConfig) {
    this.llm = new LLMClient(config.llmApiKey, config.llmBaseUrl, config.llmModel);
    this.toolExecutor = new ToolExecutor(config.tools);
    this.chatLoop = new ChatLoop(this.llm, this.toolExecutor);
    this.onClose = config.onClose;
  }

  /** 关闭资源（数据库连接等） */
  close(): void {
    this.onClose?.();
  }

  /** 进度回调（CLI 使用；服务端通过 chat() 参数传入避免并发冲突） */
  onProgress?: ProgressCallback;

  async chat(
    userPrompt: string,
    sessionId: string,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<string> {
    const progress = onProgress || this.onProgress;
    const toolEvents: unknown[] = [];
    const wrappedProgress: ProgressCallback = (ev) => {
      if (ev.type !== "token" && ev.type !== "thinking" && ev.type !== "done") toolEvents.push(ev);  // token/thinking/done 不存入工具调用历史
      progress?.(ev);
    };
    const messages = buildMessages({
      sessionId,
      userPrompt,
      messageRepo: this.messageRepo,
    });

    const sliceFrom = messages.length - 1;  // user 消息索引，abort 时回退用
    let answer = "";
    let newMessages: import("./types").LLMMessage[] = [];
    let aborted = false;
    try {
      const result = await this.chatLoop.run(messages, wrappedProgress, signal);
      answer = result.answer;
      newMessages = result.newMessages;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        aborted = true;
        // chatLoop 可能在 push 部分消息后才 abort，从 messages 重建
        if (newMessages.length === 0) {
          newMessages = messages.slice(sliceFrom);
        }
      } else {
        throw err;
      }
    } finally {
      if (newMessages.length > 0 && answer && !aborted) {
        try {
          // 过滤特殊标签，防止历史加载时卡死
          const sanitized = newMessages.map(m => ({
            ...m,
            content: m.content ? stripSpecialTags(m.content) : "",
          }));
          this.messageRepo.saveExchange(sessionId, sanitized, toolEvents);
        } catch (e) { console.warn("saveExchange failed:", e); }
      }
    }

    // 首次问答后异步生成标题（fire-and-forget，不阻塞回答；abort 时跳过）
    if (!aborted) try {
      const title = this.sessionRepo.getTitle(sessionId);
      if (title !== null && !title) {
        this.llm.generateTitle(userPrompt).then((generatedTitle) => {
          this.sessionRepo.setTitle(sessionId, generatedTitle);
        }).catch((err) => {
          console.error("标题生成失败:", err);
          try { this.sessionRepo.autoTitle(sessionId); } catch { /* autoTitle 也失败则放弃 */ }
        });
      }
    } catch { /* 标题生成失败不阻塞 */ }
    return answer;
  }

}
