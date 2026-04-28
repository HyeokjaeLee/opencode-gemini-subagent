import { renameSync } from "node:fs"
import { join } from "node:path"
import { GEMINI_SETTINGS_PATH, GEMINI_HOME } from "./paths.js"
import { ensureSandbox } from "./bridge.js"

export interface OpenCodeMcpServer {
  type: "remote" | "local"
  url?: string
  command?: string[]
  headers?: Record<string, string>
  environment?: Record<string, string>
  timeout?: number
  enabled?: boolean
  oauth?: Record<string, unknown> | false
}

interface OpenCodeMcpAuthEntry {
  tokens?: {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
  }
  serverUrl?: string
  clientInfo?: {
    clientId?: string
    clientSecret?: string
  }
}

interface GeminiMcpOAuthCredential {
  serverName: string
  token: {
    accessToken: string
    refreshToken?: string
    expiresAt?: number
    scope?: string
  }
  clientId?: string
  tokenUrl?: string
  mcpServerUrl?: string
  updatedAt: number
}

export interface GeminiMcpServer {
  url?: string
  type?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
  timeout?: number
  oauth?: Record<string, unknown>
}

export function translateMcpServers(
  opencodeMcp: Record<string, OpenCodeMcpServer>
): Record<string, GeminiMcpServer> {
  const result: Record<string, GeminiMcpServer> = {}

  for (const [name, server] of Object.entries(opencodeMcp)) {
    if (server.enabled === false) continue

    if (server.type === "remote") {
      const translated: GeminiMcpServer = { url: server.url, type: "sse" }
      if (server.headers) translated.headers = server.headers
      if (server.timeout != null) translated.timeout = server.timeout
      if (server.oauth && typeof server.oauth === "object") translated.oauth = server.oauth
      result[name] = translated
    } else if (server.type === "local" && server.command?.length) {
      const translated: GeminiMcpServer = {
        type: "stdio",
        command: server.command[0],
        args: server.command.slice(1),
      }
      if (server.environment) translated.env = server.environment
      if (server.timeout != null) translated.timeout = server.timeout
      result[name] = translated
    }
  }

  return result
}

const DEFAULT_SETTINGS = {
  security: { auth: { selectedType: "oauth-personal" } },
}

const MCP_AUTH_PATH = join(
  process.env.XDG_DATA_HOME ?? join(Bun.env.HOME ?? "~", ".local", "share"),
  "opencode",
  "mcp-auth.json",
)

const GEMINI_MCP_OAUTH_TOKENS_PATH = join(GEMINI_HOME, "mcp-oauth-tokens.json")

async function readMcpAuth(): Promise<Record<string, OpenCodeMcpAuthEntry>> {
  try {
    const file = Bun.file(MCP_AUTH_PATH)
    if (await file.exists()) {
      return JSON.parse(await file.text())
    }
  } catch { /* ignore */ }
  return {}
}

function injectAuthHeaders(
  translated: Record<string, GeminiMcpServer>,
  auth: Record<string, OpenCodeMcpAuthEntry>,
): void {
  for (const [name, server] of Object.entries(translated)) {
    if (server.type !== "sse" || !server.url) continue
    const entry = auth[name]
    const token = entry?.tokens?.accessToken
    if (!token) continue
    server.headers = { ...server.headers, Authorization: `Bearer ${token}` }
  }
}

async function syncMcpOAuthTokens(
  translated: Record<string, GeminiMcpServer>,
  auth: Record<string, OpenCodeMcpAuthEntry>,
): Promise<void> {
  let existing: GeminiMcpOAuthCredential[] = []
  try {
    const file = Bun.file(GEMINI_MCP_OAUTH_TOKENS_PATH)
    if (await file.exists()) {
      existing = JSON.parse(await file.text())
    }
  } catch { /* ignore */ }

  const existingMap = new Map(existing.map(c => [c.serverName, c]))

  for (const [name, server] of Object.entries(translated)) {
    if (server.type !== "sse" || !server.url) continue
    const entry = auth[name]
    const accessToken = entry?.tokens?.accessToken
    if (!accessToken) continue

    existingMap.set(name, {
      serverName: name,
      token: {
        accessToken,
        refreshToken: entry.tokens?.refreshToken,
        expiresAt: entry.tokens?.expiresAt
          ? Math.floor(entry.tokens.expiresAt * 1000)
          : undefined,
      },
      clientId: entry.clientInfo?.clientId,
      mcpServerUrl: server.url,
      updatedAt: Date.now(),
    })
  }

  const tokenArray = Array.from(existingMap.values())
  const tmpPath = GEMINI_MCP_OAUTH_TOKENS_PATH + ".tmp"
  await Bun.write(tmpPath, JSON.stringify(tokenArray, null, 2))
  renameSync(tmpPath, GEMINI_MCP_OAUTH_TOKENS_PATH)
}

export async function syncMcpServers(
  opencodeMcp: Record<string, OpenCodeMcpServer>
): Promise<void> {
  try {
    await ensureSandbox()

    const translated = translateMcpServers(opencodeMcp)
    const auth = await readMcpAuth()
    injectAuthHeaders(translated, auth)

    let settings: Record<string, unknown> = DEFAULT_SETTINGS
    try {
      const file = Bun.file(GEMINI_SETTINGS_PATH)
      if (await file.exists()) {
        const text = await file.text()
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === "object") {
          settings = parsed as Record<string, unknown>
        }
      }
    } catch {
      // Use default settings if read/parse fails
    }

    settings.mcpServers = translated

    const tmpPath = join(GEMINI_HOME, "settings.tmp.json")
    await Bun.write(tmpPath, JSON.stringify(settings, null, 2) + "\n")
    renameSync(tmpPath, GEMINI_SETTINGS_PATH)

    await syncMcpOAuthTokens(translated, auth)
  } catch (err) {
    console.warn("Failed to sync MCP servers to Gemini settings:", err)
  }
}
