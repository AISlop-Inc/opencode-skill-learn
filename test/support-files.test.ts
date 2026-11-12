import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareActions } from "../src/prepare.ts"
import type { PreparedAction } from "../src/prepare.ts"
import { MAX_SUPPORT_FILES, parseReviewOutput, supportFilePath } from "../src/review.ts"
import { listSkills } from "../src/skills.ts"
import { ProposalStore } from "../src/store.ts"

let root = ""
let skillsDir = ""

beforeEach(async () => {
  const base = join(tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  root = await mkdtemp(join(base, "learn-files-"))
  skillsDir = join(root, "skills")
  await mkdir(skillsDir, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const makeStore = () => new ProposalStore({ dataDir: join(root, "data"), skillsDir })
const source = { sessionID: "ses_1", title: "作業" }

const createAction = (name: string, overrides: Partial<PreparedAction> = {}): PreparedAction => ({
  action: "create",
  name,
  title: "API の手順",
  reason: "繰り返しを防ぐため。",
  body: `---\nname: ${name}\ndescription: 手順\n---\n\n## 手順\nAPI を呼ぶ前に references/api.md の一覧を読む。\n`,
  diff: "新規作成",
  targetPath: join(skillsDir, name, "SKILL.md"),
  files: [
    { path: "references/api.md", content: "# API\n- GET /items\n" },
    { path: "templates/request.json", content: "{\"id\": 1}\n" },
  ],
  ...overrides,
})

const approveShown = async (store: ProposalStore, id: string) => {
  const shown = await store.detail(id)
  return store.approve(id, shown.revision!, shown.proposal?.baseHash ?? "")
}

test("補助ファイルのパスは references/ と templates/ 直下のテキストだけを通す", () => {
  expect(supportFilePath("references/api.md")).toBe("references/api.md")
  expect(supportFilePath("./templates/out.yaml")).toBe("templates/out.yaml")
  expect(supportFilePath("scripts/run.sh")).toBeUndefined()
  expect(supportFilePath("references/run.sh")).toBeUndefined()
  expect(supportFilePath("references/nested/a.md")).toBeUndefined()
  expect(supportFilePath("references/../SKILL.md")).toBeUndefined()
  expect(supportFilePath("references/..md")).toBeUndefined()
  expect(supportFilePath("/etc/passwd.md")).toBeUndefined()
  expect(supportFilePath("SKILL.md")).toBeUndefined()
})

test("parseReviewOutput は補助ファイルを検査し、件数を制限し、秘密を伏せる", () => {
  const files = [
    { path: "scripts/run.sh", content: "rm -rf /" },
    { path: "references/a.md", content: "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
    { path: "references/a.md", content: "重複" },
    { path: "references/b.md", content: "" },
    { path: "references/c.md", content: "C" },
    { path: "templates/d.txt", content: "D" },
    { path: "templates/e.txt", content: "E" },
  ]
  const [action] = parseReviewOutput(JSON.stringify({ proposals: [{
    action: "create", name: "demo", title: "t", reason: "r", body: "b", diff: "", files,
  }] }))
  expect(action.files?.map((file) => file.path)).toEqual(["references/a.md", "references/c.md", "templates/d.txt"])
  expect(action.files).toHaveLength(MAX_SUPPORT_FILES)
  expect(action.files?.[0].content).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789")
  expect(action.files?.[1].content).toBe("C\n")
})

test("absorb は整理の解析オプションを付けたときだけ受け付ける", () => {
  const raw = JSON.stringify({ proposals: [{
    action: "patch", name: "umbrella", title: "t", reason: "r", body: "b", diff: "", absorb: ["a", "umbrella", "a", "../b"],
  }] })
  expect(parseReviewOutput(raw)[0].absorb).toBeUndefined()
  expect(parseReviewOutput(raw, false, { absorb: true })[0].absorb).toEqual(["a", "b"])
})

test("提案段階で、すでにある補助ファイルは除外して上書きしない", async () => {
  const dir = join(skillsDir, "demo")
  await mkdir(join(dir, "references"), { recursive: true })
  await writeFile(join(dir, "SKILL.md"), "---\nname: demo\ndescription: d\n---\n\n## 手順\n既存。\n")
  await writeFile(join(dir, "references", "api.md"), "既存の資料\n")
  const result = await prepareActions([{
    action: "patch", name: "demo", title: "t", reason: "r", body: "追記", diff: "",
    files: [{ path: "references/api.md", content: "新しい資料\n" }, { path: "references/new.md", content: "新規\n" }],
  }], { skillsDir, skills: await listSkills(skillsDir), generate: async () => "---\nname: demo\ndescription: d\n---\n\n## 手順\n既存。\n追記\n" })
  expect(result.dropped).toEqual([])
  expect(result.actions[0].files).toEqual([{ path: "references/new.md", content: "新規\n" }])
  expect(result.actions[0].skippedFiles).toEqual(["references/api.md"])
  expect(await readFile(join(dir, "references", "api.md"), "utf8")).toBe("既存の資料\n")

  const store = makeStore()
  await store.add(result.actions, source)
  const [proposal] = (await store.list()).proposals
  expect(proposal.warnings.some((warning) => warning.includes("references/api.md"))).toBe(true)
})

test("承認すると補助ファイルを作ってから SKILL.md を書く", async () => {
  const store = makeStore()
  await store.add([createAction("api-flow")], source)
  expect(await readdir(skillsDir)).toEqual([])
  const result = await approveShown(store, "ses_1:create:api-flow")
  expect(result.ok).toBe(true)
  expect(result.files).toEqual(["references/api.md", "templates/request.json"])
  const dir = join(skillsDir, "api-flow")
  expect(await readFile(join(dir, "references", "api.md"), "utf8")).toBe("# API\n- GET /items\n")
  expect(await readFile(join(dir, "templates", "request.json"), "utf8")).toBe("{\"id\": 1}\n")
  expect(await readFile(join(dir, "SKILL.md"), "utf8")).toContain("references/api.md")
})

test("承認時に補助ファイルができていたら、何も書かずに止める", async () => {
  const store = makeStore()
  await store.add([createAction("api-flow")], source)
  const dir = join(skillsDir, "api-flow")
  await mkdir(join(dir, "templates"), { recursive: true })
  await writeFile(join(dir, "templates", "request.json"), "手元の版\n")
  const result = await approveShown(store, "ses_1:create:api-flow")
  expect(result).toMatchObject({ ok: false, failedAt: "target" })
  expect(await readFile(join(dir, "templates", "request.json"), "utf8")).toBe("手元の版\n")
  expect((await readdir(dir)).sort()).toEqual(["templates"])
  expect((await store.list()).proposals[0].status).toBe("pending")
})

test("references/ がシンボリックリンクなら書き込まない", async () => {
  const store = makeStore()
  await store.add([createAction("api-flow")], source)
  const dir = join(skillsDir, "api-flow")
  const outside = join(root, "outside")
  await mkdir(outside)
  await mkdir(dir, { recursive: true })
  await symlink(outside, join(dir, "references"))
  const result = await approveShown(store, "ses_1:create:api-flow")
  expect(result).toMatchObject({ ok: false, failedAt: "target" })
  expect(await readdir(outside)).toEqual([])
})

test("補助ファイルの書き込みに失敗したら、作ったものを消して pending に戻す", async () => {
  if (process.getuid?.() === 0) return
  const store = makeStore()
  await store.add([createAction("api-flow")], source)
  const dir = join(skillsDir, "api-flow")
  await mkdir(join(dir, "templates"), { recursive: true })
  await chmod(join(dir, "templates"), 0o500)
  try {
    const result = await approveShown(store, "ses_1:create:api-flow")
    expect(result).toMatchObject({ ok: false, failedAt: "write" })
    expect(result.reason).toContain("補助ファイル")
    expect((await readdir(dir)).sort()).toEqual(["templates"])
    expect((await store.list()).proposals[0].status).toBe("pending")
  } finally {
    await chmod(join(dir, "templates"), 0o700)
  }
})

test("補助ファイルが変わると版も変わり、古い表示のまま承認できない", async () => {
  const store = makeStore()
  await store.add([createAction("api-flow")], source)
  const shown = await store.detail("ses_1:create:api-flow")
  await store.add([createAction("api-flow", { files: [{ path: "references/api.md", content: "差し替え\n" }] })], source)
  const result = await store.approve("ses_1:create:api-flow", shown.revision!, "")
  expect(result).toMatchObject({ ok: false, failedAt: "revision" })

  // 補助ファイルのない提案で統合したら、古い補助ファイルは残らない。
  await store.add([createAction("api-flow", { files: undefined })], source)
  expect((await store.list()).proposals[0].files).toBeUndefined()
})
