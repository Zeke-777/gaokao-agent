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
 * 查询 gaokao_2025.db 数据库中的院校录取线、专业录取线、各省控制线
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
        "查询高考录取数据库（包含2024-2025年数据）。支持三种查询模式：1) 查询院校录取分数线；2) 查询专业录取分数线；3) 查询各省控制线（批次线）。返回精确的分数、位次、招生计划、年份等数据。",
      parameters: {
        type: "object",
        properties: {
          query_type: {
            type: "string",
            enum: ["school", "major", "line"],
            description:
              "查询类型：school=院校录取线，major=专业录取线，line=各省控制线",
          },
          school: {
            type: "string",
            description: "学校名称（精确匹配），如：清华大学、郑州大学",
          },
          province: {
            type: "string",
            description: "省份名称（精确匹配），如：山东、河南、北京",
          },
          major: {
            type: "string",
            description:
              "专业名称或关键词（模糊匹配），仅 query_type=major 时有效，如：计算机、临床医学",
          },
          year: {
            type: "number",
            description: "年份筛选，如：2025、2024。不传则返回所有年份数据",
          },
          limit: {
            type: "number",
            description: "返回结果数量上限，默认20",
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
    const year = args.year != null ? Number(args.year) : undefined;
    // line 查询默认返回更多结果（用户传了 limit 就用用户的）
    const defaultLimit = queryType === "line" ? 50 : 20;
    const rawLimit = args.limit != null ? Number(args.limit) : defaultLimit;
    const limit = Math.min(Math.max(rawLimit, 1), 100);

    try {
      let result: string;
      switch (queryType) {
        case "school":
          result = this.querySchool(school, province, year, limit);
          break;
        case "major":
          result = this.queryMajor(school, province, major, year, limit);
          break;
        case "line":
          result = this.queryLine(province, year, limit);
          break;
        default:
          return `未知查询类型: ${queryType}，支持: school, major, line`;
      }

      // 截断过长的结果，防止 LLM 处理困难
      const MAX_LENGTH = 10000;
      if (result.length > MAX_LENGTH) {
        result = result.substring(0, MAX_LENGTH) + "\n\n... (结果已截断，请缩小查询范围或减少 limit)";
      }
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
    limit = 20,
  ): string {
    if (!school && !province) {
      return "请至少提供 school 或 province 参数";
    }

    let sql = "SELECT * FROM school_scores WHERE 1=1";
    const params: unknown[] = [];

    if (school) {
      sql += " AND school = ?";
      params.push(school);
    }
    if (province) {
      sql += " AND province = ?";
      params.push(province);
    }
    if (year) {
      sql += " AND year = ?";
      params.push(year);
    }
    sql += " ORDER BY year DESC, min_score DESC LIMIT ?";
    params.push(limit);

    const rows = this.db.query(sql).all(...params) as any[];
    if (rows.length === 0) return "未找到匹配的院校录取数据。";

    const lines = rows.map(
      (r) =>
        `${r.year}年 | ${r.school} | ${r.province} | ${r.batch} | ${r.subject} | ${r.min_score}分 | ${r.min_rank}位 | 计划${r.plan_count ?? "-"}人`,
    );
    return `【院校录取线】共 ${rows.length} 条\n${lines.join("\n")}`;
  }

  /** 查询专业录取线 */
  private queryMajor(
    school?: string,
    province?: string,
    major?: string,
    year?: number,
    limit = 20,
  ): string {
    if (!school && !province && !major) {
      return "请至少提供 school、province 或 major 参数";
    }

    let sql = "SELECT * FROM major_scores WHERE 1=1";
    const params: unknown[] = [];

    if (school) {
      sql += " AND school = ?";
      params.push(school);
    }
    if (province) {
      sql += " AND province = ?";
      params.push(province);
    }
    if (major) {
      sql += " AND major LIKE ?";
      params.push(`%${escapeLikePattern(major)}%`);
    }
    if (year) {
      sql += " AND year = ?";
      params.push(year);
    }
    sql += " ORDER BY year DESC, min_score DESC LIMIT ?";
    params.push(limit);

    const rows = this.db.query(sql).all(...params) as any[];
    if (rows.length === 0) return "未找到匹配的专业录取数据。";

    const lines = rows.map(
      (r) =>
        `${r.year}年 | ${r.school} | ${r.province} | ${r.major} | ${r.min_score}分 | ${r.min_rank}位 | 计划${r.plan_count ?? "-"}人`,
    );
    return `【专业录取线】共 ${rows.length} 条\n${lines.join("\n")}`;
  }

  /** 查询各省控制线 */
  private queryLine(province?: string, year?: number, limit?: number): string {
    let sql = "SELECT * FROM province_lines WHERE 1=1";
    const params: unknown[] = [];

    if (province) {
      sql += " AND province = ?";
      params.push(province);
    }
    if (year) {
      sql += " AND year = ?";
      params.push(year);
    }
    sql += " ORDER BY year DESC, province, batch, subject LIMIT ?";
    params.push(limit);

    const rows = this.db.query(sql).all(...params) as any[];
    if (rows.length === 0) return "未找到匹配的控制线数据。";

    const lines = rows.map(
      (r) => `${r.year}年 | ${r.province} | ${r.batch} | ${r.subject} | ${r.score_line}分`,
    );
    return `【各省控制线】共 ${rows.length} 条\n${lines.join("\n")}`;
  }

  /** 关闭数据库连接 */
  close(): void {
    this.db.close();
  }
}
