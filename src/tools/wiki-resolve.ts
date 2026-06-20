import * as fs from "node:fs";
import * as path from "node:path";

/** 统一路径分隔符为 /（Windows 上 path.dirname 返回 \） */
export function normalizePathSep(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 安全读取文件：路径遍历防护 + 存在性检查 + 读取失败返回空串 */
function safeReadFile(filePath: string, rootDir: string): string {
  const resolved = path.resolve(filePath);
  const root = path.resolve(rootDir);
  if (!resolved.startsWith(root + path.sep)) return "";
  if (!fs.existsSync(resolved)) return "";
  try { return fs.readFileSync(resolved, "utf8"); } catch { return ""; }
}

/** 读取 Markdown 文件：去 frontmatter + 解析 wiki 链接 */
export function readMarkdown(filePath: string, rootDir: string, currentDir: string): string {
  const raw = safeReadFile(filePath, rootDir);
  if (!raw) return "";
  const text = raw.replace(/^---[\s\S]*?---\s*/m, "");
  return replaceWikiLinks(text, currentDir).trim();
}

/** 解析 wiki 链接为项目内 wiki 路径，基于当前文件所在 wiki 目录 */
function resolveWikiLink(raw: string, currentDir: string): string {
  const normDir = normalizePathSep(currentDir);
  const normRaw = normalizePathSep(raw);
  const parts = normRaw.split("/");
  const dirParts = normDir && normDir !== "." ? normDir.split("/").filter(Boolean) : [];

  // 处理 ../ 前缀：每层 ../ 从目录中退一级
  let i = 0;
  while (i < parts.length && parts[i] === "..") {
    dirParts.pop();
    i++;
  }

  const resolved = [...dirParts, ...parts.slice(i)].join("/");
  return `wiki/${resolved.replace(/\.md$/i, "")}.md`;
}

/** 替换文本中所有 [[wiki链接]] 为项目内 wiki 路径。两类处理：
 *  1. 裸引用（无 / 无 ..）→ 保留原样，LLM 通过 search_knowledge 搜索
 *  2. 路径引用（含 / 或以 .. 开头）→ 基于当前文件目录做栈式解析 */
function replaceWikiLinks(text: string, currentDir: string): string {
  return text.replace(/\[\[([^\]]+)\]\]/g, (_: string, p1: string) => {
    if (!p1.includes("/") && !p1.startsWith("..")) {
      // 裸引用：保留原样
      return `[[${p1}]]`;
    }
    // 路径引用：基于当前文件目录解析（.. 退栈，无 ../ 正常拼接）
    return `[[${resolveWikiLink(p1, currentDir)}]]`;
  });
}
