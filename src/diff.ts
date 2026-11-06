/**
 * 統合前後の「実際の差分」を人が読むための行単位 diff。表示専用。
 * 秘密情報の検査には使わない（検査は常に全文に対して行う）。
 *
 * 複数箇所の編集を扱えるよう、近傍で再同期しながら全行を走査する。
 * LCS の表を持たないため行数に上限がない。
 */

const CONTEXT = 2
const LOOKAHEAD = 12
const MAX_ROWS = 2_000

interface Row {
  op: " " | "-" | "+"
  text: string
}

export function textDiff(before: string, after: string): string {
  const a = before.split("\n")
  const b = after.split("\n")
  const rows: Row[] = []
  let i = 0
  let j = 0

  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ op: " ", text: a[i] })
      i++
      j++
      continue
    }

    // 近傍でもっとも近い一致行を探し、そこまでを削除・追加として出力する。
    let best: { ai: number; bj: number; cost: number } | undefined
    for (let di = 0; di < LOOKAHEAD && i + di < a.length; di++) {
      for (let dj = 0; dj < LOOKAHEAD && j + dj < b.length; dj++) {
        if (a[i + di] !== b[j + dj]) continue
        const cost = di + dj
        if (!best || cost < best.cost) best = { ai: i + di, bj: j + dj, cost }
      }
    }

    if (best && best.cost > 0) {
      for (let k = i; k < best.ai; k++) rows.push({ op: "-", text: a[k] })
      for (let k = j; k < best.bj; k++) rows.push({ op: "+", text: b[k] })
      i = best.ai
      j = best.bj
      continue
    }

    if (i < a.length) rows.push({ op: "-", text: a[i++] })
    if (j < b.length) rows.push({ op: "+", text: b[j++] })
    if (rows.length > MAX_ROWS * 3) break
  }

  if (!rows.some((row) => row.op !== " ")) return ""

  const keep = rows.map((_row, index) =>
    rows.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1).some((near) => near.op !== " "),
  )
  const out: string[] = []
  let skipped = false
  for (let index = 0; index < rows.length && out.length < MAX_ROWS; index++) {
    if (!keep[index]) {
      if (!skipped) out.push("…")
      skipped = true
      continue
    }
    skipped = false
    out.push(`${rows[index].op} ${rows[index].text}`)
  }
  if (out.length >= MAX_ROWS) out.push("… 以降は省略しました")
  return out.join("\n")
}
