import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApproveResult, Detail, Snapshot } from "../src/contract.ts"
import { NO_CHANGE } from "../src/compose.ts"
import { hashText } from "../src/hash.ts"
import { prepareActions } from "../src/prepare.ts"
import { maskSecrets, restoreMasked } from "../src/redact.ts"
import type { ReviewAction } from "../src/review.ts"
import server from "../src/server.ts"
import { listSkills } from "../src/skills.ts"
import { ProposalStore } from "../src/store.ts"

const BODY =
  "## 手順\n既存の内容を確認する。\n無関係の記述その一。\n無関係の記述その二。\n無関係の記述その三。\n"
const skillText = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: 既存\n---\n\n${BODY}${extra}`

type Handler = (input: unknown) => Promise<unknown>

let root = ""
let dataDir = ""
let skillsDir = ""
let handlers: Record<string, Handler> = {}
let cleanup: void | (() => Promise<void> | void)

beforeEach(async () => {
  const base = join(tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  root = await mkdtemp(join(base, "learn-rpc-"))
  dataDir = join(root, "data")
  skillsDir = join(root, "skills")
  await mkdir(skillsDir, { recursive: true })
  handlers = {}
  cleanup = undefined
})

afterEach(async () => {
  if (typeof cleanup === "function") await cleanup()
  await rm(root, { recursive: true, force: true })
})

/** 実モデルの代わりに、意味の重複整理と既存文の最小限編集を決定的に再現する。 */
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

const registerServer = async () => {
  const registration = {
    events: { emit: async () => undefined },
    dispose: async () => undefined,
  }
  const ctx = {
    options: { dataDir, skillsDir },
    rpc: {
      register: async (_definition: unknown, impl: Record<string, unknown>) => {
        handlers = impl as Record<string, Handler>
        return registration
      },
    },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          // イベントは流さない。reviewSession は呼ばない。
        },
      }),
    },
    skill: { list: async () => [] },
    session: { get: async () => ({}), list: async () => [], context: async () => [] },
    experimental: { generate: { text: async () => ({ text: "" }) } },
  } as unknown as Parameters<typeof server.setup>[0]
  cleanup = await server.setup(ctx)
}

const list = () => (handlers.list as (input: unknown) => Promise<Snapshot>)({})
const detail = (id: string) => (handlers.detail as (input: unknown) => Promise<Detail>)({ id })
const approve = (id: string, revision: string, baseHash: string) =>
  (handlers.approve as (input: unknown) => Promise<ApproveResult>)({ id, revision, baseHash })

const review = (name: string): ReviewAction => ({
  action: "patch",
  name,
  title: "教訓",
  reason: "同じ失敗を繰り返さないため。",
  body: "変更前に現在の挙動を確認する。",
  diff: "",
})

/** 一時 Skill を作り、提案生成 → store.add までを実処理で通す。 */
const stage = async (
  folder: string,
  name: string,
  extra = "",
  generate: (prompt: string) => Promise<string> = compose,
): Promise<{ id?: string; path: string; original: string }> => {
  const dir = join(skillsDir, folder)
  await mkdir(dir, { recursive: true })
  const path = join(dir, "SKILL.md")
  const original = skillText(name, extra)
  await writeFile(path, original, "utf8")

  const prepared = await prepareActions([review(name)], {
    skillsDir,
    skills: await listSkills(skillsDir),
    generate,
  })
  const store = new ProposalStore({ dataDir, skillsDir })
  await store.add(prepared.actions, { sessionID: "ses_1", title: "作業" })
  const snapshot = await store.list()
  return { id: snapshot.proposals[0]?.id, path, original }
}

test("一時 Skill の提案生成から RPC 承認まで、承認済み完成形がそのまま反映される", async () => {
  const { id, path, original } = await stage("demo", "demo")
  expect(id).toBeDefined()
  await registerServer()

  const before = await list()
  expect(before.proposals).toHaveLength(1)

  const shown = await detail(id!)
  expect(shown.found).toBe(true)
  expect(shown.revision).toBeDefined()
  expect(shown.proposal?.baseHash).toBe(hashText(original))
  expect(shown.proposal?.body).toContain("変更前に現在の挙動を確認する。")
  expect(shown.proposal?.body).not.toContain("既存の内容を確認する。")
  expect(shown.proposal?.diff).toContain("+ 変更前に現在の挙動を確認する。")
  expect(shown.targetChanged).toBe(false)
  expect(shown.writable).toBe(true)

  const result = await approve(id!, shown.revision!, shown.proposal?.baseHash ?? "")
  expect(result.ok).toBe(true)
  expect(result.targetPath).toBe(path)
  expect(result.backupPath).toBeDefined()
  expect(await readFile(result.backupPath!, "utf8")).toBe(original)

  // 表示した統合済み完成形と、実際に書き込まれた内容が一致する。
  const written = await readFile(path, "utf8")
  expect(written).toBe(shown.proposal!.body!)
  expect((await list()).proposals[0].status).toBe("approved")
})

test("frontmatter name とフォルダ名が違う一時 Skill も実際の path へ反映される", async () => {
  const { id, path } = await stage("folder-a", "actual-name")
  await registerServer()
  const shown = await detail(id!)

  const result = await approve(id!, shown.revision!, shown.proposal?.baseHash ?? "")
  expect(result.ok).toBe(true)
  expect(result.targetPath).toBe(path)
  expect(await readFile(path, "utf8")).toContain("変更前に現在の挙動を確認する。")
  expect(await readFile(join(skillsDir, "folder-a", "SKILL.md"), "utf8")).toBe(shown.proposal!.body!)
})

test("シンボリックリンクの一時 Skill も実際の path へ反映される", async () => {
  const real = join(root, "real", "linked")
  await mkdir(real, { recursive: true })
  const realFile = join(real, "SKILL.md")
  const original = skillText("linked")
  await writeFile(realFile, original, "utf8")
  await symlink(real, join(skillsDir, "linked"))

  const prepared = await prepareActions([review("linked")], {
    skillsDir,
    skills: await listSkills(skillsDir),
    generate: compose,
  })
  const store = new ProposalStore({ dataDir, skillsDir })
  await store.add(prepared.actions, { sessionID: "ses_1", title: "作業" })
  const id = (await store.list()).proposals[0].id

  await registerServer()
  const shown = await detail(id)
  const result = await approve(id, shown.revision!, shown.proposal?.baseHash ?? "")
  expect(result.ok).toBe(true)
  expect(await readFile(realFile, "utf8")).toContain("変更前に現在の挙動を確認する。")
  expect(await readFile(realFile, "utf8")).toBe(shown.proposal!.body!)
})

test("秘密を含む一時 Skill は原文を壊さず復元し、承認済み内容と一致する", async () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890"
  const { id, path, original } = await stage("demo", "demo", `token: ${secret}\n`)
  await registerServer()
  const shown = await detail(id!)

  expect(shown.proposal?.body).not.toContain(secret)
  expect(shown.proposal?.body).toContain("[[LEARN_KEEP_0]]")
  expect(await readFile(join(dataDir, "pending.json"), "utf8")).not.toContain(secret)

  const result = await approve(id!, shown.revision!, shown.proposal?.baseHash ?? "")
  expect(result.ok).toBe(true)
  const written = await readFile(path, "utf8")
  expect(written).toContain(secret)
  expect(written).toContain("変更前に現在の挙動を確認する。")
  // 承認済み完成形を元ファイルの spans で復元したものが、そのまま書き込まれている。
  expect(restoreMasked(shown.proposal!.body!, maskSecrets(original).spans)).toBe(written)
})

test("RPC 経由で revision が古いと承認を拒否し、Skill は変わらない", async () => {
  const { id, path, original } = await stage("demo", "demo")
  await registerServer()
  const shown = await detail(id!)
  const result = await approve(id!, "stale-revision", shown.proposal?.baseHash ?? "")
  expect(result.ok).toBe(false)
  expect(result.failedAt).toBe("revision")
  expect(await readFile(path, "utf8")).toBe(original)
})

test("RPC 経由で baseHash が違うと承認を拒否し、Skill は変わらない", async () => {
  const { id, path, original } = await stage("demo", "demo")
  await registerServer()
  const shown = await detail(id!)
  const result = await approve(id!, shown.revision!, "wrong-base")
  expect(result.ok).toBe(false)
  expect(result.failedAt).toBe("revision")
  expect(await readFile(path, "utf8")).toBe(original)
})

test("RPC 経由で提案後にターゲットが変わると承認を拒否する", async () => {
  const { id, path, original } = await stage("demo", "demo")
  await registerServer()
  const shown = await detail(id!)
  await writeFile(path, `${original}\n手で追記\n`, "utf8")

  const result = await approve(id!, shown.revision!, shown.proposal?.baseHash ?? "")
  expect(result.ok).toBe(false)
  expect(result.failedAt).toBe("target")
  expect(await readFile(path, "utf8")).toContain("手で追記")
})

test("提案生成が失敗したら RPC の一覧に提案が出ず、Skill も変わらない", async () => {
  const { id, path, original } = await stage("demo", "demo", "", async () => {
    throw new Error("model down")
  })
  expect(id).toBeUndefined()
  await registerServer()
  expect((await list()).proposals).toHaveLength(0)
  expect(await readFile(path, "utf8")).toBe(original)
})
