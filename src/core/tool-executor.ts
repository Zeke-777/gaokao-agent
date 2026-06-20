// src/core/tool-executor.ts
import type { Tool, ToolDefinition } from "../tools/types";

export class ToolExecutor {
  constructor(private tools: Tool[]) {}

  async execute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const tool = this.tools.find((t) => t.definition.function.name === name);
    if (!tool) return "未知工具";
    return tool.execute(args, signal);
  }

  getDefinitions(): ToolDefinition[] {
    return this.tools.map((t) => t.definition);
  }
}
