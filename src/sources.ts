import { lstat, readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { codeOf } from "./fs.ts"
import { redactAndClip, redactSecrets } from "./redact.ts"

/** `/learn` に渡された依頼から集めた資料。本文は伏せ字済み。 */
export interface LearnSource {
  kind: "url" | "file" | "directory"
  label: string
  text: string
  error?: string
}

export interface GatherOptions {
  /** 相対パスの基準。通常はセッションの作業フォルダ。 */
  baseDir?: string
  /** テスト用に差し替えられる fetch。 */
  fetch?: typeof fetch
  /** 資料1件あたりの文字数の上限。 */
  maxPerSource?: number
  /** URL とパスの合計件数の上限。 */
  maxSources?: number
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`）)\]」』]+/g
const PATH_PATTERN = /(?:^|[\s"'`（(「『])((?:~\/|\.{1,2}\/|\/)[^\s"'`）)\]」』]+)/g
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".venv", "venv", "__pycache__", "target", ".cache"])
const KEY_FILES = ["README.md", "README", "readme.md", "AGENTS.md", "CLAUDE.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"]
/** 秘密情報を含みやすいファイルは読まない。 */
const SECRET_FILE = /(?:^|\/)(?:\.env(?:\..*)?|.*\.pem|.*\.key|id_(?:rsa|ed25519|ecdsa)|service\.json|credentials(?:\.json)?|\.npmrc|\.netrc|auth\.json)$/i
const MAX_FILE_BYTES = 1_000_000
const MAX_FETCH_CHARS = 400_000

/** 依頼文から URL とローカルパスを拾い、資料を集める。会話・Web・ファイルの中身はすべて信頼しない入力として扱う。 */
export async function gatherSources(request: string, options: GatherOptions = {}): Promise<LearnSource[]> {
  const maxPer = options.maxPerSource ?? 12_000
  const maxSources = options.maxSources ?? 5
  const urls = [...new Set([...request.matchAll(URL_PATTERN)].map((match) => trimTrailing(match[0])))]
  const withoutUrls = request.replace(URL_PATTERN, " ")
  const paths = [...new Set([...withoutUrls.matchAll(PATH_PATTERN)].map((match) => trimTrailing(match[1])))]

  const sources: LearnSource[] = []
  for (const url of urls.slice(0, maxSources)) sources.push(await fetchSource(url, options.fetch ?? fetch, maxPer))
  for (const path of paths.slice(0, Math.max(0, maxSources - sources.length))) {
    sources.push(await readSource(expandPath(path, options.baseDir), path, maxPer))
  }
  return sources
}

async function fetchSource(url: string, fetcher: typeof fetch, max: number): Promise<LearnSource> {
  try {
    const response = await fetcher(url, {
      headers: { "user-agent": "opencode-skill-learn", accept: "text/html,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return { kind: "url", label: url, text: "", error: `HTTP ${response.status}` }
    const type = response.headers.get("content-type") ?? ""
    if (!/text|json|xml|markdown/i.test(type) && type) return { kind: "url", label: url, text: "", error: `本文として読めない形式です (${type})` }
    const raw = (await response.text()).slice(0, MAX_FETCH_CHARS)
    const text = /html/i.test(type) || /^\s*<(?:!doctype|html)/i.test(raw) ? htmlToText(raw) : raw
    return { kind: "url", label: url, text: redactAndClip(text, max) }
  } catch (cause) {
    return { kind: "url", label: url, text: "", error: `取得できませんでした (${cause instanceof Error ? cause.name : "unknown"})` }
  }
}

async function readSource(path: string, label: string, max: number): Promise<LearnSource> {
  if (SECRET_FILE.test(path)) return { kind: "file", label, text: "", error: "秘密情報を含みやすいファイルのため読みません" }
  let info
  try {
    info = await lstat(path)
  } catch (cause) {
    return { kind: "file", label, text: "", error: `見つかりません (${codeOf(cause) ?? "unknown"})` }
  }
  if (info.isFile()) {
    if (info.size > MAX_FILE_BYTES) return { kind: "file", label, text: "", error: "大きすぎるため読みません" }
    try {
      return { kind: "file", label, text: redactAndClip(await readFile(path, "utf8"), max) }
    } catch (cause) {
      return { kind: "file", label, text: "", error: `読み取れません (${codeOf(cause) ?? "unknown"})` }
    }
  }
  if (!info.isDirectory()) return { kind: "file", label, text: "", error: "通常のファイルやフォルダではありません" }

  const listing = await listTree(path, 2, 150)
  const parts = [`# フォルダ構成（最大 150 件）\n${listing.join("\n")}`]
  let used = parts[0].length
  for (const name of KEY_FILES) {
    const file = join(path, name)
    if (SECRET_FILE.test(file)) continue
    try {
      const stat = await lstat(file)
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue
      const text = redactAndClip(await readFile(file, "utf8"), Math.min(6_000, Math.max(0, max - used)))
      if (!text) break
      parts.push(`# ${name}\n${text}`)
      used += text.length
    } catch {
      // 無いファイルは飛ばす。
    }
    if (used >= max) break
  }
  return { kind: "directory", label, text: redactSecrets(parts.join("\n\n")).slice(0, max) }
}

async function listTree(root: string, depth: number, limit: number): Promise<string[]> {
  const lines: string[] = []
  const walk = async (dir: string, prefix: string, level: number) => {
    if (lines.length >= limit) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (lines.length >= limit) return
      if (SKIP_DIRS.has(entry.name) || SECRET_FILE.test(entry.name)) continue
      const directory = entry.isDirectory()
      lines.push(`${prefix}${entry.name}${directory ? "/" : ""}`)
      if (directory && level < depth) await walk(join(dir, entry.name), `${prefix}  `, level + 1)
    }
  }
  await walk(root, "", 1)
  return lines
}

function expandPath(path: string, baseDir?: string): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  if (isAbsolute(path)) return path
  return resolve(baseDir ?? process.cwd(), path)
}

function trimTrailing(value: string): string {
  return value.replace(/[.,;:!?。、，．]+$/u, "")
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/pre)\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level: string) => `\n${"#".repeat(Number(level))} `)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim()
}

/** 資料をモデルへ渡す1つの本文にまとめる。 */
export function renderSources(sources: readonly LearnSource[]): string {
  return sources.map((source) => {
    const head = `## [${source.kind}] ${redactAndClip(source.label, 300)}`
    if (source.error) return `${head}\n（取得できませんでした: ${source.error}）`
    return `${head}\n${source.text || "（本文なし）"}`
  }).join("\n\n")
}
