import { expect, test } from "bun:test"
import {
  hasUnredactedSecrets,
  markerIds,
  maskSecrets,
  redactAndClip,
  redactSecrets,
  restoreMasked,
} from "../src/redact.ts"

test("トークン・パスワード・API キーを伏せる", () => {
  const input = [
    "token: sk-abcdefghijklmnopqrstuvwxyz1234567890",
    "password: super-secret-value",
    "github ghp_abcdefghijklmnopqrstuvwxyz",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop",
  ].join("\n")
  const output = redactSecrets(input)
  expect(output).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234567890")
  expect(output).not.toContain("super-secret-value")
  expect(output).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz")
  expect(output).toContain("[REDACTED")
})

test("service.json と秘密鍵ブロックを伏せる", () => {
  const input = [
    "cat ~/.config/gcloud/service.json",
    '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----","client_email":"a@b.c"}',
  ].join("\n")
  const output = redactSecrets(input)
  expect(output).not.toContain("BEGIN PRIVATE KEY")
  expect(output).not.toContain("service.json")
  expect(output).toContain("[REDACTED")
})

test("JSON 形式の秘密情報も伏せる", () => {
  const input = '{"api_key":"0123456789abcdefghijklmnop","nested":{"password":"super-secret-value"}}'
  const output = redactSecrets(input)
  expect(output).not.toContain("0123456789abcdefghijklmnop")
  expect(output).not.toContain("super-secret-value")
  expect(output).toContain("[REDACTED")
})

test("普通の教訓は書き換えない", () => {
  const text = "設定を変える前に既存の挙動を確認する。失敗したら元に戻す。"
  expect(redactSecrets(text)).toBe(text)
  expect(hasUnredactedSecrets(text)).toBe(false)
})

test("伏せた文字列は再適用しても変化しない", () => {
  const output = redactSecrets("api_key = 0123456789abcdefghijklmnopqrstuvwxyz")
  expect(hasUnredactedSecrets(output)).toBe(false)
})

test("切り詰める前に伏せるため、境界で分割された秘密が残らない", () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890"
  const text = `${"あ".repeat(90)}${secret}`
  const clipped = redactAndClip(text, 100)
  expect(clipped).not.toContain("sk-")
  expect(clipped).not.toContain(secret)

  // 先に切ってから伏せる旧方式では、短くなったトークンが検出されず残る。
  const naive = redactSecrets(text.slice(0, 100))
  expect(naive).toContain("sk-")
})

test("maskSecrets は原文を可逆なプレースホルダへ置き換える", () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890"
  const original = `---\nname: demo\ndescription: 既存\n---\n\n## 手順\n既存の内容\ntoken: ${secret}\n`
  const masked = maskSecrets(original)
  expect(masked.masked).not.toContain(secret)
  expect(masked.spans).toHaveLength(1)
  expect(masked.spans[0]).toContain(secret)
  expect(markerIds(masked.masked)).toEqual([0])
  expect(hasUnredactedSecrets(masked.masked)).toBe(false)
  expect(restoreMasked(masked.masked, masked.spans)).toBe(original)
})

test("復元はプレースホルダの欠落・重複・範囲外を拒否する", () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890"
  const original = `token: ${secret}\n`
  const masked = maskSecrets(original)
  expect(restoreMasked(masked.masked.replace("[[LEARN_KEEP_0]]", ""), masked.spans)).toBeUndefined()
  expect(restoreMasked(`${masked.masked}[[LEARN_KEEP_0]]`, masked.spans)).toBeUndefined()
  expect(restoreMasked(`${masked.masked}[[LEARN_KEEP_9]]`, masked.spans)).toBeUndefined()
  expect(restoreMasked("秘密なしの本文\n", [])).toBe("秘密なしの本文\n")
})

test("秘密情報がない全文はマスクしても変化せず復元も一致する", () => {
  const original = "---\nname: demo\n---\n\n## 手順\n既存の内容\n"
  const masked = maskSecrets(original)
  expect(masked.spans).toEqual([])
  expect(masked.masked).toBe(original)
  expect(restoreMasked(masked.masked, masked.spans)).toBe(original)
})
