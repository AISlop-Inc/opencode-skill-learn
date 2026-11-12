import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { isEnoent } from "./fs.ts"
import { withFileLock } from "./lock.ts"

/** セッションごとの振り返りの進み具合。再起動後も同じ会話を読み直さないために保存する。 */
export interface SessionLearningState {
  /** 前回の振り返りで読んだ最後のメッセージ ID。 */
  checkpoint?: string
  /** 前回の振り返りが成功した日時。 */
  reviewedAt?: number
  /** 振り返りの成功回数。 */
  reviews?: number
  /** 同じ材料での失敗回数。材料（fingerprint）が変わると数え直す。 */
  attempts?: { fingerprint: string; count: number }
}

interface StateFile {
  version: 1
  sessions: Record<string, SessionLearningState>
}

const MAX_SESSIONS = 1_000

/** 本文は保存しない。メッセージ ID・日時・回数だけを `state.json` に置く。 */
export class LearningState {
  private readonly file: string
  private readonly dataDir: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.file = join(dataDir, "state.json")
  }

  async get(sessionID: string): Promise<SessionLearningState> {
    return (await this.read()).sessions[sessionID] ?? {}
  }

  async update(sessionID: string, change: (current: SessionLearningState) => SessionLearningState): Promise<SessionLearningState> {
    return await withFileLock(`${this.file}.lock`, async () => {
      const file = await this.read()
      const next = change({ ...(file.sessions[sessionID] ?? {}) })
      file.sessions[sessionID] = next
      const entries = Object.entries(file.sessions)
      if (entries.length > MAX_SESSIONS) {
        // 古い振り返り記録から捨てる。捨てたセッションは最初から振り返り直すだけで、壊れはしない。
        entries.sort((left, right) => (right[1].reviewedAt ?? 0) - (left[1].reviewedAt ?? 0))
        file.sessions = Object.fromEntries(entries.slice(0, MAX_SESSIONS))
      }
      await mkdir(this.dataDir, { recursive: true })
      const temp = `${this.file}.${crypto.randomUUID()}.tmp`
      try {
        await writeFile(temp, `${JSON.stringify(file)}\n`, { mode: 0o600 })
        await rename(temp, this.file)
      } finally {
        await rm(temp, { force: true })
      }
      return next
    })
  }

  private async read(): Promise<StateFile> {
    let text: string
    try {
      text = await readFile(this.file, "utf8")
    } catch (cause) {
      if (isEnoent(cause)) return { version: 1, sessions: {} }
      throw new Error("学習の進み具合（state.json）を読み取れません")
    }
    const parsed = JSON.parse(text) as Partial<StateFile>
    if (parsed?.version !== 1 || !parsed.sessions || typeof parsed.sessions !== "object") {
      throw new Error("学習の進み具合（state.json）の形式が不正です")
    }
    return { version: 1, sessions: parsed.sessions }
  }
}
