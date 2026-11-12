import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, sep } from "node:path"
import type { CuratorItem } from "./contract.ts"
import { codeOf, isEnoent } from "./fs.ts"
import { withFileLock } from "./lock.ts"
import type { SkillSummary } from "./skills.ts"

/**
 * Skill ごとの利用状況。Hermes の `.usage.json` に合わせ、作成者・更新世代・更新後の再利用を追う。
 * 本文や会話は保存しない。
 */
export interface SkillUsage {
  useCount: number
  patchCount: number
  /** 承認で書き換えた回数。create も 1 世代と数える。 */
  patchGeneration: number
  /** 最後に使われたときの patchGeneration。更新後に使われたかの判定に使う。 */
  lastReusedPatchGeneration: number
  lastUsedAt?: number
  lastPatchedAt?: number
  createdAt?: number
  /** agent はこのプラグインの承認で作成した Skill。Curator はこれだけを整理候補にする。 */
  createdBy: "agent" | "unknown"
  pinned: boolean
  state: "active" | "archived"
  originalPath?: string
  archivedPath?: string
  archivedAt?: number
}

interface UsageFile {
  version: 1
  skills: Record<string, SkillUsage>
}

export interface CuratorOptions {
  staleDays: number
  archiveDays: number
}

const DAY = 24 * 60 * 60 * 1000

export class UsageStore {
  private readonly file: string
  private readonly dataDir: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.file = join(dataDir, "usage.json")
  }

  async all(): Promise<Record<string, SkillUsage>> {
    return (await this.read()).skills
  }

  /** `session.skill.activated` を受けたときに呼ぶ。 */
  recordUse(name: string, at = Date.now()): Promise<void> {
    return this.update(name, (row) => ({
      ...row,
      useCount: row.useCount + 1,
      lastUsedAt: at,
      lastReusedPatchGeneration: row.patchGeneration,
    }))
  }

  /** 承認して SKILL.md を書いたときに呼ぶ。 */
  recordApproved(name: string, kind: "create" | "patch", targetPath: string, at = Date.now()): Promise<void> {
    return this.update(name, (row) => ({
      ...row,
      patchCount: kind === "patch" ? row.patchCount + 1 : row.patchCount,
      patchGeneration: row.patchGeneration + 1,
      lastPatchedAt: at,
      ...(kind === "create" ? { createdAt: at, createdBy: "agent" as const } : {}),
      originalPath: targetPath,
    }))
  }

  setPinned(name: string, pinned: boolean): Promise<void> {
    return this.update(name, (row) => ({ ...row, pinned }))
  }

  markArchived(name: string, originalPath: string, archivedPath: string, at = Date.now()): Promise<void> {
    return this.update(name, (row) => ({ ...row, state: "archived", originalPath, archivedPath, archivedAt: at }))
  }

  markRestored(name: string, at = Date.now()): Promise<void> {
    return this.update(name, (row) => {
      const { archivedPath: _archived, archivedAt: _at, ...rest } = row
      // 復元直後に再びアーカイブ候補へ戻らないよう、最終利用を復元時刻にする。
      return { ...rest, state: "active", lastUsedAt: at }
    })
  }

  private update(name: string, change: (row: SkillUsage) => SkillUsage): Promise<void> {
    return withFileLock(`${this.file}.lock`, async () => {
      const file = await this.read()
      file.skills[name] = change(file.skills[name] ?? emptyUsage())
      await mkdir(this.dataDir, { recursive: true })
      const temp = `${this.file}.${crypto.randomUUID()}.tmp`
      try {
        await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
        await rename(temp, this.file)
      } finally {
        await rm(temp, { force: true })
      }
    })
  }

  private async read(): Promise<UsageFile> {
    let text: string
    try {
      text = await readFile(this.file, "utf8")
    } catch (cause) {
      if (isEnoent(cause)) return { version: 1, skills: {} }
      throw new Error("Skill の利用統計（usage.json）を読み取れません")
    }
    const parsed = JSON.parse(text) as Partial<UsageFile>
    if (parsed?.version !== 1 || !parsed.skills || typeof parsed.skills !== "object") {
      throw new Error("Skill の利用統計（usage.json）の形式が不正です")
    }
    const skills: Record<string, SkillUsage> = {}
    for (const [name, row] of Object.entries(parsed.skills)) skills[name] = { ...emptyUsage(), ...row }
    return { version: 1, skills }
  }
}

export function emptyUsage(): SkillUsage {
  return {
    useCount: 0,
    patchCount: 0,
    patchGeneration: 0,
    lastReusedPatchGeneration: 0,
    createdBy: "unknown",
    pinned: false,
    state: "active",
  }
}

/**
 * Hermes の Curator の第1段階（ルールベース）。
 * このプラグインが作った Skill だけを対象に、最終活動から staleDays で「しばらく未使用」、
 * archiveDays で「アーカイブ候補」にする。手作業の Skill やピン留めした Skill は候補にしない。
 * ここでは判定だけを行い、移動はユーザーの操作でだけ実行する。
 */
export function curatorView(
  skills: readonly SkillSummary[],
  usage: Record<string, SkillUsage>,
  options: CuratorOptions,
  now = Date.now(),
): CuratorItem[] {
  const items: CuratorItem[] = []
  const seen = new Set<string>()
  for (const skill of skills) {
    if (skill.readError) continue
    seen.add(skill.name)
    const row = usage[skill.name] ?? emptyUsage()
    if (row.useCount === 0 && row.createdBy !== "agent" && row.patchGeneration === 0) continue
    items.push(toItem(skill.name, skill.path, row, options, now))
  }
  for (const [name, row] of Object.entries(usage)) {
    if (seen.has(name) || row.state !== "archived") continue
    items.push(toItem(name, row.archivedPath, row, options, now))
  }
  const order = { "archive-candidate": 0, stale: 1, active: 2, archived: 3 } as const
  return items.sort((left, right) => order[left.status] - order[right.status] || right.useCount - left.useCount || left.name.localeCompare(right.name))
}

function toItem(name: string, path: string | undefined, row: SkillUsage, options: CuratorOptions, now: number): CuratorItem {
  const managed = row.createdBy === "agent"
  const lastActivityAt = Math.max(row.lastUsedAt ?? 0, row.lastPatchedAt ?? 0, row.createdAt ?? 0) || undefined
  const idle = lastActivityAt ? now - lastActivityAt : 0
  const status: CuratorItem["status"] = row.state === "archived" ? "archived" :
    !managed || row.pinned || !lastActivityAt ? "active" :
    idle >= options.archiveDays * DAY ? "archive-candidate" :
    idle >= options.staleDays * DAY ? "stale" : "active"
  return {
    name,
    ...(path ? { path } : {}),
    status,
    managed,
    pinned: row.pinned,
    useCount: row.useCount,
    patchCount: row.patchCount,
    reusedAfterPatch: row.patchGeneration > 0 && row.lastReusedPatchGeneration >= row.patchGeneration,
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
    ...(lastActivityAt ? { lastActivityAt } : {}),
    ...(row.archivedAt ? { archivedAt: row.archivedAt } : {}),
  }
}

export type MoveResult = { ok: true; path: string } | { ok: false; reason: string }

/**
 * Skill のフォルダをデータ領域のアーカイブへ移す。削除はしない。
 * skillsDir 直下の実フォルダ（シンボリックリンクでない）だけを対象にする。
 */
export async function archiveSkillDir(skillPath: string, skillsDir: string, archiveRoot: string, now = Date.now()): Promise<MoveResult> {
  const dir = dirname(skillPath)
  const checked = await checkSkillDir(dir, skillsDir)
  if (checked) return { ok: false, reason: checked }
  const target = join(archiveRoot, `${basename(dir)}-${new Date(now).toISOString().replace(/[:.]/g, "-")}`)
  try {
    await mkdir(archiveRoot, { recursive: true })
    await move(dir, target)
  } catch (cause) {
    return { ok: false, reason: `アーカイブへ移動できませんでした (${codeOf(cause) ?? "unknown"})` }
  }
  return { ok: true, path: target }
}

/** アーカイブから元の場所へ戻す。元の場所に同名のフォルダがあれば上書きしない。 */
export async function restoreSkillDir(archivedPath: string, originalSkillPath: string, archiveRoot: string): Promise<MoveResult> {
  const archived = await realpath(archivedPath).catch(() => undefined)
  const root = await realpath(archiveRoot).catch(() => undefined)
  if (!archived || !root || !isInside(archived, root)) return { ok: false, reason: "アーカイブが見つかりません" }
  const dir = dirname(originalSkillPath)
  try {
    await lstat(dir)
    return { ok: false, reason: "元の場所に同名の Skill があるため復元しません" }
  } catch (cause) {
    if (!isEnoent(cause)) return { ok: false, reason: `元の場所を確認できません (${codeOf(cause) ?? "unknown"})` }
  }
  try {
    await mkdir(dirname(dir), { recursive: true })
    await move(archived, dir)
  } catch (cause) {
    return { ok: false, reason: `復元できませんでした (${codeOf(cause) ?? "unknown"})` }
  }
  return { ok: true, path: dir }
}

async function checkSkillDir(dir: string, skillsDir: string): Promise<string | undefined> {
  let info
  try {
    info = await lstat(dir)
  } catch (cause) {
    return isEnoent(cause) ? "Skill のフォルダが見つかりません" : `Skill のフォルダを確認できません (${codeOf(cause) ?? "unknown"})`
  }
  if (info.isSymbolicLink()) return "シンボリックリンクの Skill は移動しません"
  if (!info.isDirectory()) return "Skill のフォルダではありません"
  const root = await realpath(skillsDir).catch(() => undefined)
  const real = await realpath(dir).catch(() => undefined)
  if (!root || !real || dirname(real) !== root) return "skills フォルダ直下の Skill だけを移動できます"
  return undefined
}

async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (cause) {
    if (codeOf(cause) !== "EXDEV") throw cause
    await cp(from, to, { recursive: true, errorOnExist: true, force: false })
    await rm(from, { recursive: true, force: true })
  }
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep)
}
