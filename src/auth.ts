import { mkdir } from "node:fs/promises"
import path from "node:path"
import {
  GEMINI_OAUTH_CREDS_PATH,
  GEMINI_HOME,
  GEMINI_SETTINGS_PATH,
} from "./paths.js"
import { ensureSandbox } from "./bridge.js"
import { ensureInstalled } from "./installer.js"

const CLIENT_ID =
  "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com"

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URL = "https://oauth2.googleapis.com/token"

const SCOPES = [
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
  "https://www.googleapis.com/auth/cloud-platform",
].join(" ")

const PKCE_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
const CODE_VERIFIER_LENGTH = 43
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

export interface OAuthFlowResult {
  url: string
  instructions: string
  method: "auto"
  callback(): Promise<
    | { type: "success"; provider: string; key: string }
    | { type: "failed" }
  >
}

interface OAuthTokens {
  access_token: string
  scope: string
  token_type: string
  id_token?: string
  expiry_date: number
  refresh_token: string
}

function generateCodeVerifier(): string {
  const bytes = new Uint8Array(CODE_VERIFIER_LENGTH)
  crypto.getRandomValues(bytes)
  let result = ""
  for (let i = 0; i < CODE_VERIFIER_LENGTH; i++) {
    result += PKCE_CHARSET[bytes[i] % PKCE_CHARSET.length]
  }
  return result
}

async function computeCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return base64UrlEncode(digest)
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (const b of bytes) {
    binary += String.fromCharCode(b)
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function saveTokens(tokens: OAuthTokens): Promise<void> {
  await mkdir(GEMINI_HOME, { recursive: true })
  await Bun.write(GEMINI_OAUTH_CREDS_PATH, JSON.stringify(tokens, null, 2))
}

async function updateSettingsJson(): Promise<void> {
  type SettingsShape = Record<string, unknown> & {
    security?: { auth?: { selectedType?: string } }
  }

  let settings: SettingsShape = {}
  const settingsFile = Bun.file(GEMINI_SETTINGS_PATH)
  if (await settingsFile.exists()) {
    try {
      settings = JSON.parse(await settingsFile.text()) as SettingsShape
    } catch (_e) {
      settings = {}
    }
  }

  settings.security ??= {}
  settings.security.auth ??= {}
  settings.security.auth.selectedType = "oauth-personal"

  await mkdir(path.dirname(GEMINI_SETTINGS_PATH), { recursive: true })
  await Bun.write(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2))
}

async function writeGoogleAccountsJson(): Promise<void> {
  const accountsPath = path.join(GEMINI_HOME, "google_accounts.json")

  type AccountsFile = { active: string | null; old: string[] }

  let accounts: AccountsFile = { active: null, old: [] }
  const existing = Bun.file(accountsPath)
  if (await existing.exists()) {
    try {
      const parsed = JSON.parse(await existing.text()) as Record<string, unknown>
      if (parsed && typeof parsed === "object") {
        accounts = {
          active: typeof parsed.active === "string" ? parsed.active : null,
          old: Array.isArray(parsed.old) ? parsed.old as string[] : [],
        }
      }
    } catch (_e) {
      accounts = { active: null, old: [] }
    }
  }

  accounts.active = null

  await mkdir(GEMINI_HOME, { recursive: true })
  await Bun.write(accountsPath, JSON.stringify(accounts, null, 2))
}

export async function isAuthenticated(): Promise<boolean> {
  try {
    const credsFile = Bun.file(GEMINI_OAUTH_CREDS_PATH)
    if (!(await credsFile.exists())) return false
    const parsed = JSON.parse(await credsFile.text()) as {
      access_token?: string
      refresh_token?: string
    }
    return Boolean(parsed?.access_token || parsed?.refresh_token)
  } catch (_e) {
    return false
  }
}

export async function resetAuth(): Promise<void> {
  await ensureSandbox()

  const credsFile = Bun.file(GEMINI_OAUTH_CREDS_PATH)
  if (await credsFile.exists()) {
    await Bun.write(GEMINI_OAUTH_CREDS_PATH, "{}")
  }

  type SettingsShape = Record<string, unknown> & {
    security?: { auth?: { selectedType?: string } }
  }

  const settingsFile = Bun.file(GEMINI_SETTINGS_PATH)
  if (await settingsFile.exists()) {
    try {
      const settings = JSON.parse(await settingsFile.text()) as SettingsShape
      if (settings.security?.auth) {
        delete settings.security.auth.selectedType
      }
      await Bun.write(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2))
    } catch (_e) { }
  }

  const accountsPath = path.join(GEMINI_HOME, "google_accounts.json")
  const accountsFile = Bun.file(accountsPath)
  if (await accountsFile.exists()) {
    await Bun.write(
      accountsPath,
      JSON.stringify({ active: null, old: [] }, null, 2),
    )
  }
}

const SUCCESS_HTML = `<html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="color:#4CAF50">✓ Authentication Complete</h1><p>You have successfully authenticated with Google.</p><p style="color:#666">You can close this tab and return to opencode.</p></div></body></html>`

const FAILURE_HTML = `<html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="color:#e53935">Authentication Failed</h1><p>The authentication was cancelled or encountered an error.</p><p style="color:#666">You can close this tab.</p></div></body></html>`

function htmlResponse(html: string, status: number): Response {
  return new Response(html, { status, headers: { "Content-Type": "text/html" } })
}

export async function startGeminiOAuth(): Promise<OAuthFlowResult> {
  await ensureInstalled({ silent: true })
  await ensureSandbox()

  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await computeCodeChallenge(codeVerifier)
  const state = crypto.randomUUID()

  const { promise: callbackPromise, resolve: resolveCallback } =
    Promise.withResolvers<
      | { type: "success"; provider: string; key: string }
      | { type: "failed" }
    >()

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === "/favicon.ico") {
        return new Response(null, { status: 204 })
      }

      if (url.pathname !== "/callback") {
        return new Response("Not found", { status: 404 })
      }

      const error = url.searchParams.get("error")
      if (error) {
        resolveCallback({ type: "failed" })
        return htmlResponse(FAILURE_HTML, 400)
      }

      const code = url.searchParams.get("code")
      const returnedState = url.searchParams.get("state")

      if (!code || returnedState !== state) {
        resolveCallback({ type: "failed" })
        return htmlResponse(FAILURE_HTML, 400)
      }

      try {
        const tokenResponse = await fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: CLIENT_ID,
            code_verifier: codeVerifier,
            grant_type: "authorization_code",
            redirect_uri: `http://127.0.0.1:${server.port}/callback`,
          }).toString(),
        })

        if (!tokenResponse.ok) {
          console.error("Token exchange failed:", tokenResponse.status, await tokenResponse.text())
          resolveCallback({ type: "failed" })
          return htmlResponse(FAILURE_HTML, 500)
        }

        const tokenData = (await tokenResponse.json()) as Record<string, string>
        const now = Date.now()
        const expiresInSeconds = Number(tokenData.expires_in ?? "3600")

        const tokens: OAuthTokens = {
          access_token: tokenData.access_token ?? "",
          scope: tokenData.scope ?? SCOPES,
          token_type: tokenData.token_type ?? "Bearer",
          id_token: tokenData.id_token,
          expiry_date: now + expiresInSeconds * 1000,
          refresh_token: tokenData.refresh_token ?? "",
        }

        await saveTokens(tokens)
        await updateSettingsJson()
        await writeGoogleAccountsJson()
        await ensureSandbox()

        resolveCallback({
          type: "success",
          provider: "gemini-oauth",
          key: GEMINI_OAUTH_CREDS_PATH,
        })
      } catch (err) {
        console.error("Token exchange error:", err)
        resolveCallback({ type: "failed" })
        return htmlResponse(FAILURE_HTML, 500)
      }

      return htmlResponse(SUCCESS_HTML, 200)
    },
  })

  const redirectUri = `http://127.0.0.1:${server.port}/callback`

  const authParams = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  })

  const callback = async (): Promise<
    | { type: "success"; provider: string; key: string }
    | { type: "failed" }
  > => {
    const timeoutPromise = new Promise<{ type: "failed" }>((resolve) => {
      setTimeout(() => {
        server.stop()
        resolve({ type: "failed" })
      }, CALLBACK_TIMEOUT_MS)
    })

    const result = await Promise.race([callbackPromise, timeoutPromise])
    server.stop()
    return result
  }

  return {
    url: `${AUTH_URL}?${authParams.toString()}`,
    instructions: "Open the following URL in your browser to authenticate with Google:",
    method: "auto",
    callback,
  }
}
