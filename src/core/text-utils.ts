// src/core/text-utils.ts
// 前端和后端共用的文本处理工具

/** 检测是否包含特殊标签（DSML/tool_calls 等） */
export function hasSpecialTags(content: string): boolean {
  return /<｜｜/.test(content);
}

/** 过滤特殊标签，用于纯文本渲染 */
export function stripSpecialTags(content: string): string {
  return content
    .replace(/<｜｜DSML｜｜tool_calls>[\s\S]*?<｜｜\/DSML｜｜tool_calls>/g, "")
    .replace(/<｜｜[^>]*>/g, "")
    .replace(/<｜\/[^>]*>/g, "")
    .trim();
}
