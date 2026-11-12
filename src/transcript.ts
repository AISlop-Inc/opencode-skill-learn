import { redactSecrets } from "./redact.ts"

export interface TranscriptSignals {
  failures: number
  corrections: number
  edits: number
  checks: number
  research: number
}

export interface Transcript {
  /** モデルへ渡す本文。要約・直前の文脈・今回の対象を見出しで分ける。 */
  text: string
  /** 今回の対象区間のツール呼び出し数。 */
  toolCalls: number
  /** 今回の対象区間で、ツールを呼んだ assistant ステップの数（Hermes の tool iteration 相当）。 */
  toolIterations: number
  /** 今回の対象区間のメッセージ数。 */
  newMessages: number
  /** 会話の最後のメッセージ ID。振り返りが成功したらチェックポイントとして保存する。 */
  lastMessageID?: string
  /** 渡したチェックポイントが会話内に見つかったか。圧縮などで消えると false。 */
  checkpointFound: boolean
  /** 今回の対象区間の信号。 */
  signals: TranscriptSignals
  /** 会話全体で読み込まれた Skill。 */
  consultedSkills: string[]
  /** 失敗したツールが後で成功した経緯。モデルの判断材料（参考）。 */
  recoveries: string[]
}

export interface TranscriptOptions {
  /** 前回振り返った最後のメッセージ ID。これより後を今回の対象にする。 */
  checkpoint?: string
  /** 対象区間の直前に、文脈として原文で重ねるメッセージ数。 */
  overlap?: number
  /** 本文全体の文字数の上限。 */
  budget?: number
}

interface RawToolState {
  status?: unknown
  input?: unknown
  content?: unknown
  error?: unknown
}

interface RawPart {
  type?: unknown
  text?: unknown
  name?: unknown
  state?: RawToolState | unknown
}

interface RawMessage {
  id?: unknown
  type?: unknown
  text?: unknown
  content?: unknown
  name?: unknown
  summary?: unknown
  command?: unknown
  exit?: unknown
  output?: unknown
}

interface ToolCall {
  name: string
  tool: string
  status: string
  input: unknown
  output: string
  error: string
}

export const DEFAULT_BUDGET = 24_000
export const DEFAULT_OVERLAP = 6
const MAX_PART = 1_800
const MAX_RECOVERIES = 8
const CORRECTION = /違います|違う|ではなく|じゃなく|まだ.{0,12}(?:直|動)|修正して|やり直|訂正|\b(?:instead|incorrect|still broken|try again)\b/i
const CHECK = /\b(?:test|typecheck|tsc|pytest|vitest|lint|build)\b/
const SHELL = /^(?:shell|bash|exec_command)$/

/**
 * `ctx.session.context()` の結果から、振り返りに必要な材料を作る。
 *
 * - チェックポイントより後を「今回の対象」、その直前の数件を「直前の文脈」として原文で渡す。
 * - それより古い会話は、役割・短い抜粋・ツール名だけの要約にする（Hermes の `_digest_history` 相当）。
 * - 予算を超える場合は新しいメッセージを優先し、はみ出した分は要約へ回す。
 * - 各断片は伏せてから切り詰め、境界で分割された秘密がモデルへ漏れないようにする。
 */
export function extractTranscript(messages: readonly unknown[], options: TranscriptOptions = {}): Transcript {
  const budget = options.budget ?? DEFAULT_BUDGET
  const overlap = options.overlap ?? DEFAULT_OVERLAP
  const rows = messages
    .map((value, index) => ({ index, message: value && typeof value === "object" ? value as RawMessage : undefined }))
    .filter((row): row is { index: number; message: RawMessage } => row.message !== undefined)
  const idOf = (row: { index: number; message: RawMessage }) =>
    typeof row.message.id === "string" && row.message.id ? row.message.id : `#${row.index}`

  const found = options.checkpoint ? rows.findIndex((row) => idOf(row) === options.checkpoint) : -1
  const newStart = found >= 0 ? found + 1 : 0
  const contextStart = Math.max(0, newStart - overlap)

  const signals: TranscriptSignals = { failures: 0, corrections: 0, edits: 0, checks: 0, research: 0 }
  const consultedSkills = new Set<string>()
  let toolCalls = 0
  let toolIterations = 0
  let userTurns = 0

  rows.forEach((row, position) => {
    const message = row.message
    const isNew = position >= newStart
    if (message.type === "user" && typeof message.text === "string") {
      if (userTurns++ > 0 && isNew && CORRECTION.test(message.text)) signals.corrections++
      return
    }
    if (message.type === "skill" && typeof message.name === "string") consultedSkills.add(message.name)
    if (message.type !== "assistant") return
    const calls = toolCallsOf(message)
    for (const call of calls) {
      const skill = consultedSkill(call)
      if (skill) consultedSkills.add(skill)
    }
    if (!isNew) return
    if (calls.length > 0) toolIterations++
    for (const call of calls) {
      toolCalls++
      if (call.status === "error") signals.failures++
      if (/^(?:write|edit|patch|apply_patch)$/.test(call.tool)) signals.edits++
      if (SHELL.test(call.tool) && CHECK.test(commandOf(call.input))) signals.checks++
      if (/^(?:websearch|webfetch)$/.test(call.tool)) signals.research++
    }
  })

  // 新しい側から原文で詰め、入りきらない古いメッセージは要約にする。
  const fullBudget = Math.floor(budget * 0.8)
  const full: { position: number; text: string }[] = []
  let used = 0
  let fullFrom = rows.length
  const window = rows.slice(contextStart)
  const rendered = renderFull(window)
  for (let index = window.length - 1; index >= 0; index--) {
    const text = rendered[index]
    if (!text) {
      fullFrom = contextStart + index
      continue
    }
    if (used + text.length + 1 > fullBudget) break
    full.unshift({ position: contextStart + index, text })
    used += text.length + 1
    fullFrom = contextStart + index
  }

  const digestLines: string[] = []
  for (let position = 0; position < fullFrom; position++) {
    const line = renderDigest(rows[position].message)
    if (line) digestLines.push(line)
  }
  const digest = takeTail(digestLines, Math.max(0, budget - used - 400))

  const sections: string[] = []
  if (digest.length > 0) {
    const label = fullFrom > newStart
      ? "## 古い経緯の要約（今回の対象の前半も含む。抜粋のみ）"
      : "## 振り返り済みの経緯（要約。文脈としてだけ使う）"
    sections.push([label, ...digest].join("\n"))
  }
  const context = full.filter((row) => row.position < newStart).map((row) => row.text)
  if (context.length > 0) sections.push(["## 直前の文脈（振り返り済み。ここからは新しい教訓を作らない）", ...context].join("\n"))
  const current = full.filter((row) => row.position >= newStart).map((row) => row.text)
  if (current.length > 0) {
    const label = found >= 0 ? "## 今回の振り返り対象（前回の振り返り以降の会話）" : "## 今回の振り返り対象"
    sections.push([label, ...current].join("\n"))
  }

  const last = rows.at(-1)
  return {
    text: sections.join("\n\n"),
    toolCalls,
    toolIterations,
    newMessages: rows.length - newStart,
    ...(last ? { lastMessageID: idOf(last) } : {}),
    checkpointFound: found >= 0,
    signals,
    consultedSkills: [...consultedSkills],
    recoveries: findRecoveries(rows.slice(contextStart).map((row) => row.message)),
  }
}

export interface LearningDecision {
  learn: boolean
  reason: string
}

/**
 * Hermes の creation_nudge_interval と同じく、ツール反復の累積で振り返りを起動する。
 * 前回の振り返り以降の反復だけを数えるので、短い作業が続いても累積して閾値に届く。
 * ユーザーの訂正は学習差分になりやすいため、閾値前でも振り返る（このプラグイン独自の拡張）。
 */
export function assessLearning(transcript: Transcript, interval: number): LearningDecision {
  const { signals, toolIterations } = transcript
  if (transcript.newMessages === 0) return { learn: false, reason: "前回の振り返り以降に新しい会話がありません" }
  if (toolIterations >= interval) return { learn: true, reason: `ツール反復が ${toolIterations} 回に達したため振り返り（目安 ${interval} 回）` }
  if (signals.corrections > 0 && toolIterations > 0) return { learn: true, reason: "ユーザーの訂正に学習差分があるか確認" }
  return { learn: false, reason: `ツール反復 ${toolIterations}/${interval} 回。次の完了時に累積して判定` }
}

function renderFull(rows: readonly { message: RawMessage }[]): string[] {
  // 一度失敗したツールは、後の成功結果も残す（失敗→修正→成功の経緯を読めるようにする）。
  const failedBefore = new Set<string>()
  return rows.map(({ message }) => {
    if (message.type === "user" && typeof message.text === "string") return `[user] ${clip(message.text)}`
    if (message.type === "skill" && typeof message.name === "string") return `[skill loaded] ${clip(message.name, 120)}`
    if (message.type === "compaction" && typeof message.summary === "string") return `[compaction summary] ${clip(message.summary, 1_500)}`
    if (message.type === "shell" && typeof message.command === "string") {
      const exit = typeof message.exit === "number" ? ` (exit ${message.exit})` : ""
      const output = outputText(message.output)
      return `[user shell] ${clip(message.command, 300)}${exit}${output ? ` → ${clip(output, 300)}` : ""}`
    }
    if (message.type !== "assistant" || !Array.isArray(message.content)) return ""
    const lines: string[] = []
    for (const entry of message.content as unknown[]) {
      if (!entry || typeof entry !== "object") continue
      const part = entry as RawPart
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) lines.push(`[assistant] ${clip(part.text)}`)
    }
    for (const call of toolCallsOf(message)) {
      const input = call.input === undefined ? "" : ` ${clip(safeStringify(call.input), 400)}`
      if (call.status === "error") {
        failedBefore.add(call.tool)
        lines.push(`[tool ${call.name}] (failed)${input}${call.error ? ` → error: ${clip(call.error, 300)}` : ""}`)
        continue
      }
      // 結果は、成功確認に使うコマンドと、失敗の後の再試行だけを残す。読み取り結果の全文は運ばない。
      const showOutput = call.output && (SHELL.test(call.tool) || failedBefore.has(call.tool))
      lines.push(`[tool ${call.name}]${input}${showOutput ? ` → ok: ${clip(call.output, 240)}` : ""}`)
    }
    return lines.join("\n")
  })
}

function renderDigest(message: RawMessage): string {
  if (message.type === "user" && typeof message.text === "string") return `- user: ${clip(message.text, 160)}`
  if (message.type === "skill" && typeof message.name === "string") return `- skill loaded: ${clip(message.name, 80)}`
  if (message.type === "compaction" && typeof message.summary === "string") return `- compaction summary: ${clip(message.summary, 400)}`
  if (message.type === "shell" && typeof message.command === "string") return `- user shell: ${clip(message.command, 120)}`
  if (message.type !== "assistant" || !Array.isArray(message.content)) return ""
  const text = (message.content as unknown[])
    .map((entry) => entry && typeof entry === "object" && (entry as RawPart).type === "text" ? (entry as RawPart).text : undefined)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
  const counts = new Map<string, { calls: number; failed: number }>()
  for (const call of toolCallsOf(message)) {
    const row = counts.get(call.tool) ?? { calls: 0, failed: 0 }
    row.calls++
    if (call.status === "error") row.failed++
    counts.set(call.tool, row)
  }
  const tools = [...counts].map(([tool, row]) => `${tool}×${row.calls}${row.failed ? `(failed ${row.failed})` : ""}`).join(", ")
  if (!text && !tools) return ""
  return `- assistant: ${text ? clip(text, 160) : ""}${tools ? `${text ? " / " : ""}tools: ${tools}` : ""}`
}

/** 失敗したツールが、後で同じ種類の呼び出しで成功した経緯を拾う。判断はモデルが会話本文で行う。 */
function findRecoveries(messages: readonly RawMessage[]): string[] {
  const open = new Map<string, { error: string; step: number }>()
  const found: string[] = []
  let step = 0
  for (const message of messages) {
    if (message.type !== "assistant") continue
    const calls = toolCallsOf(message)
    if (calls.length === 0) continue
    step++
    for (const call of calls) {
      const key = recoveryKey(call)
      if (call.status === "error") {
        if (!open.has(key)) open.set(key, { error: call.error, step })
        continue
      }
      if (call.status !== "completed") continue
      const failure = open.get(key)
      if (!failure) continue
      open.delete(key)
      const gap = step - failure.step
      found.push(`${key}: 失敗「${clip(failure.error || "理由不明", 120)}」→ ${gap === 0 ? "同じステップ内で" : `${gap} ステップ後に`}成功`)
      if (found.length >= MAX_RECOVERIES) return found
    }
  }
  for (const [key, failure] of open) {
    if (found.length >= MAX_RECOVERIES) break
    found.push(`${key}: 失敗「${clip(failure.error || "理由不明", 120)}」→ 未解決（成功手順として扱わない）`)
  }
  return found
}

function recoveryKey(call: ToolCall): string {
  if (!SHELL.test(call.tool)) return call.tool
  const command = commandOf(call.input).trim().split(/\s+/).slice(0, 2).join(" ")
  return command ? `${call.tool} \`${clip(command, 60)}\`` : call.tool
}

function toolCallsOf(message: RawMessage): ToolCall[] {
  if (!Array.isArray(message.content)) return []
  const calls: ToolCall[] = []
  for (const entry of message.content as unknown[]) {
    if (!entry || typeof entry !== "object") continue
    const part = entry as RawPart
    if (part.type !== "tool") continue
    const name = typeof part.name === "string" ? part.name : "tool"
    const state = part.state && typeof part.state === "object" ? part.state as RawToolState : undefined
    calls.push({
      name,
      tool: name.split(".").pop() ?? name,
      status: typeof state?.status === "string" ? state.status : "",
      input: state?.input,
      output: outputText(state?.content),
      error: errorText(state?.error),
    })
  }
  return calls
}

function consultedSkill(call: ToolCall): string | undefined {
  if (!call.input || typeof call.input !== "object") return undefined
  const input = call.input as { id?: unknown; name?: unknown; path?: unknown }
  const skill = /^(?:skill|skill_view)$/.test(call.tool) ? input.id ?? input.name :
    call.tool === "read" && typeof input.path === "string" ? /\/skills\/([^/]+)\/SKILL\.md$/.exec(input.path)?.[1] : undefined
  return typeof skill === "string" ? skill : undefined
}

function commandOf(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const value = (input as { command?: unknown; cmd?: unknown }).command ?? (input as { cmd?: unknown }).cmd
  return typeof value === "string" ? value : ""
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value
    .map((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text" ? (item as { text?: unknown }).text : undefined)
    .filter((text): text is string => typeof text === "string")
    .join("\n")
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    const message = (value as { message?: unknown }).message
    if (typeof message === "string") return message
    return safeStringify(value)
  }
  return ""
}

function takeTail(lines: readonly string[], max: number): string[] {
  const kept: string[] = []
  let used = 0
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (used + line.length + 1 > max) break
    kept.unshift(line)
    used += line.length + 1
  }
  return kept
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
