import { expect, test } from "bun:test"
import { lintProposal } from "../src/lint.ts"

const clean = {
  kind: "create" as const,
  title: "設定変更前に既存挙動を確認する",
  reason: "同じ失敗を繰り返さないため。",
  body: "---\nname: check-before-change\ndescription: 設定変更前の確認手順\n---\n\n変更前に現在の挙動を記録し、差分を確認してから適用する。",
  diff: "新しい節を追加",
  redacted: false,
}

test("教訓だけの提案は警告しない", () => {
  expect(lintProposal(clean)).toEqual([])
})

test("長文・PR 番号・日付・引用をまとめて警告する", () => {
  const warnings = lintProposal({
    ...clean,
    body: [
      "#1234 と #2345 を対応",
      "2026-01-01 に 2026-01-02 へ移動",
      "> ユーザーの発言",
      "> アシスタントの返答",
      "> さらに続き",
      "あ".repeat(7_000),
    ].join("\n"),
  })
  expect(warnings.length).toBeGreaterThanOrEqual(4)
  expect(warnings.join("\n")).toContain("文字")
  expect(warnings.join("\n")).toContain("PR 番号")
  expect(warnings.join("\n")).toContain("日付")
  expect(warnings.join("\n")).toContain("引用")
})

test("frontmatter のない create を警告する", () => {
  const warnings = lintProposal({ ...clean, body: "手順だけを書いた本文" })
  expect(warnings.join("\n")).toContain("frontmatter")
})

test("伏せた秘密情報があることを警告する", () => {
  const warnings = lintProposal({ ...clean, kind: "patch", redacted: true })
  expect(warnings.join("\n")).toContain("秘密情報")
})
