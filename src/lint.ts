/**
 * 「ログではなく教訓」を守るためのリンター。
 * 警告は提案を拒否せず、人が承認前に判断できるよう GUI に見せる。
 */

export interface LintTarget {
  readonly kind: "create" | "patch"
  readonly title: string
  readonly reason: string
  readonly body: string
  readonly diff: string
  readonly redacted: boolean
}

const MAX_BODY_CHARS = 6_000
const MAX_BODY_LINES = 150

function count(pattern: RegExp, text: string): number {
  pattern.lastIndex = 0
  return (text.match(pattern) ?? []).length
}

export function lintProposal(target: LintTarget): string[] {
  const warnings: string[] = []
  const text = `${target.title}\n${target.reason}\n${target.body}\n${target.diff}`

  if (target.body.length > MAX_BODY_CHARS) {
    warnings.push(`本文が ${target.body.length} 文字あります。教訓だけを残してください（目安 ${MAX_BODY_CHARS} 文字）。`)
  }
  if (count(/\n/g, target.body) + 1 > MAX_BODY_LINES) {
    warnings.push(`本文が ${MAX_BODY_LINES} 行を超えています。手順の要約に絞ってください。`)
  }
  if (count(/(?:#\d{3,}|\bPR\s*#?\d+\b)/gi, text) >= 2) {
    warnings.push("PR 番号が複数あります。作業ログではなく再利用できる教訓になっているか確認してください。")
  }
  if (count(/\b20\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?/g, text) >= 2) {
    warnings.push("日付が複数あります。時系列の記録ではなく手順として書かれているか確認してください。")
  }
  if (count(/^\s*>/gm, target.body) >= 3 || count(/\b(?:User|Assistant|Human|System)\s*:/g, target.body) >= 2) {
    warnings.push("会話の引用が多く含まれています。発言の写しではなく教訓にしてください。")
  }
  if (/\bses_[a-z0-9]+\b|\bmsg_[a-z0-9]+\b/.test(text)) {
    warnings.push("セッション ID などの内部識別子が残っています。")
  }
  if (count(/\b(?:今日|昨日|今週|先週|さっき|この前)\b/g, text) >= 2) {
    warnings.push("相対的な日付表現が多いです。恒久的に使える書き方にしてください。")
  }
  if (target.redacted) {
    warnings.push("秘密情報の可能性がある文字列を保存前に伏せました。内容を確認してください。")
  }
  if (target.kind === "create" && !/^---\s*\n[\s\S]*?\n---\s*\n/.test(target.body.trimStart())) {
    warnings.push("SKILL.md の frontmatter（name / description）がありません。")
  }
  return warnings
}
