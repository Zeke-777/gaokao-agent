import { useState, useRef } from "react";
import type { Session } from "./ChatContext";

interface Props {
  sessions: Session[];
  currentId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
}

export default function SessionList({
  sessions,
  currentId,
  busy,
  onSelect,
  onDelete,
  onCreate,
  onRename,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = (s: Session) => {
    setEditingId(s.id);
    setEditValue(s.title || "");
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const commitEdit = () => {
    if (editingId && editValue.trim()) {
      onRename(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  return (
    <div className="session-list">
      <div className="session-list-header">
        <span className="session-list-title">历史对话</span>
      </div>

      {sessions.length === 0 ? (
        <p className="empty-text">暂无对话，点击 + 开始</p>
      ) : (
        sessions.map((s) => (
          <div
            key={s.id}
            className={`session-row ${s.id === currentId ? "active" : ""} ${busy ? "disabled" : ""}`}
            onClick={() => { if (!busy) onSelect(s.id); }}
          >
            {editingId === s.id ? (
              <input
                ref={inputRef}
                className="session-rename-input"
                value={editValue}
                onChange={(e) => setEditValue(e.currentTarget.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditingId(null); }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="session-row-title">
                {s.title || "(新会话)"}
              </span>
            )}
            <button
              className="btn-edit"
              onClick={(e) => {
                e.stopPropagation();
                startEdit(s);
              }}
              title="重命名"
            >
              ✎
            </button>
            <button
              className="btn-del"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(s.id);
              }}
              title="删除会话"
            >
              ×
            </button>
          </div>
        ))
      )}
    </div>
  );
}
