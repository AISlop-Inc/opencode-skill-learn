import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NO_CHANGE } from "../src/compose.ts"
import { hashText } from "../src/hash.ts"
import { prepareActions, type PrepareOptions } from "../src/prepare.ts"
import type { ReviewAction } from "../src/review.ts"
import { listSkills } from "../src/skills.ts"

const BODY =
  "## 手順\n既存の内容を確認する。\n無関係の記述その一。\n無関係の記述その一。\n無関係の記述その二。\n無関係の記述その三。\n"
const skillText = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: 既存\n---\n\n${BODY}${extra}`

let root = ""
let skillsDir = ""

beforeEach(async () => {
  const base = join(tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  root = await mkdtemp(join(base, "learn-prepare-"))
  skillsDir = join(root, "skills")
  await mkdir(skillsDir, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const createSkill = async (folder: string, name: string, extra = "") => {
  const dir = join(skillsDir, folder)
  await mkdir(dir, { recursive: true })
  const path = join(dir, "SKILL.md")
  await writeFile(path, skillText(name, extra), "utf8")
  return path
}

/**
 * 実モデルの代わりに、意味の重複整理と既存文の最小限編集を決定的に再現する。
 * frontmatter とプレースホルダは一切変更しない。
 */
const compose = async (prompt: string): Promise<string> => {
  const start = prompt.indexOf("<existing>")
  const end = prompt.indexOf("</existing>")
  if (start < 0 || end < 0) return NO_CHANGE
  const existing = prompt.slice(start + "<existing>".length, end).replace(/^\n/, "").replace(/\n$/, "")
  const marker = "\n---\n"
  const at = existing.indexOf(marker)
  const front = at >= 0 ? existing.slice(0, at + marker.length) : ""
  const body = at >= 0 ? existing.slice(at + marker.length) : existing
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of body.split("\n")) {
    const edited = line.replaceAll("既存の内容を確認する。", "変更前に現在の挙動を確認する。")
    const key = edited.trim()
    if (key && !edited.includes("LEARN_KEEP") && seen.has(key)) continue
    if (key) seen.add(key)
    out.push(edited)
  }
  return `${front}${out.join("\n")}`
}

const options = async (overrides: Partial<PrepareOptions> = {}): Promise<PrepareOptions> => ({
  skillsDir,
  skills: await listSkills(skillsDir),
  generate: compose,
  ...overrides,
})

const review = (overrides: Partial<ReviewAction> = {}): ReviewAction => ({
  action: "patch",
  name: "demo",
  title: "教訓",
  reason: "同じ失敗を繰り返さないため。",
  body: "変更前に現在の挙動を確認する。",
  diff: "",
  ...overrides,
})

test("提案段階で既存本文を統合した完成形を作り、一切書き込まない", async () => {
  const path = await createSkill("demo", "demo")
  let calls = 0
  const opts = await options({
    generate: async (prompt) => {
      calls++
      return compose(prompt)
    },
  })
  const result = await prepareActions([review()], opts)

  expect(calls).toBe(1)
  expect(result.dropped).toEqual([])
  const action = result.actions[0]
  expect(action.action).toBe("patch")
  expect(action.body).toContain("name: demo")
  expect(action.body).toContain("変更前に現在の挙動を確認する。")
  expect(action.body).not.toContain("既存の内容を確認する。")
  expect(action.body).toContain("無関係の記述その二。")
  // 意味の重複が整理されている。
  expect((action.body.match(/無関係の記述その一。/g) ?? []).length).toBe(1)
  expect(action.diff).toContain("+ 変更前に現在の挙動を確認する。")
  expect(action.diff).toContain("- 既存の内容を確認する。")
  expect(action.section).toBe("変更前に現在の挙動を確認する。")
  expect(action.baseHash).toBe(hashText(skillText("demo")))
  expect(action.secretCount).toBe(0)
  expect(action.targetPath).toBe(path)
  expect(await readFile(path, "utf8")).toBe(skillText("demo"))
})

test("frontmatter name とフォルダ名が違う Skill を実際の path で解決する", async () => {
  const path = await createSkill("folder-a", "actual-name")
  const result = await prepareActions([review({ name: "actual-name" })], await options())
  expect(result.dropped).toEqual([])
  expect(result.actions[0].targetPath).toBe(path)
  expect(result.actions[0].baseHash).toBe(hashText(skillText("actual-name")))
  expect(await readFile(path, "utf8")).toBe(skillText("actual-name"))
})

test("同名の曖昧性は提案を捨てて誤選択しない", async () => {
  await createSkill("folder-a", "same-name")
  await createSkill("folder-b", "same-name")
  const result = await prepareActions([review({ name: "same-name" })], await options())
  expect(result.actions).toEqual([])
  expect(result.dropped[0].reason).toContain("複数")
})

test("シンボリックリンクの Skill も実際の path で統合する", async () => {
  const real = join(root, "real", "linked")
  await mkdir(real, { recursive: true })
  await writeFile(join(real, "SKILL.md"), skillText("linked"), "utf8")
  await symlink(real, join(skillsDir, "linked"))

  const result = await prepareActions([review({ name: "linked" })], await options())
  expect(result.dropped).toEqual([])
  expect(result.actions[0].targetPath).toBe(join(skillsDir, "linked", "SKILL.md"))
  expect(result.actions[0].baseHash).toBe(hashText(skillText("linked")))
})

test("既存本文の秘密はプレースホルダになり完成形にも pending にも残らない", async () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890"
  const path = await createSkill("demo", "demo", `token: ${secret}\n`)
  const result = await prepareActions([review()], await options())
  expect(result.dropped).toEqual([])
  const action = result.actions[0]
  expect(action.body).not.toContain(secret)
  expect(action.body).toContain("[[LEARN_KEEP_0]]")
  expect(action.secretCount).toBe(1)
  expect(JSON.stringify(result)).not.toContain(secret)
  expect(await readFile(path, "utf8")).toContain(secret)
})

test("モデルが失敗したら提案を捨て、ファイルを書き換えない", async () => {
  const path = await createSkill("demo", "demo")
  const result = await prepareActions(
    [review()],
    await options({ generate: async () => { throw new Error("model down") } }),
  )
  expect(result.actions).toEqual([])
  expect(result.dropped[0].reason).toContain("失敗")
  expect(await readFile(path, "utf8")).toBe(skillText("demo"))
})

test("frontmatter を壊したモデル出力は捨てる", async () => {
  await createSkill("demo", "demo")
  const result = await prepareActions(
    [review()],
    await options({ generate: async () => "---\nname: other\n---\n\n短い" }),
  )
  expect(result.actions).toEqual([])
  expect(result.dropped[0].reason).toContain("frontmatter")
})

test("NO_CHANGE は提案を捨てる", async () => {
  await createSkill("demo", "demo")
  const result = await prepareActions([review()], await options({ generate: async () => NO_CHANGE }))
  expect(result.actions).toEqual([])
  expect(result.dropped[0].reason).toContain("すでに")
})

test("更新先のない create は frontmatter 付き全文をそのまま残す", async () => {
  const body = "---\nname: brand-new\ndescription: 新しい\n---\n\n## 手順\n確認する。\n"
  const result = await prepareActions([review({ name: "brand-new", action: "create", body })], await options())
  expect(result.actions[0].action).toBe("create")
  expect(result.actions[0].body).toBe(body.trim())
  expect(result.actions[0].baseHash).toBeUndefined()
  expect(result.actions[0].targetPath).toBe(join(skillsDir, "brand-new", "SKILL.md"))
})

test("既存 Skill と同名の create は上書きせず統合に変換する", async () => {
  await createSkill("demo", "demo")
  const result = await prepareActions([review({ action: "create" })], await options())
  expect(result.actions[0].action).toBe("patch")
  expect(result.actions[0].baseHash).toBe(hashText(skillText("demo")))
})
