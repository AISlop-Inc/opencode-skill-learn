import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { textDiff } from "../src/diff.ts"
import { hashText } from "../src/hash.ts"
import type { PreparedAction } from "../src/prepare.ts"
import { maskSecrets } from "../src/redact.ts"
import { ProposalStore } from "../src/store.ts"

let root = ""

beforeEach(async () => {
  const base = join(tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  root = await mkdtemp(join(base, "learn-test-"))
  await mkdir(join(root, "skills"), { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const makeStore = (maxPending = 12) =>
  new ProposalStore({
    dataDir: join(root, "data"),
    skillsDir: join(root, "skills"),
    maxPending,
  })

const EXISTING =
  "---\nname: codex-ponytail\ndescription: 既存\n---\n\n## 手順\n既存の内容を確認する。\n無関係の記述。\n"
const NEW_SECTION = "変更前に現在の挙動を確認する。"
const COMPLETED =
  "---\nname: codex-ponytail\ndescription: 既存\n---\n\n## 手順\n変更前に現在の挙動を確認する。\n無関係の記述。\n"

const createAction = (name: string, overrides: Partial<PreparedAction> = {}): PreparedAction => ({
  action: "create",
  name,
  title: "手順を追加",
  reason: "繰り返しを防ぐため。",
  body: `---\nname: ${name}\ndescription: 手順\n---\n\n## 手順\n${NEW_SECTION}\n`,
  diff: `+ ${NEW_SECTION}`,
  ...overrides,
})

const patchAction = (overrides: Partial<PreparedAction> = {}): PreparedAction => ({
  action: "patch",
  name: "codex-ponytail",
  title: "手順を追加",
  reason: "繰り返しを防ぐため。",
  body: COMPLETED,
  diff: textDiff(EXISTING, COMPLETED),
  section: NEW_SECTION,
  baseHash: hashText(EXISTING),
  secretCount: 0,
  targetPath: join(root, "skills", "codex-ponytail", "SKILL.md"),
  ...overrides,
})

const writeExisting = async (text = EXISTING, name = "codex-ponytail") => {
  const dir = join(root, "skills", name)
  await mkdir(dir, { recursive: true })
  const path = join(dir, "SKILL.md")
  await writeFile(path, text, "utf8")
  return path
}

const revisionOf = async (store: ProposalStore, id: string) => (await store.detail(id)).revision!
const approveShown = async (store: ProposalStore, id: string) => {
  const shown = await store.detail(id)
  return store.approve(id, shown.revision!, shown.proposal?.baseHash ?? "")
}

const source = { sessionID: "ses_1", title: "作業" }

test("提案を追加しても skills/ には一切書き込まない", async () => {
  const store = makeStore()
  await store.add([createAction("new-skill")], source)
  expect(await readdir(join(root, "skills"))).toEqual([])
  expect((await store.list()).proposals).toHaveLength(1)
})

test("同じ Skill への提案は 1 件にまとめる", async () => {
  const store = makeStore()
  const first = await store.add([createAction("new-skill")], source)
  const second = await store.add([createAction("new-skill", { title: "更新版" })], source)
  expect(first.added).toBe(1)
  expect(second.merged).toBe(1)
  expect((await store.list()).proposals).toHaveLength(1)
})

test("pending の件数上限を超える新規提案は捨てる", async () => {
  const store = makeStore(2)
  const result = await store.add([createAction("a"), createAction("b"), createAction("c")], source)
  expect(result.added).toBe(2)
  expect(result.skipped).toBe(1)
})

test("baseHash のない patch は保存しない", async () => {
  const store = makeStore()
  const result = await store.add([patchAction({ baseHash: undefined })], source)
  expect(result.skipped).toBe(1)
})

test("patch の承認は統合済み完成形をそのまま書き込む（再統合しない）", async () => {
  const store = makeStore()
  const target = await writeExisting()
  await store.add([patchAction()], source)
  const id = (await store.list()).proposals[0].id
  const result = await approveShown(store, id)

  expect(result.ok).toBe(true)
  expect(result.targetPath).toBe(target)
  expect(result.backupPath).toBeDefined()
  expect(await readFile(result.backupPath!, "utf8")).toBe(EXISTING)
  expect((await stat(result.backupPath!)).mode & 0o777).toBe(0o600)
  // 承認時に節を追記したり再統合したりせず、表示した完成形と一致する。
  expect(await readFile(target, "utf8")).toBe(COMPLETED)
  expect(await readFile(target, "utf8")).not.toContain("既存の内容を確認する。")
  expect(await readFile(target, "utf8")).not.toContain("## 学んだ手順")
  expect((await store.list()).proposals[0].status).toBe("approved")
})

test("create の承認は新規 SKILL.md を作り、バックアップは不要", async () => {
  const store = makeStore()
  await store.add([createAction("brand-new")], source)
  const id = (await store.list()).proposals[0].id
  const result = await approveShown(store, id)
  expect(result.ok).toBe(true)
  expect(result.backupPath).toBeUndefined()
  expect(await readFile(result.targetPath!, "utf8")).toContain("name: brand-new")
})

test("表示した版と revision が違えば承認を拒否し、何も書き込まない", async () => {
  const store = makeStore()
  await store.add([createAction("new-skill")], source)
  const id = (await store.list()).proposals[0].id
  const result = await store.approve(id, "wrong-revision", "")
  expect(result.ok).toBe(false)
  expect(result.failedAt).toBe("revision")
  expect(await readdir(join(root, "skills"))).toEqual([])
  expect((await store.list()).proposals[0].status).toBe("pending")
})

test("表示した baseHash が違えば承認を拒否し、書き込まない", async () => {
  const store = makeStore()
  const target = await writeExisting()
  await store.add([patchAction()], source)
  const id = (await store.list()).proposals[0].id
  const revision = await revisionOf(store, id)
  const result = await store.approve(id, revision, "wrong-base")
  expect(result.ok).toBe(false)
  expect(result.failedAt).toBe("revision")
  expect(await readFile(target, "utf8")).toBe(EXISTING)
})

test("提案のあとにターゲットが変わったら承認を拒否し、pending のまま残す", async () => {
  const store = makeStore()
  const target = await writeExisting()
  await store.add([patchAction()], source)
  const id = (await store.list()).proposals[0].id
  await writeFile(target, `${EXISTING}\n手で追記した行\n`, "utf8")
  expect((await store.detail(id)).targetChanged).toBe(true)

  const result = await approveShown(store, id)
  expect(result.ok).toBe(false)
  expect(result.failedAt).toBe("target")
  expect(await readFile(target, "utf8")).toContain("手で追記した行")
  expect((await store.list()).proposals[0].status).toBe("pending")
})

test("別名フォルダでも列挙済みの targetPath へ書き込む", async () => {
  const store = makeStore()
  const target = await writeExisting(EXISTING, "folder-a")
  await store.add([
    patchAction({
      name: "actual-name",
      targetPath: target,
      body: COMPLETED.replace("codex-ponytail", "actual-name"),
    }),
  ], source)
  const id = (await store.list()).proposals[0].id
  const result = await approveShown(store, id)
  expect(result.ok).toBe(true)
  expect(result.targetPath).toBe(target)
  expect(await readFile(target, "utf8")).toContain("変更前に現在の挙動を確認する。")
  expect(await readdir(join(root, "skills"))).toEqual(["folder-a"])
})

test("既存本文の秘密は原文を壊さず復元して書き込む", async () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890"
  const original = `${EXISTING}token: ${secret}\n`
  const target = await writeExisting(original)
  const masked = maskSecrets(original)
  const completedMasked = masked.masked.replace("既存の内容を確認する。", "変更前に現在の挙動を確認する。")

  const store = makeStore()
  await store.add([
    patchAction({
      body: completedMasked,
      secretCount: 1,
      baseHash: hashText(original),
      targetPath: target,
      diff: textDiff(masked.masked, completedMasked),
    }),
  ], source)
  const id = (await store.list()).proposals[0].id
  expect(await readFile(join(root, "data", "pending.json"), "utf8")).not.toContain(secret)

  const result = await approveShown(store, id)
  expect(result.ok).toBe(true)
  const written = await readFile(target, "utf8")
  expect(written).toContain(secret)
  expect(written).toContain("変更前に現在の挙動を確認する。")
  expect(written).not.toContain("既存の内容を確認する。")
  expect(written).not.toContain("[[LEARN_KEEP_0]]")
  expect(await readFile(result.backupPath!, "utf8")).toBe(original)
})

test("プレースホルダが壊れていたら原文を守るため書き込まない", async () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890"
  const original = `${EXISTING}token: ${secret}\n`
  const target = await writeExisting(original)
  const store = makeStore()
  await store.add([
    patchAction({
      body: COMPLETED,
      secretCount: 1,
      baseHash: hashText(original),
      targetPath: target,
    }),
  ], source)
  const id = (await store.list()).proposals[0].id
  const result = await approveShown(store, id)
  expect(result.ok).toBe(false)
  expect(result.failedAt).toBe("restore")
  expect(await readFile(target, "utf8")).toBe(original)
  expect((await store.list()).proposals[0].status).toBe("pending")
})

test("secretCount が元ファイルと一致しなければ書き込まない", async () => {
  const target = await writeExisting()
  const store = makeStore()
  await store.add([patchAction({ secretCount: 2, targetPath: target })], source)
  const id = (await store.list()).proposals[0].id
  const result = await approveShown(store, id)
  expect(result.ok).toBe(false)
  expect(result.failedAt).toBe("restore")
  expect(await readFile(target, "utf8")).toBe(EXISTING)
})

test("SKILL.md 本体がシンボリックリンクなら承認を拒否する", async () => {
  await mkdir(join(root, "real"), { recursive: true })
  const real = join(root, "real", "SKILL.md")
  await writeFile(real, EXISTING, "utf8")
  const dir = join(root, "skills", "linked")
  await mkdir(dir, { recursive: true })
  await symlink(real, join(dir, "SKILL.md"))

  const store = makeStore()
  await store.add([patchAction({ name: "linked", targetPath: join(dir, "SKILL.md") })], source)
  const id = (await store.list()).proposals[0].id
  const result = await approveShown(store, id)
  expect(result.ok).toBe(false)
  expect(result.failedAt).toBe("target")
  expect(await readFile(real, "utf8")).toBe(EXISTING)
})

test("ENOENT 以外の読み取りエラーは承認を拒否する", async () => {
  const store = makeStore()
  await store.add([createAction("broken")], source)
  const id = (await store.list()).proposals[0].id
  const dir = join(root, "skills", "broken")
  await mkdir(dir, { recursive: true })
  await mkdir(join(dir, "SKILL.md"))
  const result = await approveShown(store, id)
  expect(result.ok).toBe(false)
  expect(result.failedAt).toBe("target")
  expect((await store.list()).proposals[0].status).toBe("pending")
})

test("同名の Skill がある create は上書きしない", async () => {
  const store = makeStore()
  await store.add([createAction("codex-ponytail")], source)
  const id = (await store.list()).proposals[0].id
  const target = await writeExisting()
  const result = await approveShown(store, id)
  expect(result.ok).toBe(false)
  expect(result.failedAt).toBe("target")
  expect(await readFile(target, "utf8")).toBe(EXISTING)
})

test("承認時に完成形へ新たに含まれた秘密情報は伏せて書き込まれる", async () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890"
  const store = makeStore()
  await store.add([createAction("safe-skill")], source)
  const id = (await store.list()).proposals[0].id
  const pendingPath = join(root, "data", "pending.json")
  const raw = JSON.parse(await readFile(pendingPath, "utf8"))
  raw.proposals[0].body = `---\nname: safe-skill\n---\n\ntoken: ${secret}\n`
  await writeFile(pendingPath, JSON.stringify(raw), "utf8")

  const result = await approveShown(store, id)
  expect(result.ok).toBe(true)
  expect(await readFile(result.targetPath!, "utf8")).not.toContain(secret)
  expect(await readFile(result.targetPath!, "utf8")).toContain("[REDACTED")
})

test("二重承認は拒否する", async () => {
  const store = makeStore()
  await store.add([createAction("new-skill")], source)
  const id = (await store.list()).proposals[0].id
  expect((await approveShown(store, id)).ok).toBe(true)
  const second = await store.approve(id, "any", "any")
  expect(second.ok).toBe(false)
  expect(second.failedAt).toBe("store")
})

test("破損した pending.json は approve でも空で上書きしない", async () => {
  const dataDir = join(root, "data")
  await mkdir(dataDir, { recursive: true })
  const pendingPath = join(dataDir, "pending.json")
  const broken = "{ this is not json"
  await writeFile(pendingPath, broken, "utf8")

  const store = makeStore()
  expect((await store.list()).corrupt).toBe(true)
  const result = await store.approve("patch:x", "dummy", "dummy")
  expect(result.ok).toBe(false)
  expect(result.failedAt).toBe("store")
  expect(await readFile(pendingPath, "utf8")).toBe(broken)
})

test("2000 行を超える本文の末尾にある秘密も検査から漏れない", async () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890"
  const longBody = `${"手順の行\n".repeat(2_100)}token: ${secret}\n`
  const store = makeStore()
  await store.add([createAction("long", { body: longBody, diff: longBody })], source)
  const proposal = (await store.list()).proposals[0]
  expect(proposal.body).not.toContain(secret)
  expect(proposal.diff).not.toContain(secret)
})

test("複数 store インスタンスの同時 add で提案が消えない", async () => {
  const a = makeStore()
  const b = makeStore()
  await Promise.all([a.add([createAction("skill-a")], source), b.add([createAction("skill-b")], source)])
  const ids = (await a.list()).proposals.map((item) => item.id).sort()
  expect(ids).toEqual(["create:skill-a", "create:skill-b"])
})

test("reject は表示した版と一致するときだけ成功する", async () => {
  const store = makeStore()
  await store.add([createAction("new-skill")], source)
  const id = (await store.list()).proposals[0].id
  const revision = await revisionOf(store, id)
  expect((await store.reject(id, revision)).ok).toBe(true)
  expect((await store.list()).proposals[0].status).toBe("rejected")
  expect((await store.reject(id, revision)).ok).toBe(false)
})

test("detail は書き込み先・revision・targetChanged を返す", async () => {
  const store = makeStore()
  await store.add([createAction("new-skill")], source)
  const id = (await store.list()).proposals[0].id
  const detail = await store.detail(id)
  expect(detail.found).toBe(true)
  expect(detail.targetPath).toBe(join(root, "skills", "new-skill", "SKILL.md"))
  expect(detail.revision).toBeDefined()
  expect(detail.targetChanged).toBe(false)
})
