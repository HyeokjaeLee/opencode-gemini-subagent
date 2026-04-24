/**
 * Type declarations for @opencode-ai/plugin.
 * This is an optional peer dependency; types are declared here
 * so TypeScript can compile without the package installed.
 */

declare module "@opencode-ai/plugin" {
  export interface ToolSchema {
    string(): StringSchema;
    number(): NumberSchema;
    boolean(): BooleanSchema;
    enum(values: string[]): EnumSchema;
    optional(): ToolSchema;
    describe(desc: string): ToolSchema;
    min(n: number): ToolSchema;
    max(n: number): ToolSchema;
    int(): ToolSchema;
  }

  interface StringSchema extends ToolSchema {
    string(): StringSchema;
    min(n: number): StringSchema;
    max(n: number): StringSchema;
  }

  interface NumberSchema extends ToolSchema {
    number(): NumberSchema;
    min(n: number): NumberSchema;
    max(n: number): NumberSchema;
    int(): NumberSchema;
  }

  interface BooleanSchema extends ToolSchema {
    boolean(): BooleanSchema;
  }

  interface EnumSchema extends ToolSchema {
    enum(values: string[]): EnumSchema;
  }

  export interface ToolArgs {
    [key: string]: ToolSchema;
  }

  export interface ToolContext {
    directory: string;
    abort: AbortSignal;
    metadata(info: { title: string; metadata: Record<string, unknown> }): void;
  }

  export interface ToolDefinition {
    description: string;
    args: ToolArgs;
    execute(args: Record<string, unknown>, ctx: ToolContext): Promise<{
      output: string;
      metadata?: Record<string, unknown>;
    }>;
  }

  export interface ToolResult {
    output: string;
    metadata?: Record<string, unknown>;
  }

  export const tool: {
    (def: ToolDefinition): ToolDefinition;
    schema: ToolSchema;
  };

  export type PluginFactory = () => Promise<{
    tool: Record<string, ToolDefinition>;
  }>;
}
