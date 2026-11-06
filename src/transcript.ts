import { redactSecrets } from "./redact.ts"

export interface Transcript {
  text: string
  toolCalls: number
}

interface RawPart {
  type?: unknown
  text?: unknown
  name?: unknown
  state?: { status?: unknown; input?: unknown } | unknown
}

interface RawMessage {
  type?: unknown
  text?: unknown
  content?: unknown
}

const MAX_TOTAL = 24_000
const MAX_PART = 1_800

/**
 * `ctx.session.context()` の結果から、振り返りに必要な最小限だけを抜き出す。
 * ツール出力の全文は運ばない。各断片は「伏せてから」切り詰め、
 * 境界で分割された秘密情報がモデルへ漏れないようにする。
 */
export function extractTranscript(messages: readonly unknown[]): Transcript {
  const lines: string[] = []
  let toolCalls = 0

  for (const value of messages) {
    if (!value || typeof value !== "object") continue
    const message = value as RawMessage
    if (message.type === "user" && typeof message.text === "string") {
      lines.push(`[user] ${clip(message.text)}`)
      continue
    }
    if (message.type !== "assistant" || !Array.isArray(message.content)) continue
    for (const entry of message.content as unknown[]) {
      if (!entry || typeof entry !== "object") continue
      const part = entry as RawPart
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        lines.push(`[assistant] ${clip(part.text)}`)
      }
      if (part.type !== "tool") continue
      toolCalls++
      const name = typeof part.name === "string" ? part.name : "tool"
      const state = part.state && typeof part.state === "object" ? (part.state as { status?: unknown; input?: unknown }) : undefined
      const failed = state?.status === "error" ? " (failed)" : ""
      const input = state?.input === undefined ? "" : ` ${clip(safeStringify(state.input), 400)}`
      lines.push(`[tool ${name}]${failed}${input}`)
    }
  }

  // 長いセッションは末尾（直近の作業）を優先して残す。
  const kept: string[] = []
  let used = 0
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (used + line.length + 1 > MAX_TOTAL) break
    kept.unshift(line)
    used += line.length + 1
  }
  return { text: kept.join("\n"), toolCalls }
}

function clip(value: string, max = MAX_PART): string {
  const safe = redactSecrets(value.trim())
  return safe.length > max ? `${safe.slice(0, max)}…` : safe
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}
