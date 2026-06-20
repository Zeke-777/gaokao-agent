/**
 * 07_录取数据 / import_csv.js
 * 从 CSV 文件批量导入录取数据
 * 
 * CSV 格式要求：
 *   院校线 CSV：school,province,batch,subject,min_score,avg_score,max_score,min_rank,plan_count,source
 *   专业线 CSV：school,province,batch,subject,major_group,major,min_score,avg_score,max_score,min_rank,plan_count,source
 * 
 * 使用方式：
 *   bun sqlite/import_csv.js --type school --file ./data/school_scores.csv
 *   bun sqlite/import_csv.js --type major --file ./data/major_scores.csv
 *   bun sqlite/import_csv.js --type lines --file ./data/province_lines.csv
 */

import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";

const DB_PATH = path.resolve(import.meta.dir, '../data/gaokao_2025.db');

if (!await Bun.file(DB_PATH).exists()) {
  console.error('❌ 数据库文件不存在。请先运行 bun sqlite/init_db.js 初始化。');
  process.exit(1);
}

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      args[key] = argv[i + 1];
      i++;
    }
  }
}

if (!args.type || !args.file) {
  console.log(`
CSV 数据导入工具
================

使用方式：
  bun sqlite/import_csv.js --type school --file ./data/school_scores.csv     # 导入院校线
  bun sqlite/import_csv.js --type major  --file ./data/major_scores.csv      # 导入专业线
  bun sqlite/import_csv.js --type lines  --file ./data/province_lines.csv    # 导入控制线

CSV 格式（第一行为表头，逗号分隔，UTF-8 编码）：

  院校线：school,province,batch,subject,min_score,avg_score,max_score,min_rank,plan_count,actual_count,score_line,source,note
  专业线：school,province,batch,subject,major_group,major,min_score,avg_score,max_score,min_rank,plan_count,actual_count,source,note
  控制线：province,batch,subject,score_line,source
  `);
  process.exit(0);
}

const csvPath = path.resolve(args.file);
if (!fs.existsSync(csvPath)) {
  console.error(`❌ 文件不存在：${csvPath}`);
  process.exit(1);
}

const db = new Database(DB_PATH);

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim());
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = vals[i] || null;
    });
    return obj;
  });
}

const csvText = fs.readFileSync(csvPath, 'utf8');
const rows = parseCSV(csvText);

let imported = 0;
let errors = 0;

if (args.type === 'school') {
  const stmt = db.query(`
    INSERT OR REPLACE INTO school_scores 
    (school,province,year,batch,subject,min_score,avg_score,max_score,min_rank,plan_count,actual_count,score_line,source,note)
    VALUES (?,?,2025,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const tx = db.transaction((data) => {
    for (const r of data) {
      try {
        stmt.run(
          r.school, r.province, r.batch, r.subject,
          r.min_score ? parseInt(r.min_score) : null,
          r.avg_score ? parseInt(r.avg_score) : null,
          r.max_score ? parseInt(r.max_score) : null,
          r.min_rank ? parseInt(r.min_rank) : null,
          r.plan_count ? parseInt(r.plan_count) : null,
          r.actual_count ? parseInt(r.actual_count) : null,
          r.score_line ? parseInt(r.score_line) : null,
          r.source || '待补',
          r.note || null
        );
        imported++;
      } catch (e) {
        errors++;
        if (errors <= 5) console.error(`  ⚠ 第${imported + errors}行导入失败：${e.message}`);
      }
    }
  });
  tx(rows);
}

else if (args.type === 'major') {
  const stmt = db.query(`
    INSERT OR REPLACE INTO major_scores 
    (school,province,year,batch,subject,major_group,major,min_score,avg_score,max_score,min_rank,plan_count,actual_count,source,note)
    VALUES (?,?,2025,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const tx = db.transaction((data) => {
    for (const r of data) {
      try {
        stmt.run(
          r.school, r.province, r.batch, r.subject,
          r.major_group || null,
          r.major,
          r.min_score ? parseInt(r.min_score) : null,
          r.avg_score ? parseInt(r.avg_score) : null,
          r.max_score ? parseInt(r.max_score) : null,
          r.min_rank ? parseInt(r.min_rank) : null,
          r.plan_count ? parseInt(r.plan_count) : null,
          r.actual_count ? parseInt(r.actual_count) : null,
          r.source || '待补',
          r.note || null
        );
        imported++;
      } catch (e) {
        errors++;
        if (errors <= 5) console.error(`  ⚠ 第${imported + errors}行导入失败：${e.message}`);
      }
    }
  });
  tx(rows);
}

else if (args.type === 'lines') {
  const stmt = db.query(`
    INSERT OR REPLACE INTO province_lines (province,year,batch,subject,score_line,source)
    VALUES (?,2025,?,?,?,?)
  `);
  const tx = db.transaction((data) => {
    for (const r of data) {
      try {
        stmt.run(r.province, r.batch, r.subject, parseInt(r.score_line), r.source || '待补');
        imported++;
      } catch (e) { errors++; }
    }
  });
  tx(rows);
}

console.log(`\n✅ 导入完成：成功 ${imported} 条 | 失败 ${errors} 条`);
console.log(`   数据库：${DB_PATH}`);

db.close();
