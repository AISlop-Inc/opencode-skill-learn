import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formatModelRef, parseModelRef } from "../src/model.ts"
import { gatherSources, renderSources } from "../src/sources.ts"
import { LearningState } from "../src/state.ts"
import { archiveSkillDir, curatorView, emptyUsage, UsageStore } from "../src/usage.ts"

const cleanups: string[] = []
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function temp() {
  const base = join(tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  const dir = await mkdtemp(join(base, "learn-mod-"))
  cleanups.push(dir)
  return dir
}

test("モデル指定を文字列とオブジェクトの両方で読む", () => {
  expect(parseModelRef("openai/gpt-6#high")).toEqual({ providerID: "openai", id: "gpt-6", variant: "high" })
  expect(parseModelRef("openrouter/google/gemini-3-flash")).toEqual({ providerID: "openrouter", id: "google/gemini-3-flash" })
  expect(parseModelRef({ providerID: "anthropic", model: "claude-haiku-5-5" })).toEqual({ providerID: "anthropic", id: "claude-haiku-5-5" })
  for (const bad of ["", "gpt", "/x", "x/", 3, null, { id: "x" }]) expect(parseModelRef(bad)).toBeUndefined()
  expect(formatModelRef(undefined)).toBe("OpenCode の既定モデル")
  expect(formatModelRef({ providerID: "a", id: "b", variant: "c" })).toBe("a/b#c")
})

test("URL は本文を取り出し、失敗した URL は理由を残す", async () => {
  const fetcher = (async (url: string) => {
    if (url.includes("missing")) return new Response("no", { status: 404 })
    return new Response("<html><head><style>x{}</style></head><body><h2>手順</h2><script>alert(1)</script><p>tag &amp; push</p></body></html>", {
      headers: { "content-type": "text/html" },
    })
  }) as unknown as typeof fetch
  const sources = await gatherSources("https://example.com/guide と https://example.com/missing。を読んで", { fetch: fetcher })
  expect(sources).toHaveLength(2)
  expect(sources[0].text).toContain("## 手順")
  expect(sources[0].text).toContain("tag & push")
  expect(sources[0].text).not.toContain("alert")
  expect(sources[1].error).toBe("HTTP 404")
  expect(renderSources(sources)).toContain("（取得できませんでした: HTTP 404）")
})

test("フォルダは構成と主要ファイルを読み、秘密情報らしいファイルは読まない", async () => {
  const dir = await temp()
  await mkdir(join(dir, "src"))
  await mkdir(join(dir, "node_modules"))
  await writeFile(join(dir, "README.md"), "# Tool\nbun run build で作る\n")
  await writeFile(join(dir, "src", "index.ts"), "export {}\n")
  await writeFile(join(dir, ".env"), "TOKEN=abc\n")
  const [folder] = await gatherSources(`${dir} の使い方`)
  expect(folder.kind).toBe("directory")
  expect(folder.text).toContain("src/")
  expect(folder.text).toContain("  index.ts")
  expect(folder.text).toContain("bun run build で作る")
  expect(folder.text).not.toContain("node_modules")
  expect(folder.text).not.toContain(".env")
  const [secret] = await gatherSources("./.env", { baseDir: dir })
  expect(secret.error).toContain("秘密情報")
  const [missing] = await gatherSources("./nothing.md", { baseDir: dir })
  expect(missing.error).toContain("見つかりません")
})

test("state.json はセッションごとに進み具合を保存する", async () => {
  const dir = await temp()
  const state = new LearningState(dir)
  expect(await state.get("a")).toEqual({})
  await state.update("a", (current) => ({ ...current, checkpoint: "m1", reviews: 1 }))
  expect(await new LearningState(dir).get("a")).toEqual({ checkpoint: "m1", reviews: 1 })
  await writeFile(join(dir, "state.json"), '{"version":2}')
  await expect(state.get("a")).rejects.toThrow("形式が不正")
})

test("Curator は作成した Skill だけを日数で判定する", () => {
  const now = Date.UTC(2026, 10, 1)
  const day = 86_400_000
  const skills = ["fresh", "old", "older", "hand"].map((name) => ({ name, description: "", path: `/s/${name}/SKILL.md`, symlink: false }))
  const usage = {
    fresh: { ...emptyUsage(), createdBy: "agent" as const, createdAt: now - 3 * day, patchGeneration: 1 },
    old: { ...emptyUsage(), createdBy: "agent" as const, createdAt: now - 20 * day, patchGeneration: 1 },
    older: { ...emptyUsage(), createdBy: "agent" as const, createdAt: now - 60 * day, lastUsedAt: now - 31 * day, patchGeneration: 1, lastReusedPatchGeneration: 1, useCount: 2 },
    hand: { ...emptyUsage(), useCount: 1, lastUsedAt: now - 90 * day },
  }
  const view = curatorView(skills, usage, { staleDays: 14, archiveDays: 30 }, now)
  expect(view.map((item) => [item.name, item.status])).toEqual([
    ["older", "archive-candidate"],
    ["old", "stale"],
    ["hand", "active"],
    ["fresh", "active"],
  ])
  expect(view[0].reusedAfterPatch).toBe(true)
})

test("利用回数と更新後の再利用を数える", async () => {
  const dir = await temp()
  const usage = new UsageStore(dir)
  await usage.recordApproved("x", "create", "/s/x/SKILL.md", 1)
  await usage.recordUse("x", 2)
  await usage.recordApproved("x", "patch", "/s/x/SKILL.md", 3)
  const row = (await usage.all()).x
  expect(row).toMatchObject({ useCount: 1, patchCount: 1, patchGeneration: 2, lastReusedPatchGeneration: 1, createdBy: "agent" })
})

test("シンボリックリンクや skills 直下以外の Skill はアーカイブしない", async () => {
  const dir = await temp()
  const skillsDir = join(dir, "skills")
  await mkdir(join(dir, "elsewhere", "x"), { recursive: true })
  await mkdir(join(skillsDir, "nested", "y"), { recursive: true })
  await symlink(join(dir, "elsewhere", "x"), join(skillsDir, "x"))
  const archive = join(dir, "archive")
  expect(await archiveSkillDir(join(skillsDir, "x", "SKILL.md"), skillsDir, archive)).toMatchObject({ ok: false, reason: expect.stringContaining("シンボリックリンク") })
  expect(await archiveSkillDir(join(skillsDir, "nested", "y", "SKILL.md"), skillsDir, archive)).toMatchObject({ ok: false, reason: expect.stringContaining("直下") })
})
