import { mkdir, open, readFile, stat, unlink } from "node:fs/promises"
import { dirname } from "node:path"
import { codeOf } from "./fs.ts"

const STALE_MS = 30_000
const TIMEOUT_MS = 5_000
const RETRY_MS = 20

/**
 * read-modify-write を排他ロックで包む。
 * ロックファイルに token を書き、解放時に自分の token と一致する場合だけ消す。
 * これは協調的なロックであり、ロックを無視する他プロセスや手動編集まで防げるわけではない。
 */
export async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(file), { recursive: true })
  const token = `${process.pid}:${crypto.randomUUID()}`
  const deadline = Date.now() + TIMEOUT_MS
  let handle: Awaited<ReturnType<typeof open>> | undefined

  while (!handle) {
    try {
      handle = await open(file, "wx")
      await handle.writeFile(token, "utf8")
    } catch (cause) {
      if (handle) {
        await handle.close().catch(() => undefined)
        handle = undefined
      }
      if (codeOf(cause) !== "EEXIST") throw cause
      try {
        const info = await stat(file)
        if (Date.now() - info.mtimeMs > STALE_MS) await unlink(file).catch(() => undefined)
      } catch {
        // ロックが消えていれば次の試行で取れる。
      }
      if (Date.now() > deadline) throw new Error("pending.json のロックを取得できませんでした")
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
    }
  }

  try {
    return await fn()
  } finally {
    await handle.close().catch(() => undefined)
    try {
      if ((await readFile(file, "utf8")) === token) await unlink(file)
    } catch {
      // すでに消えていれば何もしない。
    }
  }
}
