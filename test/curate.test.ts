import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { curateActions } from "../src/curate.ts"
import type { ReviewAction, ReviewPromptInput } from "../src/review.ts"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const action = (name: string): ReviewAction => ({ action: "create", name, title: "検証経路を確認する", reason: "誤認を防ぐ", body: "設定値ではなく実行経路でテストを確認する。", diff: "新規", evidence: "同じ設定値でも検証経路が違います" })
const context: ReviewPromptInput = { sessionTitle: "テストの調査", transcript: "[user] 同じ設定値でも検証経路が違います", toolCalls: 4, skills: [], pending: [] }

test("候補なしでは品質確認のモデルを呼ばない", async () => {
  expect(await curateActions([], context, [], async () => { throw new Error("呼ばない") })).toEqual([])
})

test("別名の同じ候補を内容でまとめ、保留本文と却下済み教訓も比較させる", async () => {
  const result = await curateActions([action("check-test-path"), action("test-triage")], {
    ...context,
    pending: [{ id: "pending", kind: "create", name: "existing-pending", title: "既存", reason: "理由", body: "保留中の手順本文" }],
    rejected: [{ kind: "create", name: "declined", title: "却下", body: "却下した教訓の本文" }],
  }, [], async (prompt) => {
    expect(prompt).toContain("同じ目的の候補は1つに統合")
    expect(prompt).toContain("保留中の手順本文")
    expect(prompt).toContain("却下した教訓の本文")
    expect(prompt).toContain("元の条件を超えて")
    return JSON.stringify({ proposals: [action("testing-workflow")] })
  })
  expect(result).toHaveLength(1)
})

test("関連Skillの実パスの本文をマスクして検査し、既存へのpatchへ変更できる", async () => {
  const base = join(tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, "learn-curate-"))
  roots.push(root)
  const path = join(root, "SKILL.md")
  const original = "---\nname: testing\n---\n\nテスト経路を確認する。\ntoken: ghp_abcdefghijklmnopqrstuvwxyz\n"
  await writeFile(path, original)
  const result = await curateActions([{ ...action("new-testing"), relatedSkills: ["testing"] }], context,
    [{ name: "testing", path, description: "テスト手順", symlink: false }], async (prompt) => {
      expect(prompt).toContain("テスト経路を確認する。")
      expect(prompt).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz")
      return JSON.stringify({ proposals: [{ ...action("testing"), action: "patch" }] })
    })
  expect(result[0].action).toBe("patch")
  expect(await readFile(path, "utf8")).toBe(original)
})

test("品質確認が失敗したら未確認の候補を保存へ流さない", async () => {
  await expect(curateActions([action("test")], context, [], async () => "broken")).rejects.toThrow()
})
