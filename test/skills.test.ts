import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listSkills, resolveSkillPath } from "../src/skills.ts"

let root = ""
let skillsDir = ""

beforeEach(async () => {
  const base = join(tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  root = await mkdtemp(join(base, "learn-skills-"))
  skillsDir = join(root, "skills")
  await mkdir(skillsDir, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const createSkill = async (folder: string, name: string, body = "## 手順\n本文\n") => {
  const dir = join(skillsDir, folder)
  await mkdir(dir, { recursive: true })
  const path = join(dir, "SKILL.md")
  await writeFile(path, `---\nname: ${name}\ndescription: 説明\n---\n\n${body}`, "utf8")
  return path
}

test("frontmatter name とフォルダ名が違っても実際の path で解決する", async () => {
  const path = await createSkill("folder-a", "actual-name")
  const skills = await listSkills(skillsDir)
  expect(skills).toHaveLength(1)
  expect(skills[0].name).toBe("actual-name")
  expect(skills[0].path).toBe(path)

  const byFront = resolveSkillPath(skills, "actual-name")
  expect(byFront.ambiguous).toBe(false)
  expect(byFront.path).toBe(path)

  const byFolder = resolveSkillPath(skills, "folder-a")
  expect(byFolder.ambiguous).toBe(false)
  expect(byFolder.path).toBe(path)
})

test("同名の曖昧性は誤選択せず ambiguous を返す", async () => {
  await createSkill("folder-a", "same-name")
  await createSkill("folder-b", "same-name")
  const skills = await listSkills(skillsDir)
  const resolved = resolveSkillPath(skills, "same-name")
  expect(resolved.ambiguous).toBe(true)
  expect(resolved.path).toBeUndefined()
})

test("name とフォルダ名が交差して曖昧な場合も誤選択しない", async () => {
  await createSkill("alpha", "beta")
  await createSkill("beta", "alpha")
  const skills = await listSkills(skillsDir)
  expect(resolveSkillPath(skills, "alpha").ambiguous).toBe(true)
  expect(resolveSkillPath(skills, "beta").ambiguous).toBe(true)
})

test("未登録の名前はパスを返さない", async () => {
  await createSkill("folder-a", "actual-name")
  const skills = await listSkills(skillsDir)
  const resolved = resolveSkillPath(skills, "missing")
  expect(resolved.ambiguous).toBe(false)
  expect(resolved.path).toBeUndefined()
})

test("シンボリックリンクの Skill も実際の path で解決する", async () => {
  const real = join(root, "real", "linked")
  await mkdir(real, { recursive: true })
  await writeFile(
    join(real, "SKILL.md"),
    "---\nname: linked\ndescription: リンク先\n---\n\n## 手順\n本文\n",
    "utf8",
  )
  await symlink(real, join(skillsDir, "linked"))
  const skills = await listSkills(skillsDir)
  const linked = skills.find((skill) => skill.name === "linked")
  expect(linked?.symlink).toBe(true)
  expect(resolveSkillPath(skills, "linked").path).toBe(join(skillsDir, "linked", "SKILL.md"))
})
