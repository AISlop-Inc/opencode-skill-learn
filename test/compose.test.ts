import { expect, test } from "bun:test"
import { buildComposePrompt, NO_CHANGE, validateComposedText } from "../src/compose.ts"

const EXISTING =
  "---\nname: demo\ndescription: 既存\n---\n\n## 手順\n既存の内容を確認する。\n無関係の記述。\n"

const promptInput = {
  name: "demo",
  existingMasked: EXISTING,
  secretCount: 0,
  lesson: "変更前に現在の挙動を確認する。",
  reason: "同じ失敗を繰り返さないため。",
}

test("プロンプトは既存本文・教訓・重複整理・プレースホルダ保持を要求する", () => {
  const prompt = buildComposePrompt(promptInput)
  expect(prompt).toContain("<existing>")
  expect(prompt).toContain("既存の内容を確認する。")
  expect(prompt).toContain("変更前に現在の挙動を確認する。")
  expect(prompt).toContain("重複")
  expect(prompt).toContain("最小限")
  expect(prompt).toContain("LEARN_KEEP")
  expect(prompt).toContain("frontmatter")
})

test("NO_CHANGE は提案なしとして扱う", () => {
  expect(validateComposedText(NO_CHANGE, EXISTING, 0)).toEqual({ kind: "no-change" })
  expect(validateComposedText(EXISTING, EXISTING, 0)).toEqual({ kind: "no-change" })
})

test("意味の重複を整理し既存文を最小限編集した完成形を受理する", () => {
  const merged =
    "---\nname: demo\ndescription: 既存\n---\n\n## 手順\n変更前に現在の挙動を確認する。\n無関係の記述。\n"
  const result = validateComposedText(merged, EXISTING, 0)
  expect(result.kind).toBe("ok")
  if (result.kind === "ok") {
    expect(result.text).toContain("変更前に現在の挙動を確認する。")
    expect(result.text).toContain("無関係の記述。")
    // 既存全行の完全保存は要求しない。書き換えを許可する。
    expect(result.text).not.toContain("既存の内容を確認する。")
  }
})

test("コードフェンス付きの出力も受理する", () => {
  const merged =
    "---\nname: demo\ndescription: 既存\n---\n\n## 手順\n変更前に現在の挙動を確認する。\n無関係の記述。\n"
  const result = validateComposedText(`\`\`\`markdown\n${merged}\`\`\``, EXISTING, 0)
  expect(result.kind).toBe("ok")
})

test("frontmatter を変えた完成形は拒否する", () => {
  const bad = EXISTING.replace("name: demo", "name: other") + "変更前に現在の挙動を確認する。\n"
  const result = validateComposedText(bad, EXISTING, 0)
  expect(result.kind).toBe("invalid")
  if (result.kind === "invalid") expect(result.reason).toContain("frontmatter")
})

test("無関係の内容を大きく削った完成形は拒否する", () => {
  const bad = "---\nname: demo\ndescription: 既存\n---\n\n## 手順\n変更前のみ。\n"
  const result = validateComposedText(bad, EXISTING, 0)
  expect(result.kind).toBe("invalid")
})

test("プレースホルダを落とした完成形は拒否する", () => {
  const withMarker =
    "---\nname: demo\ndescription: 既存\n---\n\n## 手順\n[[LEARN_KEEP_0]]\n無関係の記述。\n"
  const bad = withMarker.replace("[[LEARN_KEEP_0]]", "token")
  const result = validateComposedText(bad, withMarker, 1)
  expect(result.kind).toBe("invalid")
  if (result.kind === "invalid") expect(result.reason).toContain("プレースホルダ")
})

test("プレースホルダを保った完成形は受理する", () => {
  const beforeWithMarker =
    "---\nname: demo\ndescription: 既存\n---\n\n## 手順\n[[LEARN_KEEP_0]]\n既存の内容を確認する。\n無関係の記述。\n"
  const afterWithMarker =
    "---\nname: demo\ndescription: 既存\n---\n\n## 手順\n[[LEARN_KEEP_0]]\n変更前に現在の挙動を確認する。\n無関係の記述。\n"
  const result = validateComposedText(afterWithMarker, beforeWithMarker, 1)
  expect(result.kind).toBe("ok")
  if (result.kind === "ok") expect(result.text).toContain("[[LEARN_KEEP_0]]")
})

test("モデルが新たに書いた秘密情報は完成形で伏せられる", () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890"
  const merged = `${EXISTING}token: ${secret}\n`
  const result = validateComposedText(merged, EXISTING, 0)
  expect(result.kind).toBe("ok")
  if (result.kind === "ok") {
    expect(result.text).not.toContain(secret)
    expect(result.text).toContain("[REDACTED")
  }
})
