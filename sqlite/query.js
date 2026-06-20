/**
 * 07_录取数据 / query.js
 * 高考录取数据查询工具
 * 
 * 使用方式：
 *   bun sqlite/query.js --school 清华大学 --province 山东
 *   bun sqlite/query.js --school 郑州大学 --province 河南 --major 计算机
 *   bun sqlite/query.js --province 北京 --lines           # 查看控制线
 *   bun sqlite/query.js --school 清华大学                  # 查看该校在所有省的录取线
 *   bun sqlite/query.js --major 计算机 --province 山东     # 查某省某专业各校录取线
 */

import { Database } from "bun:sqlite";
import path from "path";

const DB_PATH = path.resolve(import.meta.dir, '../data/gaokao_2025.db');

// 检查数据库是否存在
const dbFile = Bun.file(DB_PATH);
if (!await dbFile.exists()) {
  console.error('❌ 数据库文件不存在。请先运行 bun sqlite/init_db.js 初始化。');
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });

// ============================================================
// 解析命令行参数
// ============================================================
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      args[key] = argv[i + 1];
      i++;
    } else {
      args[key] = true;
    }
  }
}

// ============================================================
// 辅助：格式化表格输出
// ============================================================
function printTable(rows, columns) {
  if (!rows || rows.length === 0) {
    console.log('  （未找到匹配数据）');
    return;
  }
  
  // 计算列宽
  const widths = {};
  columns.forEach(col => {
    widths[col.key] = col.label.length;
    rows.forEach(row => {
      const val = String(row[col.key] ?? '');
      // 中文字符占2个宽度
      const charWidth = [...val].reduce((w, ch) => w + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
      widths[col.key] = Math.max(widths[col.key], charWidth);
    });
  });

  // 表头
  const header = columns.map(col => {
    const labelWidth = [...col.label].reduce((w, ch) => w + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
    return col.label + ' '.repeat(Math.max(0, widths[col.key] - labelWidth));
  }).join('  │  ');

  const separator = columns.map(col => '─'.repeat(widths[col.key])).join('──┼──');
  
  console.log('  ' + header);
  console.log('  ' + separator);

  // 数据行
  rows.forEach(row => {
    const line = columns.map(col => {
      const val = String(row[col.key] ?? '-');
      const charWidth = [...val].reduce((w, ch) => w + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
      if (col.align === 'right') {
        return ' '.repeat(Math.max(0, widths[col.key] - charWidth)) + val;
      }
      return val + ' '.repeat(Math.max(0, widths[col.key] - charWidth));
    }).join('  │  ');
    console.log('  ' + line);
  });

  console.log(`\n  共 ${rows.length} 条记录`);
}

// ============================================================
// 查询逻辑
// ============================================================

// 模式1：查控制线
if (args.lines) {
  const prov = args.province;
  console.log(`\n📊 ${prov || '全国'} 2025年各批次控制线\n`);
  
  let sql = 'SELECT * FROM province_lines WHERE year = 2025';
  const params = [];
  if (prov) { sql += ' AND province = ?'; params.push(prov); }
  sql += ' ORDER BY province, batch, subject';

  const rows = db.query(sql).all(...params);
  printTable(rows, [
    { key: 'province', label: '省份' },
    { key: 'batch', label: '批次' },
    { key: 'subject', label: '科类' },
    { key: 'score_line', label: '控制线', align: 'right' },
    { key: 'source', label: '来源' },
  ]);
}

// 模式2：查院校录取线
else if (args.school && !args.major) {
  const school = args.school;
  const prov = args.province;
  
  console.log(`\n🏫 ${school} ${prov ? `在${prov}` : '全部省份'} 2025年录取线\n`);

  let sql = 'SELECT * FROM school_scores WHERE school = ? AND year = 2025';
  const params = [school];
  if (prov) { sql += ' AND province = ?'; params.push(prov); }
  sql += ' ORDER BY province, batch, subject';

  const rows = db.query(sql).all(...params);
  printTable(rows, [
    { key: 'province', label: '省份' },
    { key: 'batch', label: '批次' },
    { key: 'subject', label: '科类' },
    { key: 'min_score', label: '最低分', align: 'right' },
    { key: 'min_rank', label: '最低位次', align: 'right' },
    { key: 'plan_count', label: '计划数', align: 'right' },
    { key: 'source', label: '来源' },
  ]);
}

// 模式3：查专业录取线
else if (args.major) {
  const major = args.major;
  const school = args.school;
  const prov = args.province;
  
  const title = [school, prov, `"${major}"相关专业`].filter(Boolean).join(' ');
  console.log(`\n🎯 ${title} 2025年录取线\n`);

  let sql = 'SELECT * FROM major_scores WHERE major LIKE ? AND year = 2025';
  const params = [`%${major}%`];
  if (school) { sql += ' AND school = ?'; params.push(school); }
  if (prov) { sql += ' AND province = ?'; params.push(prov); }
  sql += ' ORDER BY min_score DESC';

  const rows = db.query(sql).all(...params);
  printTable(rows, [
    { key: 'school', label: '学校' },
    { key: 'province', label: '省份' },
    { key: 'major', label: '专业' },
    { key: 'min_score', label: '最低分', align: 'right' },
    { key: 'min_rank', label: '最低位次', align: 'right' },
    { key: 'plan_count', label: '计划数', align: 'right' },
  ]);
}

// 帮助
else {
  console.log(`
高考录取数据查询工具 (2025年数据)
===================================

使用方式：

  查控制线：
    bun sqlite/query.js --lines                       # 全国控制线
    bun sqlite/query.js --lines --province 山东        # 山东控制线

  查院校录取线：
    bun sqlite/query.js --school 清华大学              # 清华在所有省的录取线
    bun sqlite/query.js --school 清华大学 --province 山东  # 清华在山东的录取线

  查专业录取线：
    bun sqlite/query.js --major 计算机                 # 全国"计算机"相关专业录取线
    bun sqlite/query.js --major 计算机 --province 山东  # 山东"计算机"相关专业
    bun sqlite/query.js --school 清华大学 --major 计算机  # 清华"计算机"相关专业

  参数说明：
    --school    学校名称（精确匹配）
    --province  省份名称（精确匹配）
    --major     专业关键词（模糊匹配）
    --lines     查看控制线模式
  `);
}

db.close();
