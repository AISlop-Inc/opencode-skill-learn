/**
 * 会話・ツール出力・Web・既存ファイルの内容は信頼できない入力として扱う。
 * モデルに渡す前、保存する前、画面に出す前に必ず通す。
 * 秘密情報の検査は必ず「切る前の全文」に対して行い、切り詰めた文字列を検査に流用しない。
 */

type Rule = { readonly pattern: RegExp; readonly replacement: string }

const rules: readonly Rule[] = [
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED:private-key]",
  },
  {
    pattern: /\{[^{}]{0,3000}?\b(?:private_key|privateKey|service_account|client_email)\b[^{}]{0,3000}?\}/g,
    replacement: "[REDACTED:service-credential]",
  },
  { pattern: /^[^\n]*\bservice\.json\b[^\n]*$/gim, replacement: "[REDACTED:service-json]" },
  {
    pattern:
      /("(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|private[_-]?key|credential)"\s*:\s*")((?:[^"\\]|\\.){8,})(")/gi,
    replacement: "$1[REDACTED:secret]$3",
  },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, replacement: "[REDACTED:token]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: "[REDACTED:token]" },
  { pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED:token]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED:token]" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: "[REDACTED:token]" },
  { pattern: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: "[REDACTED:jwt]" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, replacement: "Bearer [REDACTED:token]" },
  {
    pattern:
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|private[_-]?key|credential)s?\s*[:=]\s*)(["']?)([^\s"',;}\[\]]{8,})\2/gi,
    replacement: "$1$2[REDACTED:secret]$2",
  },
  { pattern: /\b[A-Za-z0-9+/]{60,}={0,2}\b/g, replacement: "[REDACTED:base64]" },
]

/** 秘密情報らしき文字列を伏せる。置換が起きたかどうかは戻り値の比較で判定できる。 */
export function redactSecrets(text: string): string {
  let result = text
  for (const rule of rules) {
    rule.pattern.lastIndex = 0
    result = result.replace(rule.pattern, rule.replacement)
  }
  return result
}

/** redactSecrets を通したあとも差が残るなら、まだ伏せきれていないと判断する。 */
export function hasUnredactedSecrets(text: string): boolean {
  return redactSecrets(text) !== text
}

/**
 * 伏せてから切り詰める。順番を逆にすると、境界で分割された秘密情報が
 * パターンに一致しなくなり、モデルや保存先へ漏れる。
 */
export function redactAndClip(text: string, max: number): string {
  const safe = redactSecrets(text)
  return safe.length > max ? safe.slice(0, max) : safe
}

/** 原文を壊さずにモデルへ渡すための可逆なプレースホルダ。 */
export const MASK_PREFIX = "LEARN_KEEP_"
const MARKER = /\[\[LEARN_KEEP_(\d+)\]\]/g

export interface MaskedText {
  /** 秘密情報がプレースホルダに置き換わった全文。モデル・保存・画面に渡せる。 */
  masked: string
  /** プレースホルダに対応する原文の断片。 */
  spans: string[]
}

/**
 * redactSecrets と同じ規則で秘密情報を検出し、一意なプレースホルダへ置き換える。
 * マーカーは秘密情報ではなく、原文そのものは spans にだけ残る。
 * 承認時に元ファイル（baseHash で同一性を確認）から spans を再現して復元する。
 */
export function maskSecrets(text: string): MaskedText {
  const spans: string[] = []
  let masked = text
  for (const rule of rules) {
    rule.pattern.lastIndex = 0
    masked = masked.replace(rule.pattern, (match) => {
      // すでに置換済みの範囲を二重にマスクしない。
      if (MARKER.test(match)) {
        MARKER.lastIndex = 0
        return match
      }
      MARKER.lastIndex = 0
      const id = spans.length
      spans.push(match)
      return `[[${MASK_PREFIX}${id}]]`
    })
  }
  MARKER.lastIndex = 0
  return { masked, spans }
}

/** 全文に含まれるプレースホルダ ID を列挙する。 */
export function markerIds(text: string): number[] {
  MARKER.lastIndex = 0
  return [...text.matchAll(MARKER)].map((match) => Number(match[1]))
}

/**
 * マスク済みの完成形を、元ファイルから取り出した spans で復元する。
 * プレースホルダが欠落・重複・範囲外なら原文を壊さないよう undefined を返す。
 */
export function restoreMasked(masked: string, spans: readonly string[]): string | undefined {
  const ids = markerIds(masked)
  if (ids.length !== spans.length) return undefined
  if (new Set(ids).size !== spans.length) return undefined
  if (ids.some((id) => !Number.isInteger(id) || id < 0 || id >= spans.length)) return undefined
  MARKER.lastIndex = 0
  return masked.replace(MARKER, (_marker, id: string) => spans[Number(id)])
}

export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (cause && typeof cause === "object" && "message" in cause) {
    const message = (cause as { message: unknown }).message
    if (typeof message === "string") return message
  }
  return "不明なエラー"
}
