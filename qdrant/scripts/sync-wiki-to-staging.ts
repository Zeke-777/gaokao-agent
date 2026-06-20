// sync-wiki-to-staging.ts
// 将 wiki 目录下的 md 文件同步到 qdrant/staging 目录
// staging 路径: {collection_key}/{wiki_dir_name}/{relative_path}
//
// 用法: bun run qdrant/scripts/sync-wiki-to-staging.ts [--dry-run]

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const WIKI_ROOT = path.join(ROOT, "wiki");
const STAGING_ROOT = path.join(ROOT, "qdrant", "staging");

// wiki 目录 → collection key 映射
const DIR_MAP: Record<string, string> = {
  "01_政策规则": "policies_rules",
  "02_省份数据": "province_data",
  "03_院校库": "schools",
  "04_专业库": "majors",
  "05_张雪峰风格库": "style_cases",
  "06_案例库": "style_cases",
};

const dryRun = process.argv.includes("--dry-run");

function walkMd(dir: string): string[] {
  const result: string[] = [];
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkMd(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      result.push(full);
    }
  }
  return result;
}

// 收集 staging 中已有的文件
function scanStaging(): Set<string> {
  const files = new Set<string>();
  for (const key of new Set(Object.values(DIR_MAP))) {
    const dir = path.join(STAGING_ROOT, key);
    for (const f of walkMd(dir)) {
      files.add(path.relative(STAGING_ROOT, f).replace(/\\/g, "/"));
    }
  }
  return files;
}

let synced = 0;
let skipped = 0;
let removed = 0;

// 清空旧 staging 目录（保留 collection key 顶层目录）
if (!dryRun) {
  for (const key of new Set(Object.values(DIR_MAP))) {
    const dir = path.join(STAGING_ROOT, key);
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      }
    }
  }
}

// 从 wiki 同步到 staging
for (const [wikiDir, collectionKey] of Object.entries(DIR_MAP)) {
  const sourceDir = path.join(WIKI_ROOT, wikiDir);
  if (!fs.existsSync(sourceDir)) {
    console.log(`[skip] wiki 目录不存在: ${wikiDir}`);
    continue;
  }

  const stagingDir = path.join(STAGING_ROOT, collectionKey, wikiDir);

  for (const file of walkMd(sourceDir)) {
    const relPath = path.relative(sourceDir, file).replace(/\\/g, "/");
    const destPath = path.join(stagingDir, relPath);

    // 比较内容，相同则跳过
    if (fs.existsSync(destPath)) {
      const srcContent = fs.readFileSync(file, "utf8");
      const dstContent = fs.readFileSync(destPath, "utf8");
      if (srcContent === dstContent) {
        skipped++;
        continue;
      }
    }

    synced++;
    if (!dryRun) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(file, destPath);
      console.log(`[sync] ${wikiDir}/${relPath}  →  ${collectionKey}/${wikiDir}/${relPath}`);
    } else {
      console.log(`[dry-run] ${wikiDir}/${relPath}  →  ${collectionKey}/${wikiDir}/${relPath}`);
    }
  }
}

console.log(`\n${dryRun ? "[dry-run] " : ""}同步完成: 新增/更新 ${synced}, 跳过(相同) ${skipped}`);
