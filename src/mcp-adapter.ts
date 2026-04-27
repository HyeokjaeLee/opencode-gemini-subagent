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
      const translated: GeminiMcpServer = { url: server.url, type: "http" }
      if (server.headers) translated.headers = server.headers
      if (server.timeout != null) translated.timeout = server.timeout
      if (server.oauth && typeof server.oauth === "object") translated.oauth = server.oauth
      result[name] = translated
    } else if (server.type === "local" && server.command?.length) {
      const translated: GeminiMcpServer = {
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

export async function syncMcpServers(
  opencodeMcp: Record<string, OpenCodeMcpServer>
): Promise<void> {
  try {
    await ensureSandbox()

    const translated = translateMcpServers(opencodeMcp)

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
  } catch (err) {
    console.warn("Failed to sync MCP servers to Gemini settings:", err)
  }
}
