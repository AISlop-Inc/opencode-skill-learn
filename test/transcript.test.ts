import { expect, test } from "bun:test"
import { assessLearning, extractTranscript } from "../src/transcript.ts"

test("ユーザー発言・assistant テキスト・ツール呼び出しを数える", () => {
  const messages = [
    { type: "user", text: "設定を直して" },
    {
      type: "assistant",
      content: [
        { type: "text", text: "確認します" },
        { type: "tool", name: "read", state: { status: "completed", input: { path: "a.ts" } } },
        { type: "tool", name: "edit", state: { status: "error", input: { path: "a.ts" }, error: { message: "old string not found" } } },
      ],
    },
  ]
  const result = extractTranscript(messages)
  expect(result.toolCalls).toBe(2)
  expect(result.toolIterations).toBe(1)
  expect(result.text).toContain("[user] 設定を直して")
  expect(result.text).toContain("[assistant] 確認します")
  expect(result.text).toContain("[tool edit] (failed)")
  expect(result.text).toContain("→ error: old string not found")
})

/** ツールを 1 回ずつ呼ぶ assistant ステップを並べる。 */
const steps = (names: string[], status = "completed") => names.map((name, index) => ({
  id: `m${index}`,
  type: "assistant",
  content: [{ type: "tool", name, state: { status, input: { command: "bun test" } } }],
}))

test("ツール反復（ツールを呼んだ assistant ステップ）の累積で振り返りを起動する", () => {
  expect(assessLearning(extractTranscript(steps(Array(9).fill("read"))), 10).learn).toBe(false)
  expect(assessLearning(extractTranscript(steps(Array(10).fill("read"))), 10).learn).toBe(true)
  // 1 ステップ内の複数ツールは 1 反復として数える。
  const wide = [{ type: "assistant", content: Array(30).fill({ type: "tool", name: "read", state: { status: "completed" } }) }]
  const transcript = extractTranscript(wide)
  expect(transcript.toolCalls).toBe(30)
  expect(transcript.toolIterations).toBe(1)
  expect(assessLearning(transcript, 10).learn).toBe(false)
})

test("チェックポイント以降だけを数え、前回分は要約・直前の文脈に回す", () => {
  const messages = steps(Array(14).fill("read"))
  const first = extractTranscript(messages.slice(0, 10))
  expect(first.lastMessageID).toBe("m9")
  const next = extractTranscript(messages, { checkpoint: first.lastMessageID, overlap: 2 })
  expect(next.checkpointFound).toBe(true)
  expect(next.newMessages).toBe(4)
  expect(next.toolIterations).toBe(4)
  expect(assessLearning(next, 10).learn).toBe(false)
  expect(next.text).toContain("## 振り返り済みの経緯")
  expect(next.text).toContain("## 直前の文脈（振り返り済み")
  expect(next.text).toContain("## 今回の振り返り対象（前回の振り返り以降の会話）")
})

test("チェックポイントが見つからなければ全体を対象にする", () => {
  const result = extractTranscript(steps(["read", "read"]), { checkpoint: "missing" })
  expect(result.checkpointFound).toBe(false)
  expect(result.newMessages).toBe(2)
})

test("ID がないメッセージは位置で仮の ID を振る", () => {
  const result = extractTranscript([{ type: "user", text: "a" }, { type: "user", text: "b" }])
  expect(result.lastMessageID).toBe("#1")
  expect(extractTranscript([{ type: "user", text: "a" }, { type: "user", text: "b" }], { checkpoint: "#1" }).newMessages).toBe(0)
})

test("ユーザーの訂正があれば閾値前でも振り返る。ツールを使っていなければ見送る", () => {
  const corrections = [
    { type: "user", text: "設定を調べて" },
    ...steps(["read"]),
    { type: "user", text: "違います。そちらではなく既存設定です" },
  ]
  expect(assessLearning(extractTranscript(corrections), 10).learn).toBe(true)
  const talkOnly = [{ type: "user", text: "設定を調べて" }, { type: "user", text: "違います。既存設定です" }]
  expect(assessLearning(extractTranscript(talkOnly), 10).learn).toBe(false)
})

test("新しい会話がなければ見送る", () => {
  const messages = steps(["read"])
  const decision = assessLearning(extractTranscript(messages, { checkpoint: "m0" }), 1)
  expect(decision.learn).toBe(false)
  expect(decision.reason).toContain("新しい会話がありません")
})

test("失敗→成功の経緯と未解決の失敗を拾い、成功時の出力も残す", () => {
  const messages = [
    { type: "assistant", content: [{ type: "tool", name: "shell", state: { status: "error", input: { command: "bun test ./x" }, error: { message: "exit 1: Cannot find module" } } }] },
    { type: "assistant", content: [{ type: "tool", name: "edit", state: { status: "completed", input: { path: "x.ts" } } }] },
    { type: "assistant", content: [{ type: "tool", name: "shell", state: { status: "completed", input: { command: "bun test ./x" }, content: [{ type: "text", text: "3 pass" }] } }] },
    { type: "assistant", content: [{ type: "tool", name: "webfetch", state: { status: "error", input: { url: "https://example.com" }, error: "404" } }] },
  ]
  const result = extractTranscript(messages)
  expect(result.recoveries).toHaveLength(2)
  expect(result.recoveries[0]).toContain("shell `bun test`")
  expect(result.recoveries[0]).toContain("2 ステップ後に成功")
  expect(result.recoveries[1]).toContain("webfetch")
  expect(result.recoveries[1]).toContain("未解決")
  expect(result.text).toContain("→ ok: 3 pass")
  expect(result.signals.failures).toBe(2)
})

test("Skill メッセージとツール経由の読み込みを参照 Skill として拾う", () => {
  const result = extractTranscript([
    { type: "skill", name: "deploy-flow" },
    { type: "assistant", content: [{ type: "tool", name: "read", state: { status: "completed", input: { path: "/x/skills/fix-ci/SKILL.md" } } }] },
  ])
  expect(result.consultedSkills).toEqual(["deploy-flow", "fix-ci"])
})

test("長い会話は末尾の作業を優先して残し、古い部分は要約にする", () => {
  const messages = Array.from({ length: 200 }, (_, index) => ({
    type: "user",
    text: `手順 ${index} ${"あ".repeat(300)}`,
  }))
  const result = extractTranscript(messages)
  expect(result.text.length).toBeLessThanOrEqual(24_000)
  expect(result.text).toContain("手順 199")
  expect(result.text).not.toContain("手順 0 ")
  expect(result.text).toContain("## 古い経緯の要約")
})

test("想定外のメッセージでも例外を出さない", () => {
  expect(extractTranscript([null, 1, { type: "assistant", content: "bad" }])).toEqual({
    text: "",
    toolCalls: 0,
    toolIterations: 0,
    newMessages: 1,
    lastMessageID: "#2",
    checkpointFound: false,
    signals: { failures: 0, corrections: 0, edits: 0, checks: 0, research: 0 },
    consultedSkills: [],
    recoveries: [],
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
