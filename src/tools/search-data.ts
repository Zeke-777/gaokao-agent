// src/tools/search-data.ts
import { Database } from "bun:sqlite";
import * as path from "node:path";
import type { Tool, ToolDefinition } from "./types";

/**
 * 转义 SQL LIKE 通配符
 * 将 %、_、[ 等特殊字符转义为普通字符
 */
function escapeLikePattern(pattern: string): string {
  return pattern.replace(/[%_[]/g, (char) => `[${char}]`);
}

/**
 * 高考录取数据查询工具
 * 查询 gaokao_2025.db 数据库中的院校录取线、专业录取线、各省控制线、聚合排名
 */
export class SearchDataTool implements Tool {
  private db: Database;
  private dbPath: string;

  constructor(dbPath = "./data/gaokao_2025.db") {
    this.dbPath = path.resolve(dbPath);
    this.db = new Database(this.dbPath, { readonly: true });
    console.log(`  search-data: loaded ${this.dbPath}`);
  }

  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "search_data",
      description:
        "查询高考录取数据库（包含2024-2025年数据）。支持四种查询模式：1) 查询院校录取分数线；2) 查询专业录取分数线；3) 查询各省控制线（批次线）；4) 聚合排名（按学校或省份分组统计）。返回精确的分数、位次、招生计划、年份等数据。",
      parameters: {
        type: "object",
        properties: {
          query_type: {
            type: "string",
            enum: ["school", "major", "line", "aggregate"],
            description:
              "查询类型：school=院校录取线，major=专业录取线，line=各省控制线，aggregate=聚合排名",
          },
          school: {
            type: "string",
            description: "学校名称，如：清华大学、郑州大学。支持模糊匹配",
          },
          province: {
            type: "string",
            description: "省份名称，如：山东、河南、北京",
          },
          major: {
            type: "string",
            description:
              "专业名称或关键词（模糊匹配），仅 query_type=major 时有效，如：计算机、临床医学",
          },
          subject: {
            type: "string",
            description:
              "科类筛选，如：物理类、历史类、理科、文科、综合改革。不传则返回所有科类",
          },
          year: {
            type: "number",
            description: "年份筛选，如：2025、2024。不传则返回所有年份数据",
          },
          group_by: {
            type: "string",
            enum: ["school", "province"],
            description:
              "聚合维度（仅 query_type=aggregate 时有效）：school=按学校分组，province=按省份分组",
          },
          limit: {
            type: "number",
            description: "返回结果数量上限，默认 school/major=20，line=50，aggregate=30",
          },
          offset: {
            type: "number",
            description: "分页偏移量，默认 0。配合 limit 实现翻页",
          },
        },
        required: ["query_type"],
      },
    },
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const queryType = String(args.query_type ?? "");
    const school = args.school != null ? String(args.school) : undefined;
    const province = args.province != null ? String(args.province) : undefined;
    const major = args.major != null ? String(args.major) : undefined;
    const subject = args.subject != null ? String(args.subject) : undefined;
    const year = args.year != null ? Number(args.year) : undefined;
    const groupBy = args.group_by != null ? String(args.group_by) : undefined;

    // line 查询默认返回更多结果，aggregate 默认 30
    const defaultLimit =
      queryType === "line" ? 50 : queryType === "aggregate" ? 30 : 20;
    const rawLimit = args.limit != null ? Number(args.limit) : defaultLimit;
    const limit = Math.min(Math.max(rawLimit, 1), 100);

    const rawOffset = args.offset != null ? Number(args.offset) : 0;
    const offset = Math.min(Math.max(rawOffset, 0), 500);

    try {
      let result: string;
      switch (queryType) {
        case "school":
          result = this.querySchool(school, province, year, subject, limit, offset);
          break;
        case "major":
          result = this.queryMajor(school, province, major, year, subject, limit, offset);
          break;
        case "line":
          result = this.queryLine(province, year, subject, limit, offset);
          break;
        case "aggregate":
          result = this.queryAggregate(groupBy, province, subject, year, limit, offset);
          break;
        default:
          return `未知查询类型: ${queryType}，支持: school, major, line, aggregate`;
      }

      // 截断过长的结果，防止 LLM 处理困难（nudge 在截断之后追加）
      const MAX_LENGTH = 10000;
      if (result.length > MAX_LENGTH) {
        result =
          result.substring(0, MAX_LENGTH) +
          "\n\n... (结果已截断，请缩小查询范围或减少 limit)";
      }

      // 追加引导提示 — 帮助 LLM 决定是否继续深入查询
      result += this.getNudge(queryType);
      return result;
    } catch (e: any) {
      console.error("search_data error:", e);
      return `查询出错: ${e.message}`;
    }
  }

  /** 查询院校录取线 */
  private querySchool(
    school?: string,
    province?: string,
    year?: number,
    subject?: string,
    limit = 20,
    offset = 0,
  ): string {
    if (!school && !province) {
      return "请至少提供 school 或 province 参数";
    }

    // 构建 WHERE 子句，useLike 控制 school/province 用精确还是模糊匹配
    const buildClauses = (useLike: boolean) => {
      const clauses: string[] = ["1=1"];
      const params: (string | number)[] = [];
      if (school) {
        clauses.push(useLike ? "school LIKE ?" : "school = ?");
        params.push(useLike ? `%${escapeLikePattern(school)}%` : school);
      }
      if (province) {
        clauses.push(useLike ? "province LIKE ?" : "province = ?");
        params.push(useLike ? `%${escapeLikePattern(province)}%` : province);
      }
      if (year) {
        clauses.push("year = ?");
        params.push(year);
      }
      if (subject) {
        clauses.push("subject = ?");
        params.push(subject);
      }
      return { where: clauses.join(" AND "), params };
    };

    // 先精确匹配
    let { where, params } = buildClauses(false);
    let rows = this.db.query(`SELECT * FROM school_scores WHERE ${where} ORDER BY year DESC, min_score DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];
    let fuzzyNote = "";

    // 精确匹配无结果 → 模糊回退
    if (rows.length === 0 && (school || province)) {
      const fuzzy = buildClauses(true);
      rows = this.db.query(`SELECT * FROM school_scores WHERE ${fuzzy.where} ORDER BY year DESC, min_score DESC LIMIT ? OFFSET ?`).all(...fuzzy.params, limit, offset) as any[];
      if (rows.length > 0) {
        fuzzyNote = "\n⚠️ 精确匹配无结果，已使用模糊匹配。";
      }
    }

    if (rows.length === 0) return "未找到匹配的院校录取数据。";

    const lines = rows.map(
      (r) =>
        `${r.year}年 | ${r.school} | ${r.province} | ${r.batch} | ${r.subject} | ${r.min_score}分 | ${r.min_rank}位 | 计划${r.plan_count ?? "-"}人`,
    );
    return `【院校录取线】共 ${rows.length} 条${fuzzyNote}\n${lines.join("\n")}`;
  }

  /** 查询专业录取线 */
  private queryMajor(
    school?: string,
    province?: string,
    major?: string,
    year?: number,
    subject?: string,
    limit = 20,
    offset = 0,
  ): string {
    if (!school && !province && !major) {
      return "请至少提供 school、province 或 major 参数";
    }

    const buildClauses = (useLike: boolean) => {
      const clauses: string[] = ["1=1"];
      const params: (string | number)[] = [];
      if (school) {
        clauses.push(useLike ? "school LIKE ?" : "school = ?");
        params.push(useLike ? `%${escapeLikePattern(school)}%` : school);
      }
      if (province) {
        clauses.push(useLike ? "province LIKE ?" : "province = ?");
        params.push(useLike ? `%${escapeLikePattern(province)}%` : province);
      }
      if (major) {
        clauses.push("major LIKE ?");
        params.push(`%${escapeLikePattern(major)}%`);
      }
      if (year) {
        clauses.push("year = ?");
        params.push(year);
      }
      if (subject) {
        clauses.push("subject = ?");
        params.push(subject);
      }
      return { where: clauses.join(" AND "), params };
    };

    let { where, params } = buildClauses(false);
    let rows = this.db.query(`SELECT * FROM major_scores WHERE ${where} ORDER BY year DESC, min_score DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];
    let fuzzyNote = "";

    if (rows.length === 0 && (school || province)) {
      const fuzzy = buildClauses(true);
      rows = this.db.query(`SELECT * FROM major_scores WHERE ${fuzzy.where} ORDER BY year DESC, min_score DESC LIMIT ? OFFSET ?`).all(...fuzzy.params, limit, offset) as any[];
      if (rows.length > 0) {
        fuzzyNote = "\n⚠️ 精确匹配无结果，已使用模糊匹配。";
      }
    }

    if (rows.length === 0) return "未找到匹配的专业录取数据。";

    let result = `【专业录取线】共 ${rows.length} 条${fuzzyNote}\n`;
    result += rows
      .map(
        (r) =>
          `${r.year}年 | ${r.school} | ${r.province} | ${r.major} | ${r.min_score}分 | ${r.min_rank}位 | 计划${r.plan_count ?? "-"}人`,
      )
      .join("\n");

    // 未指定 major 参数时追加引导提示
    if (!major) {
      result += `\n\n💡 以上为分数最高的前 ${rows.length} 个专业。如需查询特定专业（如"计算机"、"临床医学"），请使用 major 参数精确搜索。`;
    }

    return result;
  }

  /** 查询各省控制线 */
  private queryLine(
    province?: string,
    year?: number,
    subject?: string,
    limit = 50,
    offset = 0,
  ): string {
    let sql = "SELECT * FROM province_lines WHERE 1=1";
    const params: (string | number)[] = [];

    if (province) {
      sql += " AND province = ?";
      params.push(province);
    }
    if (year) {
      sql += " AND year = ?";
      params.push(year);
    }
    if (subject) {
      sql += " AND subject = ?";
      params.push(subject);
    }
    sql += " ORDER BY year DESC, province, batch, subject LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.query(sql).all(...params) as any[];
    if (rows.length === 0) return "未找到匹配的控制线数据。";

    const lines = rows.map(
      (r) =>
        `${r.year}年 | ${r.province} | ${r.batch} | ${r.subject} | ${r.score_line}分`,
    );
    return `【各省控制线】共 ${rows.length} 条\n${lines.join("\n")}`;
  }

  /** 聚合排名查询 — 按学校或省份分组统计 */
  private queryAggregate(
    groupBy?: string,
    province?: string,
    subject?: string,
    year?: number,
    limit = 30,
    offset = 0,
  ): string {
    if (!groupBy || !["school", "province"].includes(groupBy)) {
      return "aggregate 模式需要指定 group_by 参数，可选值：school（按学校分组）、province（按省份分组）";
    }

    const selectCol = groupBy === "school" ? "school" : "province";
    let sql = `SELECT ${selectCol}, COUNT(*) as record_count, ROUND(AVG(min_score)) as avg_score, MAX(min_score) as max_score, MIN(min_score) as min_score FROM school_scores WHERE 1=1`;
    const params: (string | number)[] = [];

    if (province) {
      sql += " AND province = ?";
      params.push(province);
    }
    if (subject) {
      sql += " AND subject = ?";
      params.push(subject);
    }
    if (year) {
      sql += " AND year = ?";
      params.push(year);
    }

    sql += ` GROUP BY ${selectCol} ORDER BY avg_score DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.query(sql).all(...params) as any[];
    if (rows.length === 0) return "未找到匹配的聚合数据。";

    const label = groupBy === "school" ? "【院校聚合排名】" : "【省份聚合排名】";
    const lines = rows.map((r) => {
      const name = groupBy === "school" ? r.school : r.province;
      return `${name} | 平均${r.avg_score}分 | 最高${r.max_score}分 | 最低${r.min_score}分 | ${r.record_count}条数据`;
    });
    return `${label}共 ${rows.length} 条\n${lines.join("\n")}`;
  }

  /** 根据查询类型返回后续引导提示，帮助 LLM 决定是否深入查询 */
  private getNudge(queryType: string): string {
    switch (queryType) {
      case "school":
        return '\n\n💡 提示：以上为院校整体投档线。如需了解具体专业（如计算机、临床医学）的录取分数和位次，请使用 query_type="major" 进一步查询。';
      case "line":
        return '\n\n💡 提示：以上为省控制线（批次线），不是具体学校的录取线。如需查询某校录取分，请使用 query_type="school"；如需查专业录取分，请使用 query_type="major"。';
      case "aggregate":
        return '\n\n💡 提示：以上为聚合排名。如需查看某校的具体专业录取线，请使用 query_type="major" 并指定 school 和 major 参数。';
      default:
        return "";
    }
  }

  /** 关闭数据库连接 */
  close(): void {
    this.db.close();
  }
}
