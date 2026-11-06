import { expect, test } from "bun:test"
import { textDiff } from "../src/diff.ts"

test("複数箇所の編集を実際の差分として出す", () => {
  const diff = textDiff("a\nb\nc\nd\ne", "a\nB\nc\nd\nE")
  expect(diff).toContain("- b")
  expect(diff).toContain("+ B")
  expect(diff).toContain("- e")
  expect(diff).toContain("+ E")
})

test("変更がなければ空文字", () => {
  expect(textDiff("a\nb", "a\nb")).toBe("")
})

test("挿入と削除を扱う", () => {
  const diff = textDiff("a\nb\nc", "a\nx\nc")
  expect(diff).toContain("+ x")
  expect(diff).toContain("- b")
  expect(textDiff("a\nb", "a\nb\nc")).toContain("+ c")
})

test("2000 行を超えても全行を走査する", () => {
  const before = `${"行\n".repeat(2_100)}末尾`
  const after = before.replace("末尾", "変更後")
  const diff = textDiff(before, after)
  expect(diff).toContain("- 末尾")
  expect(diff).toContain("+ 変更後")
})
