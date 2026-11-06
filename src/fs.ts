import { lstat, mkdir, readFile } from "node:fs/promises"

/** Node のファイルエラーから code だけを安全に取り出す。 */
export function codeOf(cause: unknown): string | undefined {
  if (cause && typeof cause === "object" && "code" in cause) {
    const value = (cause as { code: unknown }).code
    return typeof value === "string" ? value : undefined
  }
  return undefined
}

export function isEnoent(cause: unknown): boolean {
  return codeOf(cause) === "ENOENT"
}

export type ExistingFile =
  | { kind: "missing" }
  | { kind: "ok"; text: string; symlink: boolean; mode: number }
  | { kind: "error"; message: string }

/**
 * 既存ファイルを読む。ENOENT だけを「存在しない」と扱い、
 * EACCES / EPERM / EIO / EISDIR / ELOOP などはエラーとして返す。
 * シンボリックリンクは読み取り用に許容するが、書き込み先としては symlink: true で明示する。
 */
export async function readExisting(path: string): Promise<ExistingFile> {
  let info
  try {
    info = await lstat(path)
  } catch (cause) {
    if (isEnoent(cause)) return { kind: "missing" }
    return { kind: "error", message: `ファイル情報を取得できません (${codeOf(cause) ?? "unknown"})` }
  }

  if (!info.isFile() && !info.isSymbolicLink()) {
    return { kind: "error", message: "通常ファイルではありません" }
  }

  try {
    const text = await readFile(path, "utf8")
    return { kind: "ok", text, symlink: info.isSymbolicLink(), mode: info.mode }
  } catch (cause) {
    return { kind: "error", message: `ファイルを読み取れません (${codeOf(cause) ?? "unknown"})` }
  }
}

/**
 * 書き込み先の親ディレクトリを検証する。
 * 既存の skills/ はエントリ自体がシンボリックリンクなので、親 symlink は許容する。
 * SKILL.md 本体が symlink なのは readExisting 側で拒否する。
 */
export async function ensureWritableParent(dir: string): Promise<string | undefined> {
  try {
    const info = await lstat(dir)
    if (!info.isDirectory() && !info.isSymbolicLink()) return "親がディレクトリではありません"
    return undefined
  } catch (cause) {
    if (!isEnoent(cause)) return `親を確認できません (${codeOf(cause) ?? "unknown"})`
  }
  try {
    await mkdir(dir, { recursive: true })
    return undefined
  } catch (cause) {
    return `親を作成できません (${codeOf(cause) ?? "unknown"})`
  }
}
