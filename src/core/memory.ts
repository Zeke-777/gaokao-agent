import { getDb } from "./db";

export interface MemoryEntry {
  key: string;
  value: string;
  category: string;
  updated_at: string;
}

function db() {
  return getDb();
}

/** 设置会话记忆（key 在同 session 内唯一） */
export function setMemory(sessionId: string, key: string, value: string, category = "fact") {
  db()
    .prepare(
      `INSERT INTO memories (session_id, key, value, category, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(session_id, key) DO UPDATE SET
         value = excluded.value,
         category = excluded.category,
         updated_at = datetime('now')`,
    )
    .run(sessionId, key, value, category);
}

/** 获取会话记忆 */
export function listMemories(sessionId: string): MemoryEntry[] {
  const stmt = db().prepare(
    "SELECT key, value, category, updated_at FROM memories WHERE session_id = ? ORDER BY category, key",
  );
  return stmt.all(sessionId) as MemoryEntry[];
}

/** 删除会话记忆 */
export function deleteMemory(sessionId: string, key: string) {
  db()
    .prepare("DELETE FROM memories WHERE session_id = ? AND key = ?")
    .run(sessionId, key);
}

/** 清空会话记忆 */
export function clearMemories(sessionId: string) {
  db()
    .prepare("DELETE FROM memories WHERE session_id = ?")
    .run(sessionId);
}

/** 将记忆加载为 prompt 片段 */
export function buildMemoryPrompt(sessionId: string): string {
  const memories = listMemories(sessionId);
  if (memories.length === 0) return "";

  const facts = memories
    .filter((m) => m.category === "fact")
    .map((m) => `- ${m.key}: ${m.value}`)
    .join("\n");

  if (facts) {
    return `[以下是系统自动记录的用户画像，请在回答时参考]\n\n## 已知用户信息\n${facts}`;
  }
  return "";
}

/** 从对话中自动提取记忆 */
export async function extractMemoriesFromTurn(
  sessionId: string,
  userMsg: string,
  agentResponse: string,
  llmCall: (systemPrompt: string, userPrompt: string) => Promise<string>,
) {
  const extractionPrompt = `从以下对话中提取关键用户画像信息。
只提取明确提到的信息，不要推测。

需要提取的类别：
- user_province: 用户所在省份
- user_score: 用户分数
- user_rank: 用户位次
- user_subject: 选科（物理类/历史类/理科/文科）
- user_major_interest: 感兴趣的专业
- user_school_interest: 感兴趣的学校
- user_city_preference: 城市偏好
- user_budget_constraint: 家庭经济约束

用户: ${userMsg}
回答: ${agentResponse}

请仅返回 JSON 数组，每个元素包含 key 和 value：
[{"key": "user_province", "value": "河南"}, ...]
如果没有可提取的信息，返回空数组 []`;

  try {
    const result = await llmCall(
      "你是一个信息提取助手。只返回 JSON，不要加任何其他文字。",
      extractionPrompt,
    );
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;
    const facts: Array<{ key: string; value: string }> =
      JSON.parse(jsonMatch[0]);
    for (const fact of facts) {
      if (fact.key && fact.value) {
        setMemory(sessionId, fact.key, fact.value);
      }
    }
  } catch {
    // 提取失败静默跳过
  }
}
