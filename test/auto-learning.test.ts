import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CuratorResult, LearningActivity, SkillsView, Snapshot } from "../src/contract.ts"
import server from "../src/server.ts"
import { ActivityLog } from "../src/activity.ts"
import { ProposalStore } from "../src/store.ts"
import { UsageStore } from "../src/usage.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** ツールを 1 回ずつ呼ぶ assistant ステップ（tool iteration）を n 件作る。 */
const iterations = (n: number, prefix = "a") => Array.from({ length: n }, (_, index) => ({
  id: `${prefix}${index}`,
  type: "assistant",
  content: [{ type: "tool", name: index % 2 ? "patch" : "shell", state: { status: "completed", input: { command: "bun test" } } }],
}))
const simple = () => iterations(1, "s")
const difficult = () => iterations(10, "d")

/** スキップは学習ログに残らないため、非同期の判定が終わるまで少し待つ。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

interface GenerateInput { prompt: string; model?: unknown }

async function fixture(
  generate: (input: GenerateInput) => Promise<string> = async () => '{"proposals":[]}',
  parents: Record<string, string> = {},
  extraOptions: Record<string, unknown> = {},
) {
  const base = join(tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, "learn-auto-"))
  const skillsDir = join(root, "skills")
  await mkdir(skillsDir)
  const log = new ActivityLog(root)
  let messages: unknown[] = simple()
  const inputs: GenerateInput[] = []
  let next: (() => void) | undefined
  let stopped = false
  const queue: { type: string; data: Record<string, unknown>; done: () => void }[] = []
  let terminal: ((entry: LearningActivity) => void) | undefined
  let handlers: Record<string, (input: unknown) => Promise<unknown>> = {}
  let subscribed: readonly string[] = []
  const commands: { name: string; execute: (input: { sessionID: string; prompt: unknown }) => Promise<void> }[] = []

  const ctx = {
    options: { dataDir: root, skillsDir, ...extraOptions },
    location: { directory: root },
    rpc: { register: async (_definition: unknown, impl: typeof handlers) => {
      handlers = impl
      return { dispose: async () => undefined, events: { emit: async () => {
        const latest = (await log.list())[0]
        if (latest && latest.status !== "running") {
          const done = terminal
          // 完了通知の直後に走る finally（inFlight解除）まで待ってから次のイベントへ進む。
          setTimeout(() => done?.(latest), 0)
        }
      } } }
    } },
    command: { transform: async (fn: (editor: { add: (definition: typeof commands[number]) => void }) => void) => {
      fn({ add: (definition) => commands.push(definition) })
      return { dispose: async () => { commands.length = 0 } }
    } },
    event: { subscribe: (input: { types: readonly string[]; signal: AbortSignal }) => {
      subscribed = input.types
      input.signal.addEventListener("abort", () => { stopped = true; next?.() }, { once: true })
      return { async *[Symbol.asyncIterator]() {
        while (!stopped) {
          if (!queue.length) await new Promise<void>((resolve) => { next = resolve })
          const item = queue.shift()
          if (!item) continue
          yield { type: item.type, data: item.data }
          item.done()
        }
      } }
    } },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ title: "一時テスト", parentID: parents[sessionID] }),
      context: async () => messages,
      list: async () => [],
    },
    skill: { list: async () => [] },
    experimental: { generate: { text: async (input: GenerateInput) => { inputs.push(input); return { text: await generate(input) } } } },
  } as unknown as Parameters<typeof server.setup>[0]

  let dispose = await server.setup(ctx)
  cleanups.push(async () => { if (typeof dispose === "function") await dispose(); await rm(root, { recursive: true, force: true }) })
  return {
    root, skillsDir, log, inputs, commands,
    get calls() { return inputs.length },
    get subscribed() { return subscribed },
    setMessages(value: unknown[]) { messages = value },
    send(type = "session.execution.succeeded", data: Record<string, unknown> = { sessionID: "ses_test" }) {
      return new Promise<void>((done) => { queue.push({ type, data, done }); next?.() })
    },
    waitTerminal() { return new Promise<LearningActivity>((resolve) => { terminal = resolve }) },
    async list(sessionID?: string) { return await handlers.list(sessionID ? { sessionID } : {}) as Snapshot },
    async manual(topic?: string) {
      return await handlers.learn({ sessionID: "ses_test", ...(topic ? { topic } : {}) }) as { ok: boolean; proposals: number; reason?: string }
    },
    async rpc<T>(method: string, input: unknown) { return await handlers[method](input) as T },
    async reload() {
      if (typeof dispose === "function") await dispose()
      stopped = false
      dispose = await server.setup(ctx)
    },
  }
}

test("V2の完了通知と Skill の読み込み通知を購読し、閾値前はモデルもログも使わない", async () => {
  const f = await fixture()
  expect(f.subscribed).toEqual(["session.execution.succeeded", "session.skill.activated"])
  await f.send()
  await settle()
  expect(f.calls).toBe(0)
  expect((await f.list()).activity ?? []).toEqual([])
})

test("短い作業が続いても、ツール反復が累積して閾値に届いたら振り返る", async () => {
  const f = await fixture()
  for (const count of [1, 4, 9]) {
    f.setMessages(iterations(count))
    await f.send()
    await settle()
  }
  expect(f.calls).toBe(0)
  f.setMessages(iterations(10))
  const terminal = f.waitTerminal()
  await f.send()
  expect((await terminal).status).toBe("succeeded")
  expect(f.calls).toBe(1)
  expect(await readdir(f.skillsDir)).toEqual([])
  // 新しい会話がなければ再実行しない。
  await f.send()
  await settle()
  expect(f.calls).toBe(1)
})

test("チェックポイントは再起動後も残り、次は前回以降の会話だけを対象にする", async () => {
  const f = await fixture(undefined, {}, { reviewInterval: 3 })
  f.setMessages(iterations(3))
  let terminal = f.waitTerminal()
  await f.send()
  await terminal
  const state = JSON.parse(await readFile(join(f.root, "state.json"), "utf8"))
  expect(state.sessions.ses_test.checkpoint).toBe("a2")
  expect(state.sessions.ses_test.reviews).toBe(1)

  await f.reload()
  f.setMessages([...iterations(3), ...iterations(2, "b")])
  await f.send()
  await settle()
  expect(f.calls).toBe(1)

  f.setMessages([...iterations(3), ...iterations(3, "b")])
  terminal = f.waitTerminal()
  await f.send()
  expect((await terminal).reason).toContain("前回以降の会話を振り返りました")
  expect(f.calls).toBe(2)
  const prompt = f.inputs[1].prompt
  expect(prompt).toContain("## 今回の振り返り対象（前回の振り返り以降の会話）")
  expect(prompt).toContain("## 直前の文脈（振り返り済み")
})

test("ユーザーの訂正があれば閾値前でも振り返る", async () => {
  const f = await fixture()
  f.setMessages([{ type: "user", text: "設定を調べて" }, ...iterations(2), { type: "user", text: "違います。既存設定を使ってください" }])
  const terminal = f.waitTerminal()
  await f.send()
  expect((await terminal).status).toBe("succeeded")
  expect(f.calls).toBe(1)
})

test("モデルの失敗と不正出力を記録し、次の完了通知で再試行する", async () => {
  let attempt = 0
  const f = await fixture(async () => {
    if (++attempt === 1) throw new Error("model unavailable")
    return attempt === 2 ? "not JSON" : '{"proposals":[]}'
  })
  f.setMessages(difficult())
  for (const expected of ["failed", "failed", "succeeded"] as const) {
    const terminal = f.waitTerminal()
    await f.send()
    expect((await terminal).status).toBe(expected)
  }
  expect(f.calls).toBe(3)
})

test("手動学習は閾値を省略し、成功記録とチェックポイントはリロード後も残る", async () => {
  const f = await fixture()
  expect((await f.manual()).ok).toBe(true)
  expect(f.calls).toBe(1)
  await f.reload()
  expect((await f.list()).activity?.[0].trigger).toBe("manual")
  await f.send()
  await settle()
  expect(f.calls).toBe(1)
  // 新しい会話がなくても、手動ならセッション全体を振り返る。
  expect((await f.manual()).ok).toBe(true)
  expect(f.calls).toBe(2)
})

test("実行中の重複通知でモデルを二重に呼ばない", async () => {
  let release: (() => void) | undefined
  const generated = new Promise<void>((resolve) => { release = resolve })
  const f = await fixture(async () => { await generated; return '{"proposals":[]}' })
  f.setMessages(difficult())
  const terminal = f.waitTerminal()
  await f.send()
  await f.send()
  await settle()
  expect((await f.list("ses_test")).running).toBe(true)
  release!()
  await terminal
  expect(f.calls).toBe(1)
  expect((await f.list("ses_test")).running).toBe(false)
})

test("自動学習の生成結果は承認待ちに保存するだけでSkillを書き換えない", async () => {
  const f = await fixture(async () => JSON.stringify({ proposals: [{
    action: "create", name: "temp-learning", title: "変更前に挙動を確認する", reason: "変更ミスを防ぐため。",
    body: "---\nname: temp-learning\ndescription: 変更前の確認\n---\n\n変更前に挙動を確認する。", diff: "新規作成",
    evidence: "変更前に挙動を確認してください",
  }] }))
  f.setMessages([...difficult(), { type: "user", text: "変更前に挙動を確認してください" }])
  const terminal = f.waitTerminal()
  await f.send()
  expect((await terminal).proposals).toBe(1)
  expect((await f.list()).proposals[0].status).toBe("pending")
  expect(await readdir(f.skillsDir)).toEqual([])
})

test("生成に失敗した場合だけ自動試行回数を消費し、回数は state.json に残る", async () => {
  const f = await fixture(async () => { throw new Error("model down") })
  f.setMessages(difficult())
  for (let index = 0; index < 3; index++) {
    const terminal = f.waitTerminal()
    await f.send()
    expect((await terminal).status).toBe("failed")
  }
  await f.reload()
  await f.send()
  await settle()
  expect(f.calls).toBe(3)
  const state = JSON.parse(await readFile(join(f.root, "state.json"), "utf8"))
  expect(state.sessions.ses_test.attempts.count).toBe(3)
  expect(state.sessions.ses_test.checkpoint).toBeUndefined()
})

test("補助セッションから細かなSkillを自動で作らず親タスクにまとめる", async () => {
  const f = await fixture(undefined, { ses_test: "ses_parent" })
  f.setMessages(difficult())
  await f.send()
  await settle()
  expect(f.calls).toBe(0)
})

test("旧データの補助セッションの提案も親タスクに表示し、別タスクには混ぜない", async () => {
  const f = await fixture(undefined, { ses_child: "ses_parent" })
  const store = new ProposalStore({ dataDir: f.root, skillsDir: f.skillsDir })
  await store.add([{
    action: "create", name: "legacy-child", title: "過去の提案", reason: "学習", body: "手順を確認する", diff: "",
  }], { sessionID: "ses_child", title: "補助作業" })
  expect((await f.list("ses_parent")).proposals).toHaveLength(1)
  expect((await f.list("ses_other")).proposals).toHaveLength(0)
  expect((await f.list()).proposals[0].sourceSessionID).toBe("ses_child")
})

test("reviewModel と composeModel をオプションで指定できる", async () => {
  const f = await fixture(undefined, {}, { reviewModel: "anthropic/claude-sonnet-5-5#high" })
  f.setMessages(difficult())
  const terminal = f.waitTerminal()
  await f.send()
  await terminal
  expect(f.inputs[0].model).toEqual({ providerID: "anthropic", id: "claude-sonnet-5-5", variant: "high" })
})

test("/learn <パス> はファイルを読んで学び、Skill は書き換えない", async () => {
  const f = await fixture(async () => JSON.stringify({ proposals: [{
    action: "create", name: "release-flow", title: "リリース手順", reason: "資料の手順を再利用するため。",
    body: "---\nname: release-flow\ndescription: リリース手順\n---\n\n1. タグを打つ", diff: "新規作成",
    evidence: "タグを打ってから公開する",
  }] }))
  await writeFile(join(f.root, "RELEASE.md"), "# Release\nタグを打ってから公開する\n")
  await writeFile(join(f.root, ".env"), "TOKEN=secret-value\n")
  const result = await f.manual("./RELEASE.md と ./.env の手順を Skill にして")
  expect(result.ok).toBe(true)
  expect(result.proposals).toBe(1)
  expect(result.reason).toContain("秘密情報")
  const prompt = f.inputs[0].prompt
  expect(prompt).toContain("タグを打ってから公開する")
  expect(prompt).not.toContain("secret-value")
  expect(await readdir(f.skillsDir)).toEqual([])
})

test("/learn コマンドを登録し、引数があれば指定内容から学ぶ", async () => {
  const f = await fixture()
  expect(f.commands.map((command) => command.name)).toEqual(["learn"])
  const terminal = f.waitTerminal()
  await f.commands[0].execute({ sessionID: "ses_test", prompt: { text: "/learn 変更前に必ずテストを走らせる" } })
  const entry = await terminal
  expect(entry.trigger).toBe("manual")
  expect(f.inputs[0].prompt).toContain("変更前に必ずテストを走らせる")
  expect(f.inputs[0].prompt).not.toContain("/learn 変更前")
})

test("command: false なら /learn を登録しない", async () => {
  const f = await fixture(undefined, {}, { command: false })
  expect(f.commands).toEqual([])
})

test("Skill の読み込みを数え、作成した Skill だけをアーカイブ・復元できる", async () => {
  const f = await fixture()
  for (const name of ["mine", "manual"]) {
    await mkdir(join(f.skillsDir, name))
    await writeFile(join(f.skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n\n本文`)
  }
  const usage = new UsageStore(f.root)
  await usage.recordApproved("mine", "create", join(f.skillsDir, "mine", "SKILL.md"), Date.now() - 40 * 86_400_000)
  await f.send("session.skill.activated", { sessionID: "ses_test", name: "manual" })
  await settle()

  const view = await f.rpc<SkillsView>("skills", {})
  expect(view.items.find((item) => item.name === "mine")?.status).toBe("archive-candidate")
  expect(view.items.find((item) => item.name === "manual")).toMatchObject({ status: "active", managed: false, useCount: 1 })

  expect((await f.rpc<CuratorResult>("archive", { name: "manual" })).ok).toBe(false)
  const archived = await f.rpc<CuratorResult>("archive", { name: "mine" })
  expect(archived.ok).toBe(true)
  expect(await readdir(f.skillsDir)).toEqual(["manual"])
  expect(await readdir(join(f.root, "archive"))).toHaveLength(1)
  expect((await f.rpc<SkillsView>("skills", {})).items.find((item) => item.name === "mine")?.status).toBe("archived")

  expect((await f.rpc<CuratorResult>("restore", { name: "mine" })).ok).toBe(true)
  expect((await readdir(f.skillsDir)).sort()).toEqual(["manual", "mine"])
  expect((await f.rpc<SkillsView>("skills", {})).items.find((item) => item.name === "mine")?.status).toBe("active")
})

test("ピン留めした Skill はアーカイブ候補にしない", async () => {
  const f = await fixture()
  await mkdir(join(f.skillsDir, "keep"))
  await writeFile(join(f.skillsDir, "keep", "SKILL.md"), "---\nname: keep\ndescription: keep\n---\n\n本文")
  const usage = new UsageStore(f.root)
  await usage.recordApproved("keep", "create", join(f.skillsDir, "keep", "SKILL.md"), Date.now() - 20 * 86_400_000)
  expect((await f.rpc<SkillsView>("skills", {})).items[0].status).toBe("stale")
  await f.rpc("pin", { name: "keep", pinned: true })
  expect((await f.rpc<SkillsView>("skills", {})).items[0]).toMatchObject({ status: "active", pinned: true })
})

/** 整理案のモデル出力と、統合（compose）の結果を返すスタブ。 */
const consolidateModel = (absorb: string[]) => async (input: GenerateInput) => {
  if (input.prompt.includes("Skill キュレーター")) {
    return JSON.stringify({ proposals: [{
      action: "patch", name: "deploy-a", absorb, title: "デプロイの Skill をまとめる",
      reason: "どちらも同じデプロイ作業の手順のため。", body: "## 確認\n- 公開後にヘルスチェックを見る。", diff: "確認の節を追加",
    }] })
  }
  if (input.prompt.includes("あなたは OpenCode の Skill 編集者です")) {
    const start = input.prompt.indexOf("<existing>")
    const end = input.prompt.indexOf("</existing>")
    const existing = input.prompt.slice(start + "<existing>".length, end).replace(/^\n/, "").replace(/\n$/, "")
    return `${existing}\n\n## 確認\n- 公開後にヘルスチェックを見る。\n`
  }
  return '{"proposals":[]}'
}

const deploySkills = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const usage = new UsageStore(f.root)
  for (const name of ["deploy-a", "deploy-b", "deploy-c", "manual-x"]) {
    await mkdir(join(f.skillsDir, name))
    await writeFile(join(f.skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} のデプロイ\n---\n\n## 手順\n- ${name} でタグを打つ。\n- ${name} で公開する。\n`)
    if (name !== "manual-x") await usage.recordApproved(name, "create", join(f.skillsDir, name, "SKILL.md"))
  }
  await usage.setPinned("deploy-c", true)
}

test("似た Skill をまとめる案は提案だけを作り、承認でまとめ先を更新して吸収した Skill をアーカイブする", async () => {
  const f = await fixture(consolidateModel(["deploy-b", "deploy-c", "manual-x", "unknown"]))
  await deploySkills(f)

  const result = await f.rpc<{ ok: boolean; proposals: number; reason?: string }>("consolidate", {})
  expect(result).toMatchObject({ ok: true, proposals: 1 })
  expect((await readdir(f.skillsDir)).sort()).toEqual(["deploy-a", "deploy-b", "deploy-c", "manual-x"])
  const prompt = f.inputs.find((input) => input.prompt.includes("Skill キュレーター"))!.prompt
  expect(prompt).toContain("deploy-c（残す設定: absorb 不可）")
  expect(prompt).toContain("- manual-x: manual-x のデプロイ")

  // 整理案はセッションに属さないので、どのセッションの画面にも出る。
  const [proposal] = (await f.list("ses_other")).proposals
  expect(proposal.sourceSessionID).toBe("curator")
  expect(proposal.archives?.map((target) => target.name)).toEqual(["deploy-b"])

  const shown = await f.rpc<{ revision: string; proposal: { baseHash?: string } }>("detail", { id: proposal.id })
  const approved = await f.rpc<{ ok: boolean; archived?: string[]; archiveErrors?: string[] }>("approve", {
    id: proposal.id, revision: shown.revision, baseHash: shown.proposal.baseHash ?? "",
  })
  expect(approved.ok).toBe(true)
  expect(approved.archived).toEqual(["deploy-b"])
  expect(approved.archiveErrors).toBeUndefined()
  expect((await readdir(f.skillsDir)).sort()).toEqual(["deploy-a", "deploy-c", "manual-x"])
  expect(await readFile(join(f.skillsDir, "deploy-a", "SKILL.md"), "utf8")).toContain("ヘルスチェック")
  expect((await f.rpc<SkillsView>("skills", {})).items.find((item) => item.name === "deploy-b")?.status).toBe("archived")
})

test("整理案のあとに吸収する Skill が変わったら、アーカイブせずに理由を返す", async () => {
  const f = await fixture(consolidateModel(["deploy-b"]))
  await deploySkills(f)
  expect((await f.rpc<{ ok: boolean; proposals: number }>("consolidate", {})).proposals).toBe(1)
  await writeFile(join(f.skillsDir, "deploy-b", "SKILL.md"), "---\nname: deploy-b\ndescription: 手で直した\n---\n\n本文\n")

  const [proposal] = (await f.list()).proposals
  const shown = await f.rpc<{ revision: string; proposal: { baseHash?: string } }>("detail", { id: proposal.id })
  const approved = await f.rpc<{ ok: boolean; archived?: string[]; archiveErrors?: string[] }>("approve", {
    id: proposal.id, revision: shown.revision, baseHash: shown.proposal.baseHash ?? "",
  })
  expect(approved.ok).toBe(true)
  expect(approved.archived).toBeUndefined()
  expect(approved.archiveErrors?.[0]).toContain("deploy-b")
  expect((await readdir(f.skillsDir)).sort()).toEqual(["deploy-a", "deploy-b", "deploy-c", "manual-x"])
})

test("まとめる対象が2つ未満ならモデルを呼ばない", async () => {
  const f = await fixture(consolidateModel(["deploy-b"]))
  await mkdir(join(f.skillsDir, "only"))
  await writeFile(join(f.skillsDir, "only", "SKILL.md"), "---\nname: only\ndescription: only\n---\n\n本文\n")
  await new UsageStore(f.root).recordApproved("only", "create", join(f.skillsDir, "only", "SKILL.md"))
  const result = await f.rpc<{ ok: boolean; proposals: number; reason?: string }>("consolidate", {})
  expect(result).toMatchObject({ ok: false, proposals: 0 })
  expect(result.reason).toContain("2つ未満")
  expect(f.calls).toBe(0)
})
