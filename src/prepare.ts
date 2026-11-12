import { dirname, join } from "node:path"
import type { ArchiveTarget, SkillFile } from "./contract.ts"
import { buildComposePrompt, validateComposedText } from "./compose.ts"
import { textDiff } from "./diff.ts"
import { readExisting } from "./fs.ts"
import { hashText } from "./hash.ts"
import { redactSecrets, maskSecrets } from "./redact.ts"
import type { ReviewAction } from "./review.ts"
import { resolveSkillPath, type SkillSummary } from "./skills.ts"

/**
 * 保存できる形に整えた提案。
 *
 * patch の body は「既存本文と教訓を統合した完成形の全文」（秘密情報はプレースホルダ）。
 * section は統合に使った教訓、secretCount はプレースホルダの個数、baseHash は原文のハッシュ。
 * create の body は新規 SKILL.md の全文。
 */
export interface PreparedAction extends ReviewAction {
  /** patch のとき、統合に使う教訓の節。 */
  section?: string
  /** patch のとき、提案時点の既存 SKILL.md のハッシュ。 */
  baseHash?: string
  /** patch のとき、完成形に含まれるプレースホルダの個数。 */
  secretCount?: number
  /** 列挙で判明した実際の SKILL.md パス。 */
  targetPath?: string
  /** 整理の提案のとき、承認後にアーカイブする Skill と提案時点のハッシュ。 */
  archives?: ArchiveTarget[]
  /** すでに存在するため除外した補助ファイル。上書きはしない。 */
  skippedFiles?: string[]
}

export interface PrepareOptions {
  skillsDir: string
  /** 列挙済みの Skill。name からパスを再構成せず、実際の path を使う。 */
  skills: readonly SkillSummary[]
  /** 統合済み全文を作るモデル呼び出し。承認時には再実行しない。 */
  generate: (prompt: string) => Promise<string>
}

export interface PrepareResult {
  actions: PreparedAction[]
  dropped: { name: string; reason: string }[]
}

const FRONTMATTER = /^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/

/**
 * 提案段階で、既存本文と教訓から統合済み全文を作る。
 *
 * - 既存本文は maskSecrets で秘密情報をプレースホルダに置き換えてからモデルへ渡す。
 * - モデルには意味の重複整理と、既存の節・文章の最小限の編集をさせる。
 *   既存全行の完全保存は要求しないが、frontmatter と無関係の内容は保持させる。
 * - 完成形はプレースホルダ付きで pending に置く。原文の秘密は pending にもモデルにも残らない。
 * - ここではファイルを一切書き換えない。失敗した提案は dropped として捨てる。
 */
export async function prepareActions(
  actions: readonly ReviewAction[],
  options: PrepareOptions,
): Promise<PrepareResult> {
  const prepared: PreparedAction[] = []
  const dropped: PrepareResult["dropped"] = []

  for (const action of actions) {
    const name = action.name
    const resolved = resolveSkillPath(options.skills, name)
    if (resolved.ambiguous) {
      dropped.push({ name, reason: "同名の Skill が複数あり、対象を一意に決められません" })
      continue
    }
    // 列挙済みなら実際の path。未列挙の新規 Skill だけ conventional なパスを使う。
    const path = resolved.path ?? join(options.skillsDir, name, "SKILL.md")

    const file = await readExisting(path)
    if (file.kind === "error") {
      dropped.push({ name, reason: file.message })
      continue
    }

    const lesson = redactSecrets(action.body).trim()
    if (!lesson) {
      dropped.push({ name, reason: "本文が空です" })
      continue
    }

    const support = await newSupportFiles(action.files, dirname(path))
    const extra = {
      ...(support.files.length > 0 ? { files: support.files } : { files: undefined }),
      ...(support.skipped.length > 0 ? { skippedFiles: support.skipped } : {}),
    }

    if (file.kind === "missing") {
      if (!FRONTMATTER.test(lesson)) {
        dropped.push({ name, reason: "更新先がなく、frontmatter もありません" })
        continue
      }
      prepared.push({
        ...action,
        ...extra,
        action: "create",
        body: lesson,
        diff: redactSecrets(action.diff),
        targetPath: path,
      })
      continue
    }

    const masked = maskSecrets(file.text)
    let raw: string
    try {
      raw = await options.generate(
        buildComposePrompt({
          name,
          existingMasked: masked.masked,
          secretCount: masked.spans.length,
          lesson,
          reason: redactSecrets(action.reason),
        }),
      )
    } catch (cause) {
      dropped.push({ name, reason: `統合に失敗しました: ${String(cause)}` })
      continue
    }

    const composed = validateComposedText(raw, masked.masked, masked.spans.length)
    if (composed.kind === "no-change") {
      dropped.push({ name, reason: "既存の本文ですでに書かれています" })
      continue
    }
    if (composed.kind === "invalid") {
      dropped.push({ name, reason: composed.reason })
      continue
    }

    // 表示も保存も承認も、この完成形を共有する。秘密はプレースホルダのまま。
    const diff = textDiff(redactSecrets(masked.masked), composed.text)
    prepared.push({
      ...action,
      ...extra,
      action: "patch",
      body: composed.text,
      diff,
      section: lesson,
      baseHash: hashText(file.text),
      secretCount: masked.spans.length,
      targetPath: path,
    })
  }

  return { actions: prepared, dropped }
}

/** 補助ファイルのうち、まだ存在しないものだけを残す。既存の補助ファイルは上書きしない。 */
async function newSupportFiles(files: readonly SkillFile[] | undefined, skillDir: string): Promise<{ files: SkillFile[]; skipped: string[] }> {
  const kept: SkillFile[] = []
  const skipped: string[] = []
  for (const file of files ?? []) {
    const existing = await readExisting(join(skillDir, file.path))
    if (existing.kind === "missing") kept.push({ path: file.path, content: redactSecrets(file.content) })
    else skipped.push(file.path)
  }
  return { files: kept, skipped }
}
