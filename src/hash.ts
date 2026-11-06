import { createHash } from "node:crypto"

/** 提案時点の既存 SKILL.md を識別する。承認時に変更されていないかを確かめるために使う。 */
export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}
