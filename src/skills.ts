import { readdir, readFile, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { codeOf, isEnoent } from "./fs.ts"
import { redactSecrets } from "./redact.ts"

export interface SkillSummary {
  /** frontmatter の name。フォルダ名と一致しないことがある。 */
  name: string
  description: string
  /** 実際に列挙した SKILL.md のパス。name から組み立て直さない。 */
  path: string
  /** シンボリックリンク経由で読んでいるか。 */
  symlink: boolean
  /** ENOENT 以外の読み取り失敗。モデルへ渡さない根拠として残す。 */
  readError?: string
}

/** `~/.config/opencode/skills/` の SKILL.md を走査して一覧を作る。YAML パーサは追加しない。 */
export async function listSkills(skillsDir: string): Promise<SkillSummary[]> {
  let entries
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const skills: SkillSummary[] = []
  for (const entry of entries) {
    // skills/ の多くはシンボリックリンクなので、Dirent ではなくリンク先で判定する。
    const symlink = entry.isSymbolicLink()
    if (!entry.isDirectory() && !symlink) continue
    const path = join(skillsDir, entry.name, "SKILL.md")

    if (symlink) {
      try {
        if (!(await stat(join(skillsDir, entry.name))).isDirectory()) continue
      } catch (cause) {
        skills.push({
          name: entry.name,
          description: "",
          path,
          symlink: true,
          readError: `リンク先を確認できません (${codeOf(cause) ?? "unknown"})`,
        })
        continue
      }
    }

    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch (cause) {
      // 権限・EIO・EISDIR などを「ファイルがない」と扱わない。
      skills.push({
        name: entry.name,
        description: "",
        path,
        symlink,
        readError: isEnoent(cause)
          ? "SKILL.md がありません"
          : `SKILL.md を読めません (${codeOf(cause) ?? "unknown"})`,
      })
      continue
    }

    const front = frontmatter(text)
    skills.push({
      name: front.name || entry.name,
      // 切る前に全文を伏せる。既存 Skill 本文の秘密をモデルへ運ばない。
      description: redactSecrets(front.description || firstLine(text)).slice(0, 300),
      path,
      symlink,
    })
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name))
}

export interface SkillPathResolution {
  path?: string
  /** 同名・別名が衝突し、対象を一意に決められない。 */
  ambiguous: boolean
}

/**
 * frontmatter の name（またはフォルダ名）から、列挙済みの実際の SKILL.md パスを引く。
 * name とフォルダ名が違う Skill も正しく解決する。
 * 候補が複数ある場合は推測せず ambiguous を返し、誤選択を防ぐ。
 */
export function resolveSkillPath(
  skills: readonly SkillSummary[],
  name: string,
): SkillPathResolution {
  if (!name) return { ambiguous: false }
  const paths = new Set<string>()
  for (const skill of skills) {
    if (skill.readError) continue
    if (skill.name !== name && basename(dirname(skill.path)) !== name) continue
    paths.add(skill.path)
  }
  if (paths.size === 0) return { ambiguous: false }
  if (paths.size > 1) return { ambiguous: true }
  return { path: [...paths][0], ambiguous: false }
}

function frontmatter(text: string): { name: string; description: string } {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(text)
  if (!match) return { name: "", description: "" }
  const read = (key: string) => {
    const found = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(match[1])
    if (!found) return ""
    return found[1].trim().replace(/^["']|["']$/g, "")
  }
  return { name: read("name"), description: read("description") }
}

function firstLine(text: string): string {
  const body = text.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "")
  const line = body.split("\n").find((value) => value.trim() && !value.startsWith("#"))
  return (line ?? "").trim()
}
