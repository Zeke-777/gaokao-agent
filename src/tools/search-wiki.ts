import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePathSep, readMarkdown } from "./wiki-resolve";
import type { Tool, ToolDefinition } from "./types";

/** wiki 文件名 → 相对路径列表的索引（同名文件是少数，大部分唯一） */
function buildNameIndex(wikiRoot: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const root = path.resolve(wikiRoot);
  if (!fs.existsSync(root)) return index;

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const basename = entry.name.replace(/\.md$/i, "");
        const relative = path.relative(root, full).replace(/\\/g, "/").replace(/\.md$/i, "");
        const paths = index.get(basename) || [];
        paths.push(relative);
        index.set(basename, paths);
      }
    }
  }
  walk(root);
  return index;
}

/** 读取 wiki 知识库文件 */
export class SearchWikiTool implements Tool {
  private wikiRoot: string;
  private nameIndex: Map<string, string[]>;

  constructor(wikiRoot = "./wiki") {
    this.wikiRoot = path.resolve(wikiRoot);
    this.nameIndex = buildNameIndex(wikiRoot);
    console.log(`  wiki name index: ${this.nameIndex.size} unique names`);
    const dupes = [...this.nameIndex.entries()].filter(([, v]) => v.length > 1);
    if (dupes.length)
      console.log(
        `  wiki name dupes: ${dupes.length} (${dupes.slice(0, 5).map(([k]) => k).join(", ")}...)`,
      );
  }

  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "search_wiki",
      description:
        "读取项目 wiki 知识库中的指定文件。支持完整路径或文件名（文件名有歧义时自动返回所有匹配文件）。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "wiki 文件路径或文件名，如 04_专业库/计算机科学与技术.md 或 计算机科学与技术" },
        },
        required: ["path"],
      },
    },
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    return this.read(String(args.path || ""));
  }

  /** 读取指定 wiki 文件。
   *   先直接读路径，不命中则走 name index 查文件名：
   *   匹配到多个文件时全部返回，不报错推给 LLM。 */
  read(filePath: string): string {
    // 去掉可能的 wiki/ 前缀
    const relative = filePath.replace(/^wiki[\/\\]/, "");
    const fullPath = path.resolve(path.join(this.wikiRoot, relative));

    // 防止路径遍历攻击
    if (
      !fullPath.startsWith(this.wikiRoot + path.sep) &&
      fullPath !== this.wikiRoot
    ) {
      return `wiki 路径越界: ${filePath}`;
    }

    // 直接命中 → 读取
    const wikiDir = normalizePathSep(path.dirname(relative));
    const direct = readMarkdown(fullPath, this.wikiRoot, wikiDir);
    if (direct) return direct;

    // 没命中 → 尝试 name index 查裸名
    const basename =
      relative.replace(/\\/g, "/").replace(/\.md$/i, "").split("/").pop() || "";
    const paths = this.nameIndex.get(basename);
    if (paths && paths.length > 0) {
      const results: string[] = [];
      for (const p of paths) {
        const resolved = path.join(this.wikiRoot, p + ".md");
        const pWikiDir = normalizePathSep(path.dirname(p));
        const content = readMarkdown(resolved, this.wikiRoot, pWikiDir);
        if (content) results.push(`[文件: wiki/${p}.md]\n${content}`);
      }
      if (results.length) return results.join("\n\n---\n\n");
    }

    return `wiki 文件不存在: ${filePath}`;
  }
}
