// src/sse-handler.ts
import type { GaokaoAgent } from "./core/agent";

export function createSSEStream(
  agent: GaokaoAgent,
  sessionId: string,
  prompt: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const abortCtrl = new AbortController();

  function sseEncode(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  return new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(sseEncode(event, data)));
      };

      const safeClose = () => {
        try { controller.close(); } catch { /* already closed */ }
      };

      try {
        const answer = await agent.chat(prompt, sessionId, (ev) => {
          send("progress", ev);
        }, abortCtrl.signal);
        send("done", { answer });
      } catch (err: unknown) {
        try {
          const msg = err instanceof Error ? err.message : String(err);
          send("error", { error: msg });
        } catch { /* 客户端已断开 */ }
      } finally {
        safeClose();
      }
    },
    cancel() {
      // 客户端断开连接时触发 → 取消正在进行的 LLM/工具调用
      abortCtrl.abort();
    },
  });
}
