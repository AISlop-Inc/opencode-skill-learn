import { readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { LearningActivity } from "./contract.ts"
import { isEnoent } from "./fs.ts"
import { withFileLock } from "./lock.ts"
import { redactAndClip } from "./redact.ts"

/** 本文・プロンプト・ツール出力は記録せず、直近 50 件の状態だけを残す。 */
export class ActivityLog {
  private readonly file: string

  constructor(dataDir: string) {
    this.file = join(dataDir, "activity.json")
  }

  async list(): Promise<LearningActivity[]> {
    let text: string
    try {
      text = await readFile(this.file, "utf8")
    } catch (cause) {
      if (isEnoent(cause)) return []
      throw new Error("学習ログを読み取れません")
    }
    const items: unknown = JSON.parse(text)
    if (!Array.isArray(items) || !items.every(isActivity)) throw new Error("学習ログが壊れています")
    return items.slice(0, 50)
  }

  async record(entry: Omit<LearningActivity, "at">): Promise<void> {
    await withFileLock(`${this.file}.lock`, async () => {
      const entries = await this.list()
      const safe = { ...entry, at: Date.now(), reason: redactAndClip(entry.reason, 600) }
      const temp = `${this.file}.${crypto.randomUUID()}.tmp`
      try {
        await writeFile(temp, JSON.stringify([safe, ...entries].slice(0, 50)), { mode: 0o600 })
        await rename(temp, this.file)
      } finally {
        await rm(temp, { force: true })
      }
    })
  }
}

function isActivity(value: unknown): value is LearningActivity {
  if (!value || typeof value !== "object") return false
  const row = value as LearningActivity
  return Number.isFinite(row.at) && typeof row.sessionID === "string" &&
    ["auto", "manual", "system"].includes(row.trigger) &&
    ["running", "skipped", "succeeded", "failed"].includes(row.status) &&
    typeof row.reason === "string" && Number.isFinite(row.proposals) &&
    (row.evidenceHash === undefined || typeof row.evidenceHash === "string")
}
