import { useRef, useState, useEffect, useCallback, type FormEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useChat } from "./ChatContext";
import ToolCallCard from "./ToolCallCard";
import { hasSpecialTags, stripSpecialTags } from "../../core/text-utils";

export default function ChatArea() {
  const { state, dispatch } = useChat();
  const { status, sessionId, messages, progress, streamingContent, input } = state;
  const bottomRef = useRef<HTMLDivElement>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeSidRef = useRef<string | null>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [typedLen, setTypedLen] = useState(0);
  const welcomeText = "有什么需要我来分析的？";

  // 自适应高度
  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [input, adjustHeight]);

  // 监听滚动位置，决定是否显示滚动按钮
  useEffect(() => {
    const el = chatBodyRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
      const atTop = el.scrollTop < 200;
      setShowScrollBtn(!atBottom && !atTop);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // 只在用户已经在底部附近时自动滚，翻看历史时不打断
  useEffect(() => {
    const el = chatBodyRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (isNearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, progress, streamingContent]);

  // 组件卸载时清理 AbortController
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // 切换会话时：中止旧请求（仅处理从侧边栏切换的场景）
  // 注意：从欢迎页提交时 sessionId 也会变化，此时不应 abort 新请求
  const prevSessionIdRef = useRef(sessionId);
  useEffect(() => {
    const prev = prevSessionIdRef.current;
    prevSessionIdRef.current = sessionId;
    // 会话变化时 abort（切换会话或清除会话）
    if (prev && prev !== sessionId && abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, [sessionId]);

  const handleSubmit = async (e: FormEvent | React.KeyboardEvent) => {
    e.preventDefault();
    const prompt = input.trim();
    if (!prompt || status === "busy" || isSubmitting) return;
    setIsSubmitting(true);

    try {
      let sid = sessionId;
      if (!sid) {
        const res = await fetch("/api/sessions", { method: "POST" });
        if (!res.ok) throw new Error("创建会话失败");
        const s = (await res.json()) as { id: string };
        sid = s.id;
        dispatch({ type: "NEW_SESSION", id: s.id });
      }

      dispatch({ type: "SUBMIT", prompt });
      // 发送后立即跳到底部
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
      const controller = new AbortController();
      abortRef.current = controller;
      activeSidRef.current = sid;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sid, prompt }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!res.body) throw new Error("响应体为空");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          let streamDone = false;
          for (const part of parts) {
            if (!part.trim() || streamDone) continue;
            const lines = part.split("\n");
            let eventType = "", dataStr = "";
            for (const line of lines) {
              if (line.startsWith("event: ")) eventType = line.slice(7).trim();
              if (line.startsWith("data: ")) dataStr = line.slice(6);
            }
            if (!dataStr) continue;
            try {
              const payload = JSON.parse(dataStr);
              if (eventType === "progress") {
                if (activeSidRef.current !== sid) continue;
                if (payload.type === "token") {
                  dispatch({ type: "TOKEN", content: payload.message });
                } else {
                  dispatch({ type: "PROGRESS", event: payload });
                }
              }
              else if (eventType === "done") {
                if (activeSidRef.current === sid) dispatch({ type: "ANSWER", content: payload.answer || "(空回答)" });
                streamDone = true;
              }
              else if (eventType === "error") {
                if (activeSidRef.current === sid) dispatch({ type: "ERROR", message: payload.error || "未知错误" });
                streamDone = true;
              }
            } catch { /* skip malformed */ }
          }
          if (streamDone) break;
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          dispatch({ type: "CANCEL" });
        } else {
          dispatch({ type: "ERROR", message: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        if (activeSidRef.current === sid) activeSidRef.current = null;
      }
    } catch (err) {
      dispatch({ type: "ERROR", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsSubmitting(false);
    }
  };

  const isBusy = status === "busy";
  const hasContent = messages.length > 0 || progress.length > 0 || streamingContent.length > 0 || isBusy;

  // 欢迎文字逐字打字动效
  useEffect(() => {
    if (!hasContent && typedLen < welcomeText.length) {
      const t = setTimeout(() => setTypedLen((n) => n + 1), 100);
      return () => clearTimeout(t);
    }
  }, [typedLen, hasContent]);

  return (
    <div className="chat-area">
      {/* Welcome content — always in DOM, fades out */}
      <div className={`welcome-layer ${hasContent ? "hidden" : ""}`}>
        <div className="welcome">
          <h1 className="welcome-title">{welcomeText.slice(0, typedLen)}{typedLen < welcomeText.length && <span className="cursor" />}</h1>
        </div>
        <form onSubmit={handleSubmit} className="input-form welcome-input">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => dispatch({ type: "SET_INPUT", value: e.currentTarget.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            placeholder={"告诉我你的省份、分数和意向 我来帮你分析最合适的学校和专业"}
            disabled={isBusy}
            rows={1}
          />
          <div className="input-form-bottom">
            <div className="input-form-icons">
              <button type="button" title="添加附件">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
            </div>
            {isBusy ? (
              <button type="button" className="btn-stop" onClick={() => abortRef.current?.abort()}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
              </button>
            ) : (
              <button type="submit" disabled={!input.trim() || isSubmitting}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
              </button>
            )}
          </div>
        </form>
      </div>

      {/* Chat messages — always in DOM, hidden when no content */}
      <div ref={chatBodyRef} className={`chat-body ${hasContent ? "" : "hidden"}`}>
        <div className="messages">
          {messages.map((msg, i) => (
            <div key={i}>
              {msg.role === "assistant" && msg.toolEvents && msg.toolEvents.filter(e => e.type !== "thinking" && e.type !== "done").length > 0 && (
                <details className="progress-block collapsed">
                  <summary>工具调用 ({msg.toolEvents.filter(e => e.type === "tool_call").length} 次)</summary>
                  {msg.toolEvents.filter(e => e.type !== "thinking" && e.type !== "done").map((ev, j) => <ToolCallCard key={j} event={ev} />)}
                </details>
              )}
              <div className={`msg ${msg.role}`}>
                <div>
                  <div className="msg-bubble">
                    {msg.role === "assistant" ? (
                      hasSpecialTags(msg.content) ? (
                        <span style={{whiteSpace: 'pre-wrap'}}>{stripSpecialTags(msg.content)}</span>
                      ) : (
                        <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
                      )
                    ) : msg.content}
                  </div>
                  {msg.role === "assistant" && msg.content && !msg.content.startsWith("❌") && msg.content !== "（已取消）" && (
                    <div className="msg-disclaimer">内容由 AI 生成，仅供参考</div>
                  )}
                </div>
              </div>
            </div>
          ))}
          {isBusy && (
            <div className="msg assistant">
              <div className="msg-bubble">
                <div className="loading-dots">
                  <span></span><span></span><span></span>
                </div>
              </div>
            </div>
          )}
          {progress.filter(e => e.type !== "thinking" && e.type !== "done").length > 0 && (
            <div className="progress-block">
              {progress.filter(e => e.type !== "thinking" && e.type !== "done").map((ev, i) => <ToolCallCard key={i} event={ev} />)}
            </div>
          )}
          {streamingContent && (
            <div className="msg assistant">
              <div className="msg-bubble">
                {hasSpecialTags(streamingContent) ? (
                  <span style={{whiteSpace: 'pre-wrap'}}>{stripSpecialTags(streamingContent)}</span>
                ) : (
                  <Markdown remarkPlugins={[remarkGfm]}>{streamingContent}</Markdown>
                )}
                <span className="cursor" />
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Scroll buttons — only in chat mode */}
      <div className={`scroll-buttons ${showScrollBtn ? 'visible' : ''} ${hasContent ? "" : "hidden"}`}>
        <button className="scroll-btn" onClick={() => {
          const el = chatBodyRef.current;
          if (el) el.scrollBy({ top: -300, behavior: "smooth" });
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
        </button>
        <button className="scroll-btn" onClick={() => bottomRef.current?.scrollIntoView({ behavior: "smooth" })}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      </div>

      {/* Chat form — only in chat mode */}
      {hasContent && <form onSubmit={handleSubmit} className="input-form chat-input">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => dispatch({ type: "SET_INPUT", value: e.currentTarget.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
          placeholder="有什么我能帮您的？"
          disabled={isBusy}
          rows={1}
        />
        <div className="input-form-bottom">
          <div className="input-form-icons">
            <button type="button" title="添加附件">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
          </div>
          {isBusy ? (
            <button type="button" className="btn-stop" onClick={() => abortRef.current?.abort()}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
            </button>
          ) : (
            <button type="submit" disabled={!input.trim() || isSubmitting}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
            </button>
          )}
        </div>
      </form>}
    </div>
  );
}
