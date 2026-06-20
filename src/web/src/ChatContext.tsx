import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from "react";

// ---------- types (shared with App) ----------
export interface Session { id: string; title: string; message_count: number; }
export interface Message { role: "user" | "assistant"; content: string; toolEvents?: ToolEvent[]; }
export interface ToolEvent {
  type: "thinking" | "tool_call" | "tool_result" | "done";
  message: string;
  tool?: { name: string; args: Record<string, unknown> };
  result?: { preview: string; fullLength: number };
  ms?: number;
}

export type ChatStatus = "idle" | "busy";

export interface ChatState {
  status: ChatStatus;
  sessionId: string | null;
  messages: Message[];
  progress: ToolEvent[];
  streamingContent: string;
  input: string;
}

export type ChatAction =
  | { type: "SET_SESSION"; id: string; messages: Message[] }
  | { type: "NEW_SESSION"; id: string }
  | { type: "CLEAR_SESSION" }
  | { type: "SET_INPUT"; value: string }
  | { type: "SUBMIT"; prompt: string }
  | { type: "PROGRESS"; event: ToolEvent }
  | { type: "TOKEN"; content: string }
  | { type: "ANSWER"; content: string }
  | { type: "ERROR"; message: string }
  | { type: "CANCEL" };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "SET_SESSION":
      return { ...state, status: "idle", sessionId: action.id, messages: action.messages, progress: [], streamingContent: "", input: "" };
    case "NEW_SESSION":
      return { ...state, status: "idle", sessionId: action.id, messages: [], progress: [], streamingContent: "", input: "" };
    case "CLEAR_SESSION":
      return { ...state, status: "idle", sessionId: null, messages: [], progress: [], streamingContent: "", input: "" };
    case "SET_INPUT":
      return { ...state, input: action.value };
    case "SUBMIT":
      return { ...state, status: "busy", input: "", progress: [], streamingContent: "", messages: [...state.messages, { role: "user", content: action.prompt }] };
    case "PROGRESS":
      return { ...state, progress: [...state.progress, action.event] };
    case "TOKEN":
      return { ...state, streamingContent: state.streamingContent + action.content };
    case "ANSWER":
      return { ...state, status: "idle", streamingContent: "", progress: [], messages: [...state.messages, { role: "assistant", content: action.content, toolEvents: state.progress.length > 0 ? state.progress : undefined }] };
    case "ERROR":
      return { ...state, status: "idle", streamingContent: "", progress: [], messages: [...state.messages, { role: "assistant", content: `❌ ${action.message}`, toolEvents: state.progress.length > 0 ? state.progress : undefined }] };
    case "CANCEL":
      return { ...state, status: "idle", streamingContent: "", progress: [], messages: [...state.messages, { role: "assistant", content: "（已取消）" }] };
    default:
      return state;
  }
}

const initialState: ChatState = {
  status: "idle", sessionId: null, messages: [], progress: [], streamingContent: "", input: "",
};

const ChatContext = createContext<{ state: ChatState; dispatch: Dispatch<ChatAction> } | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(chatReducer, initialState);
  return <ChatContext.Provider value={{ state, dispatch }}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
}
