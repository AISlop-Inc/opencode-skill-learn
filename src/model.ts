/** `ctx.experimental.generate.text` の `model` に渡す形。 */
export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

/**
 * プラグイン設定のモデル指定を読む。
 * - 文字列: `"provider/model"` または `"provider/model#variant"`。model 側に `/` を含んでもよい（例: `openrouter/google/gemini-3-flash`）。
 * - オブジェクト: `{ providerID, id, variant? }`（`model` も `id` の別名として受け付ける）。
 * 解釈できない値は undefined を返し、OpenCode の既定モデルを使う。
 */
export function parseModelRef(value: unknown): ModelRef | undefined {
  if (typeof value === "string") {
    const text = value.trim()
    const slash = text.indexOf("/")
    if (slash <= 0 || slash === text.length - 1) return undefined
    const providerID = text.slice(0, slash)
    const rest = text.slice(slash + 1)
    const hash = rest.lastIndexOf("#")
    const id = hash > 0 ? rest.slice(0, hash) : rest
    const variant = hash > 0 ? rest.slice(hash + 1) : ""
    if (!id) return undefined
    return { providerID, id, ...(variant ? { variant } : {}) }
  }
  if (value && typeof value === "object") {
    const row = value as { providerID?: unknown; id?: unknown; model?: unknown; variant?: unknown }
    const id = typeof row.id === "string" ? row.id : typeof row.model === "string" ? row.model : ""
    if (typeof row.providerID !== "string" || !row.providerID || !id) return undefined
    return { providerID: row.providerID, id, ...(typeof row.variant === "string" && row.variant ? { variant: row.variant } : {}) }
  }
  return undefined
}

export function formatModelRef(model: ModelRef | undefined): string {
  if (!model) return "OpenCode の既定モデル"
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}
