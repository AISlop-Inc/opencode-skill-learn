import { expect, test } from "bun:test"
import { extractTranscript } from "../src/transcript.ts"

test("ユーザー発言・assistant テキスト・ツール呼び出しを数える", () => {
  const messages = [
    { type: "user", text: "設定を直して" },
    {
      type: "assistant",
      content: [
        { type: "text", text: "確認します" },
        { type: "tool", name: "read", state: { status: "completed", input: { path: "a.ts" } } },
        { type: "tool", name: "edit", state: { status: "error", input: { path: "a.ts" } } },
      ],
    },
  ]
  const result = extractTranscript(messages)
  expect(result.toolCalls).toBe(2)
  expect(result.text).toContain("[user] 設定を直して")
  expect(result.text).toContain("[assistant] 確認します")
  expect(result.text).toContain("[tool edit] (failed)")
})

test("長い会話は末尾の作業を優先して残す", () => {
  const messages = Array.from({ length: 200 }, (_, index) => ({
    type: "user",
    text: `手順 ${index} ${"あ".repeat(300)}`,
  }))
  const result = extractTranscript(messages)
  expect(result.text.length).toBeLessThanOrEqual(24_000)
  expect(result.text).toContain("手順 199")
  expect(result.text).not.toContain("手順 0 ")
})

test("想定外のメッセージでも例外を出さない", () => {
  expect(extractTranscript([null, 1, { type: "assistant", content: "bad" }])).toEqual({
    text: "",
    toolCalls: 0,
  })
})

test("ツール入力の JSON に含まれる秘密は切り詰める前に伏せる", () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890"
  const messages = [
    {
      type: "assistant",
      content: [
        {
          type: "tool",
          name: "write",
          state: { status: "completed", input: { token: secret, path: "a.ts" } },
        },
      ],
    },
  ]
  const result = extractTranscript(messages)
  expect(result.toolCalls).toBe(1)
  expect(result.text).not.toContain(secret)
  expect(result.text).not.toContain("sk-")
  expect(result.text).toContain("[REDACTED")
})
