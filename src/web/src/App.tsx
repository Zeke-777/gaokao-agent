import { useState, useCallback, useEffect, useRef } from "react";
import { ChatProvider, useChat, type Session } from "./ChatContext";
import ChatArea from "./ChatArea";
import SessionList from "./SessionList";

function AppShell() {
  const { state, dispatch } = useChat();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [navOpen, setNavOpen] = useState(false);
  const [sidenavExpanded, setSidenavExpanded] = useState(false);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      setSessions((await res.json()) as Session[]);
    } catch {}
  }, []);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  // sessionId 从 null 变成有值 → 从欢迎页新建了会话，刷新侧边栏
  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSessionIdRef.current;
    prevSessionIdRef.current = state.sessionId;
    if (!prev && state.sessionId) {
      fetchSessions();
    }
  }, [state.sessionId, fetchSessions]);

  // 对话完成后刷新会话列表（LLM 异步生成标题需要时间）
  useEffect(() => {
    if (state.status === "idle" && state.sessionId) {
      const timer = setTimeout(fetchSessions, 2000);
      return () => clearTimeout(timer);
    }
  }, [state.status, state.sessionId, fetchSessions]);

  const createSession = useCallback(async () => {
    if (state.status === "busy") return; // 生成中不允许创建新会话
    try {
      const res = await fetch("/api/sessions", { method: "POST" });
      if (!res.ok) throw new Error("创建会话失败");
      const s = (await res.json()) as Session;
      setSessions((prev) => [s, ...prev]);
      dispatch({ type: "NEW_SESSION", id: s.id });
      setNavOpen(false);
      setSidenavExpanded(true);
    } catch {}
  }, [dispatch, state.status]);

  const switchSession = useCallback(async (id: string) => {
    if (state.status === "busy") return; // 生成中不允许切换
    setNavOpen(false);
    try {
      const res = await fetch(`/api/sessions/${id}`);
      if (!res.ok) throw new Error("加载会话失败");
      const data = (await res.json()) as { messages?: { role: string; content: string; tool_events?: unknown[] }[] };
      const messages = (data.messages || [])
        .filter((m) => (m.role === "user") || (m.role === "assistant" && m.content))  // 过滤空 assistant（工具调用中间态）
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
          toolEvents: m.tool_events as any[] | undefined,
        }));
      dispatch({ type: "SET_SESSION", id, messages });
    } catch {}
  }, [dispatch, state.status]);

  const deleteSession = useCallback(async (id: string) => {
    await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    if (state.sessionId === id) dispatch({ type: "CLEAR_SESSION" });
    fetchSessions();
  }, [state.sessionId, fetchSessions, dispatch]);

  const renameSession = useCallback(async (id: string, title: string) => {
    await fetch(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    setSessions((prev) => prev.map((s) => s.id === id ? { ...s, title } : s));
  }, []);

  return (
    <div className="app">
      {navOpen && <div className="nav-overlay" onClick={() => setNavOpen(false)} />}
      <aside className={`sidenav ${navOpen ? "open" : ""} ${sidenavExpanded ? "expanded" : ""}`}>
        <div className="sidenav-top">
          <button className="sidenav-icon-btn" title="新聊天" onClick={createSession}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
          <button className="sidenav-icon-btn" title={sidenavExpanded ? "收起" : "展开"} onClick={() => setSidenavExpanded(!sidenavExpanded)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {sidenavExpanded ? (
                <><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 5 5 12 12 19"/></>
              ) : (
                <><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 19 19 12 12 5"/></>
              )}
            </svg>
          </button>
        </div>
        <div className="sidenav-middle">
          <SessionList sessions={sessions} currentId={state.sessionId} busy={state.status === "busy"} onSelect={switchSession} onDelete={deleteSession} onCreate={createSession} onRename={renameSession} />
        </div>
        <div className="sidenav-bottom">
          <button className="sidenav-icon-btn" title="设置">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
          </button>
        </div>
      </aside>
      <main className="chat-main">
        <button className="btn-hamburger" onClick={() => setNavOpen(true)} aria-label="Open menu">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>
        <ChatArea />
      </main>
    </div>
  );
}

export default function App() {
  return <ChatProvider><AppShell /></ChatProvider>;
}
