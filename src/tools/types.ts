// src/tools/types.ts
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Tool {
  readonly definition: ToolDefinition;
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}
