/**
 * Type declarations for @opencode-ai/plugin.
 * This is an optional peer dependency; types are declared here
 * so TypeScript can compile without the package installed.
 */

declare module "@opencode-ai/plugin" {
  // ── Tool Schema ──────────────────────────────────────────────

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

  // ── Auth Hook ────────────────────────────────────────────────

  export interface AuthSuccess {
    type: "success";
    provider: string;
    key: string;
    refresh?: string;
    access?: string;
    expires?: number;
    accountId?: string;
  }

  export interface AuthFailed {
    type: "failed";
  }

  export type AuthCallbackResult = AuthSuccess | AuthFailed;

  export interface AuthOAuthMethod {
    label: string;
    type: "oauth";
    authorize(): Promise<{
      url: string;
      instructions: string;
      method: "auto";
      callback(): Promise<AuthCallbackResult>;
    }>;
  }

  export interface AuthApiKeyMethod {
    label: string;
    type: "apikey";
    authorize(): Promise<{
      instructions: string;
      method: "code";
      callback(code: string): Promise<AuthCallbackResult>;
    }>;
  }

  export type AuthMethod = AuthOAuthMethod | AuthApiKeyMethod;

  export interface AuthHook {
    provider: string;
    loader(getAuth: () => Promise<AuthRecord>): Record<string, unknown>;
    methods: AuthMethod[];
  }

  export interface AuthRecord {
    provider: string;
    key: string;
    refresh?: string;
    access?: string;
    expires?: number;
    accountId?: string;
  }

  // ── Config Hook ──────────────────────────────────────────────

  export interface McpServerRemote {
    type: "remote";
    url: string;
    enabled?: boolean;
    headers?: Record<string, string>;
    oauth?: Record<string, unknown> | false;
    timeout?: number;
  }

  export interface McpServerLocal {
    type: "local";
    command: string[];
    enabled?: boolean;
    environment?: Record<string, string>;
    timeout?: number;
  }

  export type McpServer = McpServerRemote | McpServerLocal;

  export interface PluginConfig {
    mcp?: Record<string, McpServer>;
    provider?: Record<string, unknown>;
    plugin?: unknown[];
    [key: string]: unknown;
  }

  // ── Plugin Factory ───────────────────────────────────────────

  export interface PluginHooks {
    tool: Record<string, ToolDefinition>;
    auth?: AuthHook;
    config?: (config: PluginConfig) => void | Promise<void>;
  }

  export type PluginFactory = () => Promise<PluginHooks>;
}
