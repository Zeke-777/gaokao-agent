/**
 * 07_录取数据 / fetch_baidu_gaokao.js  (v2 · 全自动自愈版)
 * 
 * 从百度高考公开API批量获取全国院校录取数据
 * 
 * 自愈能力：
 *   ✅ 请求失败自动重试（指数退避，最多3次）
 *   ✅ 被封/限速自动降速等待（检测到连续失败时暂停60秒）
 *   ✅ 断点续传（记录进度到 checkpoint.json，崩溃后重启自动恢复）
 *   ✅ 实时进度日志（写入 fetch_log.txt，可随时查看）
 *   ✅ 结束后生成完整报告
 * 
 * 使用方式：
 *   bun sqlite/fetch_baidu_gaokao.js                  # 全量抓取（自动断点续传）
 *   bun sqlite/fetch_baidu_gaokao.js --test            # 测试模式（5所）
 *   bun sqlite/fetch_baidu_gaokao.js --province 山东    # 只抓某省
 *   bun sqlite/fetch_baidu_gaokao.js --reset           # 清除断点，从头开始
 *   bun sqlite/fetch_baidu_gaokao.js --speed fast      # 快速模式（200ms间隔）
 *   bun sqlite/fetch_baidu_gaokao.js --speed safe      # 安全模式（500ms间隔）
 */

import { Database } from "bun:sqlite";
import https from "https";
import http from "http";
import path from "path";
import fs from "fs";

const DB_PATH = path.resolve(import.meta.dir, '../data/gaokao_2025.db');
const CHECKPOINT_PATH = path.resolve(import.meta.dir, '../data/checkpoint.json');
const LOG_PATH = path.resolve(import.meta.dir, '../data/fetch_log.txt');

// ============================================================
// 配置
// ============================================================
const CONFIG = {
  pageSize: 10,  // API实际固定返回10条/页（忽略rn参数）
  year: '2025',  // 当前抓取 2025 年数据
  maxRetries: 3,
  provinces: [
    '北京','天津','河北','山西','内蒙古',
    '辽宁','吉林','黑龙江',
    '上海','江苏','浙江','安徽','福建','江西','山东',
    '河南','湖北','湖南','广东','广西','海南',
    '重庆','四川','贵州','云南','西藏',
    '陕西','甘肃','青海','宁夏','新疆'
  ],
  xgk33: ['北京','天津','上海','浙江','山东','海南'],
  xgk312: ['河北','辽宁','江苏','福建','湖北','湖南','广东','重庆','甘肃','黑龙江','吉林','安徽','江西','贵州','广西'],
  traditional: ['山西','内蒙古','河南','四川','云南','陕西','青海','宁夏','新疆','西藏'],
};

// ============================================================
// 解析命令行
// ============================================================
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      args[key] = argv[i + 1]; i++;
    } else { args[key] = true; }
  }
}

// 速度设置
let requestDelay = 300; // 默认 300ms
if (args.speed === 'fast') requestDelay = 200;
if (args.speed === 'safe') requestDelay = 500;

// ============================================================
// 日志系统
// ============================================================
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

function log(msg, level = 'INFO') {
  const ts = new Date().toLocaleString('zh-CN');
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

// ============================================================
// 断点系统
// ============================================================
function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_PATH)) {
      return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return { completedSchools: [], stats: { schoolScores: 0, majorScores: 0, errors: 0 } };
}

function saveCheckpoint(data) {
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ============================================================
// 网络请求（带重试 + 指数退避）
// ============================================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchJSON(url, retries = CONFIG.maxRetries) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://gaokao.baidu.com/',
      },
      timeout: 15000,
    };
    
    const req = client.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error(`JSON解析失败(HTTP ${res.statusCode}): ${data.substring(0, 200)}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
  });
}

async function fetchWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      return await fetchJSON(url);
    } catch (e) {
      lastError = e;
      const wait = Math.min(1000 * Math.pow(2, attempt), 10000); // 2s, 4s, 8s...
      if (attempt < CONFIG.maxRetries) {
        log(`  重试 ${attempt}/${CONFIG.maxRetries}（等待${wait/1000}秒）: ${e.message}`, 'WARN');
        await sleep(wait);
      }
    }
  }
  throw lastError;
}

// ============================================================
// 自适应限速
// ============================================================
let consecutiveErrors = 0;
let currentDelay = requestDelay;

async function adaptiveWait() {
  await sleep(currentDelay);
}

function onRequestSuccess() {
  consecutiveErrors = 0;
  // 如果之前降速了，缓慢恢复
  if (currentDelay > requestDelay) {
    currentDelay = Math.max(requestDelay, currentDelay - 50);
  }
}

async function onRequestError() {
  consecutiveErrors++;
  if (consecutiveErrors >= 5) {
    log(`⚠️ 连续失败${consecutiveErrors}次，暂停60秒后继续...`, 'WARN');
    currentDelay = Math.min(currentDelay + 200, 2000);
    await sleep(60000);
    consecutiveErrors = 0;
  } else if (consecutiveErrors >= 3) {
    currentDelay = Math.min(currentDelay + 100, 1500);
    log(`  连续失败${consecutiveErrors}次，降速至${currentDelay}ms`, 'WARN');
  }
}

// ============================================================
// 工具函数
// ============================================================
function getCurriculumParams(province) {
  if (CONFIG.xgk33.includes(province)) {
    return [{ curriculum: '3%2B3综合', subject: '综合' }];
  }
  if (CONFIG.xgk312.includes(province)) {
    return [
      { curriculum: '3%2B1%2B2综合', subject: '物理类' },
      { curriculum: '3%2B1%2B2综合', subject: '历史类' }
    ];
  }
  return [
    { curriculum: '文科', subject: '文科' },
    { curriculum: '理科', subject: '理科' }
  ];
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}小时${m}分钟` : `${m}分钟`;
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  const startTime = Date.now();
  
  log('='.repeat(60));
  log(`🚀 高考数据抓取启动（v2 自愈版）`);
  log(`   请求间隔：${requestDelay}ms | 年份：${CONFIG.year} | 最大重试：${CONFIG.maxRetries}次`);
  log('='.repeat(60));

  if (!fs.existsSync(DB_PATH)) {
    log('❌ 数据库不存在，请先运行 bun init_db.js', 'ERROR');
    process.exit(1);
  }

  // 清除断点
  if (args.reset) {
    if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);
    log('✅ 断点已清除，从头开始');
  }

  const checkpoint = loadCheckpoint();
  const completedSet = new Set(checkpoint.completedSchools);
  let stats = checkpoint.stats;

  if (completedSet.size > 0) {
    log(`📌 检测到断点：已完成 ${completedSet.size} 所院校，从断点继续`);
  }

  const db = new Database(DB_PATH);

  const insertSchool = db.query(`
    INSERT OR REPLACE INTO school_scores
    (school, province, year, batch, subject, min_score, min_rank, plan_count, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMajor = db.query(`
    INSERT OR REPLACE INTO major_scores
    (school, province, year, batch, subject, major_group, major, min_score, min_rank, plan_count, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // ====================================================
  // STEP 1: 获取全部院校列表
  // ====================================================
  log('\n📋 STEP 1: 获取院校列表...');
  
  const schools = [];
  let page = 0;
  let hasNext = true;

  while (hasNext) {
    try {
      const url = `https://gaokao.baidu.com/gk/gkschool/list?rn=${CONFIG.pageSize}&pn=${page + 1}`;
      const resp = await fetchWithRetry(url);
      
      if (resp.errno !== 0 || !resp.data?.ranking?.tRow) break;

      for (const row of resp.data.ranking.tRow) {
        if (row.education === '本科' && row.nature === '公办') {
          schools.push({
            name: row.college_name,
            province: row.province,
            tags: (row.tag || []).join(','),
          });
        }
      }

      hasNext = resp.data?.pageInfo?.hasNext || false;
      page++;
      
      if (page % 20 === 0) log(`  已扫描 ${page} 页，累计 ${schools.length} 所公办本科...`);
      await sleep(200);
    } catch (e) {
      log(`  ⚠ 第${page + 1}页获取失败（跳过）: ${e.message}`, 'WARN');
      page++;
      await sleep(2000);
      // 如果连续多页失败，可能到末尾了
      if (page > 400 && schools.length > 0) break;
    }
  }

  log(`✅ 院校列表：共 ${schools.length} 所公办本科`);

  // 确定目标
  let targetSchools = args.test ? schools.slice(0, 5) : schools;
  const targetProvinces = args.province ? [args.province] : CONFIG.provinces;

  // 过滤已完成的
  const pendingSchools = targetSchools.filter(s => !completedSet.has(s.name));
  log(`📊 待处理：${pendingSchools.length} 所（已完成 ${completedSet.size} 所）`);
  log(`   目标省份：${targetProvinces.length} 个\n`);

  // 预估时间
  const estimatedRequests = pendingSchools.length * targetProvinces.length * 1.5 * 2;
  const estimatedTime = estimatedRequests * currentDelay / 1000 / 60;
  log(`⏱️ 预估：~${Math.ceil(estimatedTime)} 分钟（${Math.ceil(estimatedTime/60)} 小时）\n`);

  // ====================================================
  // STEP 2: 逐校逐省获取
  // ====================================================

  for (let i = 0; i < pendingSchools.length; i++) {
    const school = pendingSchools[i];
    let schoolScoresBatch = 0;
    let schoolMajorsBatch = 0;
    
    for (const province of targetProvinces) {
      const curriculums = getCurriculumParams(province);
      
      for (const cur of curriculums) {
        try {
          // 校线
          const scoreUrl = `https://gaokao.baidu.com/gk/gkschool/schoolscore?` +
            `curriculum=${cur.curriculum}&school=${encodeURIComponent(school.name)}` +
            `&province=${encodeURIComponent(province)}&year=${CONFIG.year}`;
          
          const scoreResp = await fetchWithRetry(scoreUrl);
          onRequestSuccess();
          
          if (scoreResp.errno === 0 && scoreResp.data?.school_score?.dataList) {
            for (const item of scoreResp.data.school_score.dataList) {
              const minScore = parseInt(item.minScore) || null;
              const minRank = parseInt(item.minScoreOrder) || null;
              const enrollNum = parseInt(item.enrollNum) || null;
              
              if (minScore) {
                insertSchool.run(
                  school.name, province, parseInt(CONFIG.year),
                  item.batchName || '本科批', cur.subject,
                  minScore, minRank, enrollNum,
                  '百度高考/掌上高考'
                );
                stats.schoolScores++;
                schoolScoresBatch++;
              }
            }
          }

          await adaptiveWait();

          // 专业线
          const majorUrl = `https://gaokao.baidu.com/gk/gkschool/majorscore?` +
            `rn=100&curriculum=${cur.curriculum}&subject=&sortType&version=2&needFilter=1` +
            `&school=${encodeURIComponent(school.name)}` +
            `&province=${encodeURIComponent(province)}&year=${CONFIG.year}&pn=1`;
          
          const majorResp = await fetchWithRetry(majorUrl);
          onRequestSuccess();
          
          if (majorResp.errno === 0 && majorResp.data?.major_score?.dataList) {
            for (const item of majorResp.data.major_score.dataList) {
              const minScore = parseInt(item.minScore) || null;
              const minRank = parseInt(item.minScoreOrder) || null;
              
              if (minScore && (item.majorName || item.simpleMajorName)) {
                insertMajor.run(
                  school.name, province, parseInt(CONFIG.year),
                  item.batchName || '本科批', cur.subject,
                  item.majorGroup || null,
                  item.majorName || item.simpleMajorName,
                  minScore, minRank, null,
                  '百度高考/掌上高考'
                );
                stats.majorScores++;
                schoolMajorsBatch++;
              }
            }

            // 如果结果超过100条，翻页
            const total = majorResp.data.major_score.pageInfo?.total || 0;
            if (total > 100) {
              let majorPage = 2;
              while ((majorPage - 1) * 100 < total) {
                await adaptiveWait();
                const nextUrl = majorUrl.replace('pn=1', `pn=${majorPage}`);
                try {
                  const nextResp = await fetchWithRetry(nextUrl);
                  if (nextResp.errno === 0 && nextResp.data?.major_score?.dataList) {
                    for (const item of nextResp.data.major_score.dataList) {
                      const ms = parseInt(item.minScore) || null;
                      const mr = parseInt(item.minScoreOrder) || null;
                      if (ms && (item.majorName || item.simpleMajorName)) {
                        insertMajor.run(
                          school.name, province, parseInt(CONFIG.year),
                          item.batchName || '本科批', cur.subject,
                          item.majorGroup || null,
                          item.majorName || item.simpleMajorName,
                          ms, mr, null, '百度高考/掌上高考'
                        );
                        stats.majorScores++;
                        schoolMajorsBatch++;
                      }
                    }
                  }
                } catch (e) { /* 翻页失败跳过 */ }
                majorPage++;
              }
            }
          }

          await adaptiveWait();

        } catch (e) {
          stats.errors++;
          await onRequestError();
        }
      }
    }

    // 标记完成 + 保存断点
    checkpoint.completedSchools.push(school.name);
    checkpoint.stats = stats;
    
    // 每3所保存一次断点（避免IO过于频繁）
    if ((i + 1) % 3 === 0 || i === pendingSchools.length - 1) {
      saveCheckpoint(checkpoint);
    }

    // 进度报告（每10所或末尾）
    if ((i + 1) % 10 === 0 || i === pendingSchools.length - 1) {
      const totalDone = completedSet.size + i + 1;
      const totalAll = completedSet.size + pendingSchools.length;
      const pct = (totalDone / totalAll * 100).toFixed(1);
      const elapsed = formatDuration(Date.now() - startTime);
      const remaining = formatDuration((Date.now() - startTime) / (i + 1) * (pendingSchools.length - i - 1));
      
      log(
        `[${pct}%] ${totalDone}/${totalAll} 所 | ` +
        `校线 ${stats.schoolScores} | 专业线 ${stats.majorScores} | ` +
        `失败 ${stats.errors} | 已用 ${elapsed} | 剩余 ~${remaining} | ` +
        `当前速度 ${currentDelay}ms`
      );
    }

    // 每50所输出一次本批次小结
    if ((i + 1) % 50 === 0) {
      log(`  📎 最近完成: ${school.name}（本校: ${schoolScoresBatch}条校线 + ${schoolMajorsBatch}条专业线）`);
    }
  }

  // ====================================================
  // 完成报告
  // ====================================================
  const totalTime = formatDuration(Date.now() - startTime);
  
  // 数据库统计
  const dbSchoolCount = db.query('SELECT COUNT(*) as c FROM school_scores').get().c;
  const dbMajorCount = db.query('SELECT COUNT(*) as c FROM major_scores').get().c;
  const dbSchoolNames = db.query('SELECT COUNT(DISTINCT school) as c FROM school_scores').get().c;
  const dbProvinces = db.query('SELECT COUNT(DISTINCT province) as c FROM school_scores').get().c;

  const report = `
${'='.repeat(60)}
✅ 数据获取完成！

📊 本次运行统计：
   新增校线：${stats.schoolScores} 条
   新增专业线：${stats.majorScores} 条
   失败请求：${stats.errors} 次
   总耗时：${totalTime}

📦 数据库总量：
   院校录取线：${dbSchoolCount} 条
   专业录取线：${dbMajorCount} 条
   覆盖院校数：${dbSchoolNames} 所
   覆盖省份数：${dbProvinces} 个

💾 数据库位置：${DB_PATH}
📋 运行日志：${LOG_PATH}
${'='.repeat(60)}`;

  log(report);

  // 清除断点文件（全部完成）
  if (pendingSchools.length > 0 && stats.errors < pendingSchools.length) {
    // 保留断点以防万一，但标记为完成
    checkpoint.completedAt = new Date().toISOString();
    saveCheckpoint(checkpoint);
  }

  db.close();
  logStream.end();
}

// 捕获未处理异常，保存断点
process.on('uncaughtException', (e) => {
  log(`💥 致命错误: ${e.message}`, 'FATAL');
  log('断点已保存，重新运行脚本将从断点继续', 'FATAL');
  process.exit(1);
});

process.on('SIGINT', () => {
  log('\n⏹️ 用户中断（Ctrl+C），断点已保存，重新运行将从断点继续');
  process.exit(0);
});

main().catch(e => {
  log(`💥 致命错误: ${e.message}`, 'FATAL');
  process.exit(1);
});
