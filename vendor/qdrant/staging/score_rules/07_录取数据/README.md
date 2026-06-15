---
type: readme
scope: 录取数据
tags: [SQLite, 分数线, 录取数据, 查询工具]
updated: 2026-04-10
---


# 07_录取数据 使用说明

> [!IMPORTANT]
> 本目录存放 2025 年全国高考录取数据（SQLite 数据库），支持命令行查询。
> 数据库为**种子数据**状态，后续需导入完整的各省录取数据。

## 快速入口

- [[数据索引与查询路径]]
- [[AI查数与数据使用规则]]

---

## 快速开始

### 1. 初始化数据库

```bash
cd 07_录取数据
node init_db.js
```

输出 `gaokao_2025.db` 数据库文件，包含：
- 31 省控制线（批次线）
- C9 联盟 + 代表性院校在 4 个样本省的录取线
- 部分院校的专业录取线样本

### 2. 查询数据

```bash
# 查某省控制线
node query.js --lines --province 山东

# 查某校在某省的录取线
node query.js --school 清华大学 --province 山东

# 查某校在所有省的录取线
node query.js --school 清华大学

# 查某省某专业各校录取线
node query.js --major 计算机 --province 山东

# 查某校某专业录取线
node query.js --school 清华大学 --major 计算机
```

### 3. 导入更多数据

准备 CSV 文件，然后运行导入：

```bash
# 导入院校录取线
node import_csv.js --type school --file ./data/xxx.csv

# 导入专业录取线
node import_csv.js --type major --file ./data/xxx.csv

# 导入控制线
node import_csv.js --type lines --file ./data/xxx.csv
```

---

## 数据库表结构

### school_scores（院校录取线）

| 字段 | 类型 | 说明 |
|------|------|------|
| school | TEXT | 学校名称 |
| province | TEXT | 考生所在省份 |
| year | INTEGER | 年份（2025） |
| batch | TEXT | 批次（本科批/本科一批/常规批…） |
| subject | TEXT | 科类（物理类/历史类/理科/文科/综合改革） |
| min_score | INTEGER | 最低录取分 |
| avg_score | INTEGER | 平均分 |
| max_score | INTEGER | 最高分 |
| min_rank | INTEGER | 最低位次 |
| plan_count | INTEGER | 招生计划人数 |
| actual_count | INTEGER | 实际录取人数 |
| score_line | INTEGER | 当年该省该批次控制线 |
| source | TEXT | 数据来源 |

### major_scores（专业录取线）

在 school_scores 基础上增加：

| 字段 | 类型 | 说明 |
|------|------|------|
| major_group | TEXT | 院校专业组代码（新高考省份） |
| major | TEXT | 专业名称 |

### province_lines（各省控制线）

| 字段 | 类型 | 说明 |
|------|------|------|
| province | TEXT | 省份 |
| batch | TEXT | 批次 |
| subject | TEXT | 科类 |
| score_line | INTEGER | 控制线分数 |

---

## CSV 导入格式

### 院校线 CSV

```csv
school,province,batch,subject,min_score,avg_score,max_score,min_rank,plan_count,actual_count,score_line,source,note
清华大学,山东,常规批,综合改革,689,692,698,68,72,72,443,山东教育招生考试院 2025,
```

### 专业线 CSV

```csv
school,province,batch,subject,major_group,major,min_score,avg_score,max_score,min_rank,plan_count,actual_count,source,note
清华大学,山东,常规批,综合改革,,计算机科学与技术,695,697,700,28,3,3,山东教育招生考试院 2025,
```

---

## 数据来源建议

| 来源 | URL | 说明 |
|------|-----|------|
| 各省教育考试院 | 各省官网 | 最权威、最准确 |
| 阳光高考 | gaokao.chsi.com.cn | 教育部官方平台 |
| 掌上高考 | www.gaokao.cn | 数据量大、更新快 |
| GitHub开源数据集 | 搜索gaokao-data | 可作为批量导入底座 |

> [!WARNING]
> 种子数据中的分数线基于 2024 年数据合理估算。2025 年正式数据公布后（约 2025年6月下旬），
> 应第一时间用官方数据替换。批量替换方式：删除旧库 → 重新 init → import_csv。

---

## 目录文件说明

```
07_录取数据/
├── README.md           ← 本文件
├── init_db.js          ← 数据库初始化 + 种子数据注入
├── query.js            ← 命令行查询工具
├── import_csv.js       ← CSV 批量导入工具
├── gaokao_2025.db      ← SQLite 数据库（运行 init_db.js 后生成）
├── node_modules/       ← better-sqlite3 依赖
├── package.json        ← Node.js 包配置
└── data/               ← 存放待导入的 CSV 文件（建议）
```
