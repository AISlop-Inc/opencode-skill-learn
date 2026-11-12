import { expect, test } from "bun:test"
import { diffPreview } from "../src/diff-preview.ts"
import { textDiff } from "../src/diff.ts"

test("実差分の変更前後と共通の文脈を分け、差分記号だけを取り除く", () => {
  const preview = diffPreview(textDiff("# 手順\n古い手順\n確認", "# 手順\n新しい手順\n確認"))
  expect(preview).toEqual({
    hunks: [{ blocks: [
      { kind: "context", text: "# 手順" },
      { kind: "remove", text: "古い手順" },
      { kind: "add", text: "新しい手順" },
      { kind: "context", text: "確認" },
    ] }],
    truncated: false,
  })
})

test("追加のみと削除のみを表示でき、Markdownの箇条書きと空行を維持する", () => {
  const added = diffPreview("  # 手順\n+ - 項目1\n+ \n+ - 項目2\n+ + 記号")
  expect(added.hunks[0].blocks[1]).toEqual({ kind: "add", text: "- 項目1\n\n- 項目2\n+ 記号" })
  expect(diffPreview("- 古い手順").hunks[0].blocks).toEqual([{ kind: "remove", text: "古い手順" }])
})

test("離れた変更箇所は分割し、通常の文脈省略を差分の打ち切りと混同しない", () => {
  const preview = diffPreview("…\n- A\n+ B\n…\n  文脈\n+ C\n…")
  expect(preview.hunks).toHaveLength(2)
  expect(preview.truncated).toBe(false)
})

test("表示上限による省略を知らせ、変更のない差分や旧形式の要約を変更として扱わない", () => {
  expect(diffPreview("+ 追加\n… 以降は省略しました").truncated).toBe(true)
  expect(diffPreview("  変更なし").hunks).toEqual([])
  expect(diffPreview("手順に確認を追加します").hunks).toEqual([])
  expect(diffPreview("").hunks).toEqual([])
})
