export interface DiffBlock {
  kind: "context" | "remove" | "add"
  text: string
}

export interface DiffHunk {
  blocks: DiffBlock[]
}

/** 保存済みの実差分を表示用に区切る。現在のファイルから差分を作り直さない。 */
export function diffPreview(diff: string): { hunks: DiffHunk[]; truncated: boolean } {
  const hunks: DiffHunk[] = []
  let blocks: DiffBlock[] = []
  let truncated = false

  const finish = () => {
    if (blocks.some((block) => block.kind !== "context")) hunks.push({ blocks })
    blocks = []
  }

  for (const line of diff.split("\n")) {
    if (line === "…" || line === "… 以降は省略しました") {
      finish()
      if (line !== "…") truncated = true
      continue
    }
    if (!/^[ +\-] /.test(line)) continue

    const kind = line[0] === "+" ? "add" : line[0] === "-" ? "remove" : "context"
    const previous = blocks[blocks.length - 1]
    const text = line.slice(2)
    if (previous?.kind === kind) previous.text += `\n${text}`
    else blocks.push({ kind, text })
  }
  finish()
  return { hunks, truncated }
}
