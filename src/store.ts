import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ApproveResult, Detail, Proposal, RejectResult, Snapshot } from "./contract.ts"
import { ensureWritableParent, isEnoent, readExisting } from "./fs.ts"
import { hashText } from "./hash.ts"
import { withFileLock } from "./lock.ts"
import { lintProposal } from "./lint.ts"
import type { PreparedAction } from "./prepare.ts"
import {
  errorMessage,
  hasUnredactedSecrets,
  maskSecrets,
  redactSecrets,
  restoreMasked,
} from "./redact.ts"
import { sanitizeName } from "./review.ts"

export interface StoreOptions {
  dataDir: string
  skillsDir: string
  maxPending?: number
}

export interface AddResult {
  added: number
  merged: number
  skipped: number
  reason?: string
  stopped?: boolean
}

interface StoreFile {
  version: 1
  proposals: Proposal[]
}

type ReadState =
  | { kind: "ok"; file: StoreFile }
  | { kind: "missing" }
  | { kind: "corrupt"; reason: string }

const FILE_NAME = "pending.json"
const DEFAULT_MAX_PENDING = 12

/**
 * 提案データの唯一の書き込み口。
 *
 * 提案段階で既存本文へ統合した全文を作ってプレビューとして保持する。
 * 承認時は現在の SKILL.md を読み直し、表示した revision と baseHash が一致するときだけ
 * 同じ統合を再実行して反映する。既存本文・frontmatter は保持し、既存ファイルはバックアップする。
 */
export class ProposalStore {
  private readonly dataDir: string
  private readonly skillsDir: string
  private readonly maxPending: number
  private readonly file: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: StoreOptions) {
    this.dataDir = options.dataDir
    this.skillsDir = options.skillsDir
    this.maxPending = Math.max(1, options.maxPending ?? DEFAULT_MAX_PENDING)
    this.file = join(this.dataDir, FILE_NAME)
  }

  async list(): Promise<Snapshot> {
    const state = await this.read()
    const base = { proposals: [] as Proposal[], maxPending: this.maxPending, generatedAt: Date.now() }
    if (state.kind === "corrupt") return { ...base, corrupt: true, error: state.reason }
    if (state.kind === "missing") return base
    return {
      ...base,
      proposals: state.file.proposals.slice().sort((a, b) => b.updatedAt - a.updatedAt),
    }
  }

  async pendingCount(): Promise<number> {
    const state = await this.read()
    return state.kind === "ok" ? state.file.proposals.filter((item) => item.status === "pending").length : 0
  }

  async detail(id: string): Promise<Detail> {
    const state = await this.read()
    if (state.kind === "corrupt") return { found: false, readError: state.reason }
    const proposal = state.kind === "ok" ? state.file.proposals.find((item) => item.id === id) : undefined
    if (!proposal) return { found: false }

    // name から組み立て直さず、列挙で判明した実際のパスを使う。
    const targetPath = proposal.targetPath || this.targetPath(proposal.name)
    const existing = await readExisting(targetPath)
    let current = ""
    let readError: string | undefined
    let writable = false
    let targetChanged = false

    if (existing.kind === "ok") {
      // 秘密情報の検査は切る前の全文に対して行い、切り詰めた結果を検査に流用しない。
      const safe = redactSecrets(existing.text)
      if (hasUnredactedSecrets(safe)) {
        readError = "既存 SKILL.md に秘密情報の可能性があるため、内容の表示を省略しました"
      } else {
        current = safe.slice(0, 30_000)
      }
      writable = !existing.symlink
      targetChanged = Boolean(proposal.baseHash) && hashText(existing.text) !== proposal.baseHash
    } else if (existing.kind === "error") {
      readError = existing.message
    }

    return {
      found: true,
      proposal,
      current,
      targetPath,
      revision: revisionOf(proposal),
      ...(readError ? { readError } : {}),
      writable,
      targetChanged,
    }
  }

  /** 同じ Skill への pending は 1 件にまとめ、件数上限を超える新規提案は捨てる。 */
  add(actions: readonly PreparedAction[], source: { sessionID: string; title: string }): Promise<AddResult> {
    return this.locked(async () => {
      const state = await this.read()
      if (state.kind === "corrupt") {
        return {
          added: 0,
          merged: 0,
          skipped: actions.length,
          stopped: true,
          reason: `pending.json が壊れているため提案を保存しません: ${state.reason}`,
        }
      }

      const file = state.kind === "ok" ? state.file : empty()
      let pendingCount = file.proposals.filter((item) => item.status === "pending").length
      let added = 0
      let merged = 0
      let skipped = 0

      for (const action of actions) {
        const name = sanitizeName(action.name)
        if (!name || !action.body.trim() || !safeName(name)) {
          skipped++
          continue
        }
        if (action.action === "patch" && !action.baseHash) {
          skipped++
          continue
        }

        const fields = {
          title: redactSecrets(action.title),
          reason: redactSecrets(action.reason),
          body: redactSecrets(action.body),
          diff: redactSecrets(action.diff),
          ...(action.action === "patch"
            ? {
                section: redactSecrets(action.section ?? ""),
                baseHash: action.baseHash,
                secretCount: action.secretCount ?? 0,
              }
            : {}),
          ...(action.targetPath ? { targetPath: action.targetPath } : {}),
        }

        // 全文をそのまま検査する。切った差分は検査に流用しない。
        const full = `${fields.title}\n${fields.reason}\n${fields.body}\n${fields.diff}`
        if (hasUnredactedSecrets(full)) {
          skipped++
          continue
        }

        const redacted = [action.title, action.reason, action.body, action.diff].some(
          (value) => redactSecrets(value) !== value,
        )
        // リンターは「新しく加わる部分」だけを見る。統合後全文の長さで警告しない。
        const lintBody =
          action.action === "patch" && "section" in fields && typeof fields.section === "string"
            ? fields.section
            : fields.body
        const warnings = lintProposal({
          kind: action.action,
          title: fields.title,
          reason: fields.reason,
          body: lintBody,
          diff: fields.diff,
          redacted,
        })
        const id = `${action.action}:${name}`
        const existing = file.proposals.find((item) => item.id === id)

        if (existing && existing.status === "pending") {
          Object.assign(existing, fields, {
            warnings,
            updatedAt: Date.now(),
            sourceSessionID: source.sessionID,
            sourceTitle: source.title,
          })
          merged++
          continue
        }

        if (pendingCount >= this.maxPending) {
          skipped++
          continue
        }

        const now = Date.now()
        const next: Proposal = {
          id,
          kind: action.action,
          name,
          ...fields,
          warnings,
          sourceSessionID: source.sessionID,
          sourceTitle: source.title,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          status: "pending",
        }
        if (existing) {
          file.proposals[file.proposals.indexOf(existing)] = next
        } else {
          file.proposals.push(next)
        }
        pendingCount++
        added++
      }

      await this.write(file)
      const total = added + merged
      return {
        added,
        merged,
        skipped,
        ...(total === 0 ? { reason: "提案なし、または pending の上限に達しました" } : {}),
      }
    })
  }

  /**
   * 承認時に「提案段階で作った統合済み完成形」をそのまま反映する。
   *
   * 1. 表示した版（revision）と、表示した提案の baseHash が両方一致するか。
   * 2. 承認時点のターゲットを読み直し、baseHash の一致・create の非存在・symlink・親パスを検証する。
   * 3. 完成形のプレースホルダを、baseHash で同一性を確認した元ファイルの原文断片で復元する。
   *    モデルは再実行しない。原文の秘密情報は壊さず、表示・承認内容と完成形を一致させる。
   * 4. 既存ファイルをバックアップし、書き込み直前にターゲットを再確認する。
   * 5. status を先に確定してから temp + rename で反映する。
   *
   * 失敗はどの段階で止まったかを failedAt で返す。pending は残るので再試行できる。
   * 提案途中の失敗では一切書き込まない。
   */
  approve(id: string, revision: string, baseHash: string): Promise<ApproveResult> {
    return this.locked(async () => {
      const state = await this.read()
      if (state.kind === "corrupt") {
        return { ok: false, failedAt: "store", reason: `pending.json が壊れています: ${state.reason}` }
      }
      if (state.kind === "missing") {
        return { ok: false, failedAt: "store", reason: "提案が見つかりません" }
      }
      const file = state.file
      const proposal = file.proposals.find((item) => item.id === id)
      if (!proposal) return { ok: false, failedAt: "store", reason: "提案が見つかりません" }
      if (proposal.status !== "pending") {
        return { ok: false, failedAt: "store", reason: `すでに ${proposal.status} です` }
      }
      if (revisionOf(proposal) !== revision) {
        return {
          ok: false,
          failedAt: "revision",
          reason: "表示した提案と内容が変わりました。再度開いて確認してください",
        }
      }
      if ((proposal.baseHash ?? "") !== baseHash) {
        return {
          ok: false,
          failedAt: "revision",
          reason: "表示した提案の baseHash が一致しません。再度開いて確認してください",
        }
      }
      if (!safeName(proposal.name)) {
        return { ok: false, failedAt: "store", reason: "Skill 名が不正です" }
      }

      // name から組み立て直さず、列挙で判明した実際のパスを使う。
      const targetPath = proposal.targetPath || this.targetPath(proposal.name)
      const existing = await readExisting(targetPath)
      if (existing.kind === "error") {
        return { ok: false, failedAt: "target", reason: `対象を確認できません: ${existing.message}` }
      }
      if (existing.kind === "ok" && existing.symlink) {
        return { ok: false, failedAt: "target", reason: "SKILL.md がシンボリックリンクのため書き込みません" }
      }
      const parentError = await ensureWritableParent(dirname(targetPath))
      if (parentError) return { ok: false, failedAt: "target", reason: parentError }

      // 承認済みの完成形（プレースホルダ付き）。表示・保存・承認が共有する唯一の本文。
      const approvedMasked = redactSecrets(proposal.body)
      if (hasUnredactedSecrets(approvedMasked)) {
        return { ok: false, failedAt: "target", reason: "秘密情報の可能性が残っているため書き込みませんでした" }
      }

      let spans: string[] = []
      if (proposal.kind === "create") {
        if (existing.kind === "ok") {
          return { ok: false, failedAt: "target", reason: "同名の Skill がすでにあります。上書きを避けるため書き込みません" }
        }
      } else {
        if (existing.kind === "missing") {
          return { ok: false, failedAt: "target", reason: "更新先の SKILL.md がなくなっています。却下して振り返り直してください" }
        }
        if (!proposal.baseHash || hashText(existing.text) !== proposal.baseHash) {
          return {
            ok: false,
            failedAt: "target",
            reason: "提案のあとに SKILL.md が変更されました。上書きを避けるため書き込みません。却下して振り返り直してください",
          }
        }
        // 元ファイルは baseHash で同一性を確認済み。ここから原文断片を取り出して復元する。
        spans = maskSecrets(existing.text).spans
        if (spans.length !== (proposal.secretCount ?? 0)) {
          return {
            ok: false,
            failedAt: "restore",
            reason: "元ファイルの秘密情報の個数が提案と一致しません。原文を壊さないため書き込みません",
          }
        }
      }

      const body = restoreMasked(approvedMasked, spans)
      if (body === undefined) {
        return {
          ok: false,
          failedAt: "restore",
          reason: "完成形のプレースホルダを復元できませんでした。原文を壊さないため書き込みません",
        }
      }

      let backupPath: string | undefined
      if (existing.kind === "ok") {
        backupPath = join(
          this.dataDir,
          "backups",
          proposal.name,
          `${new Date().toISOString().replace(/[:.]/g, "-")}.md`,
        )
        try {
          await mkdir(dirname(backupPath), { recursive: true })
          // バックアップはユーザー専用のデータ領域に 0600 で置き、GUI にはパスだけを見せる。
          await writeFile(backupPath, existing.text, { encoding: "utf8", mode: 0o600 })
        } catch (cause) {
          return { ok: false, failedAt: "backup", reason: `バックアップに失敗しました: ${errorMessage(cause)}` }
        }
      }

      // 書き込み直前の再確認。協調ロック内の検査であり、外部の非協調プロセスは保証しない。
      const recheck = await readExisting(targetPath)
      if (proposal.kind === "patch") {
        if (recheck.kind !== "ok" || recheck.symlink || hashText(recheck.text) !== proposal.baseHash) {
          return { ok: false, failedAt: "target", reason: "書き込み直前に SKILL.md の変更を検知しました" }
        }
      } else if (recheck.kind !== "missing") {
        return { ok: false, failedAt: "target", reason: "書き込み直前に同名の Skill が作成されました" }
      }

      // 二重承認を防ぐため、書き込みより先に status を確定する。
      const now = Date.now()
      proposal.status = "approved"
      proposal.updatedAt = now
      proposal.resolvedAt = now
      try {
        await this.write(file)
      } catch (cause) {
        return { ok: false, failedAt: "store", reason: `提案データの更新に失敗しました: ${errorMessage(cause)}` }
      }

      try {
        await this.writeSkill(targetPath, body)
      } catch (cause) {
        proposal.status = "pending"
        proposal.updatedAt = Date.now()
        delete proposal.resolvedAt
        await this.write(file).catch(() => undefined)
        return { ok: false, failedAt: "write", reason: `SKILL.md の書き込みに失敗しました: ${errorMessage(cause)}` }
      }

      return {
        ok: true,
        targetPath,
        ...(backupPath ? { backupPath } : {}),
      }
    })
  }

  /** 却下は、画面に表示した版（revision）と一致するときだけ許可する。 */
  reject(id: string, revision: string): Promise<RejectResult> {
    return this.locked(async () => {
      const state = await this.read()
      if (state.kind === "corrupt") {
        return { ok: false, reason: `pending.json が壊れているため更新しません: ${state.reason}` }
      }
      if (state.kind === "missing") return { ok: false, reason: "提案が見つかりません" }
      const file = state.file
      const proposal = file.proposals.find((item) => item.id === id)
      if (!proposal) return { ok: false, reason: "提案が見つかりません" }
      if (proposal.status !== "pending") return { ok: false, reason: `すでに ${proposal.status} です` }
      if (revisionOf(proposal) !== revision) {
        return { ok: false, reason: "表示した提案と内容が変わりました。再度開いて確認してください" }
      }
      const now = Date.now()
      proposal.status = "rejected"
      proposal.updatedAt = now
      proposal.resolvedAt = now
      await this.write(file)
      return { ok: true }
    })
  }

  private async writeSkill(targetPath: string, body: string): Promise<void> {
    const tmp = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(tmp, body, { encoding: "utf8", mode: 0o644 })
      await rename(tmp, targetPath)
    } catch (cause) {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw cause
    }
  }

  private targetPath(name: string): string {
    return join(this.skillsDir, name, "SKILL.md")
  }

  /** 協調ロック + 同一インスタンス内の直列化。ロックを無視する他プロセスは防げない。 */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(`${this.file}.lock`, () => this.serialize(fn))
  }

  private async read(): Promise<ReadState> {
    let raw: string
    try {
      raw = await readFile(this.file, "utf8")
    } catch (cause) {
      if (isEnoent(cause)) return { kind: "missing" }
      return { kind: "corrupt", reason: "pending.json を読めません (EACCES 等)" }
    }
    try {
      const parsed = JSON.parse(raw) as StoreFile
      if (parsed?.version !== 1 || !Array.isArray(parsed.proposals)) {
        return { kind: "corrupt", reason: "pending.json の形式が不正です" }
      }
      return { kind: "ok", file: { version: 1, proposals: parsed.proposals.filter(isProposal) } }
    } catch {
      return { kind: "corrupt", reason: "pending.json を JSON として解釈できません" }
    }
  }

  private async write(file: StoreFile): Promise<void> {
    // 破損したファイルを空で上書きしないための二重ガード。
    const current = await this.read()
    if (current.kind === "corrupt") throw new Error("破損した pending.json は上書きしません")
    await mkdir(this.dataDir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8")
    await rename(tmp, this.file)
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }
}

/** 表示した提案の内容を識別する。ID だけでは版の入れ替わりを検出できない。 */
function revisionOf(proposal: Proposal): string {
  return hashText(
    JSON.stringify({
      id: proposal.id,
      kind: proposal.kind,
      name: proposal.name,
      title: proposal.title,
      reason: proposal.reason,
      body: proposal.body,
      diff: proposal.diff,
      warnings: proposal.warnings,
      section: proposal.section ?? "",
      baseHash: proposal.baseHash ?? "",
      status: proposal.status,
      updatedAt: proposal.updatedAt,
    }),
  )
}

function empty(): StoreFile {
  return { version: 1, proposals: [] }
}

function safeName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name) && !name.includes("..")
}

function isProposal(value: unknown): value is Proposal {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<Proposal>
  return (
    typeof item.id === "string" &&
    (item.kind === "create" || item.kind === "patch") &&
    typeof item.name === "string" &&
    typeof item.body === "string" &&
    typeof item.status === "string" &&
    Array.isArray(item.warnings) &&
    typeof item.createdAt === "number" &&
    typeof item.updatedAt === "number"
  )
}
