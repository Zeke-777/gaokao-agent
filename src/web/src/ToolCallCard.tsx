import { useState } from "react";
import type { ToolEvent } from "./ChatContext";

export default function ToolCallCard({ event }: { event: ToolEvent }) {
  const [expanded, setExpanded] = useState(false);

  if (event.type === "thinking") {
    return (
      <div className="tool-line thinking-line">
        <span className="tool-dot pulse" />
        <span className="thinking-text">{event.message}</span>
      </div>
    );
  }

  if (event.type === "tool_call") {
    return (
      <div className="tool-line">
        <div className="tool-summary" onClick={() => setExpanded(!expanded)} style={{cursor:"pointer"}}>
          <span className="tool-dot" />
          <span className="tool-name">{event.message}</span>
          <span className={`tool-toggle ${expanded ? "open" : ""}`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
          </span>
        </div>
        {expanded && (
          <pre className="tool-detail">
            {JSON.stringify(event.tool?.args || {}, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  // tool_result
  const preview = event.message.slice(0, 100);
  return (
    <div className="tool-line tool-result">
      <div className="tool-summary">
        <span className="tool-dot success" />
        <span className="tool-name">完成 ({event.ms || "?"}ms)</span>
        <span className="tool-preview">{preview}{event.message.length > 100 ? '...' : ''}</span>
      </div>
    </div>
  );
}
