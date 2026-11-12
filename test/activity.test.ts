import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ActivityLog } from "../src/activity.ts"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); roots.length = 0 })

async function fixture() {
  const base = join(tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, "learn-activity-"))
  roots.push(root)
  return { root, log: new ActivityLog(root) }
}

test("状態ログは伏せ字・0600・50件上限付きで再読み込みできる", async () => {
  const { root, log } = await fixture()
  expect(await log.list()).toEqual([])
  for (let index = 0; index < 52; index++) {
    await log.record({ sessionID: `ses_${index}`, trigger: "auto", status: "failed", reason: "token: ghp_abcdefghijklmnopqrstuvwxyz", proposals: 0 })
  }
  const items = await new ActivityLog(root).list()
  expect(items).toHaveLength(50)
  expect(items[0].sessionID).toBe("ses_51")
  expect(await readFile(join(root, "activity.json"), "utf8")).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz")
  expect((await stat(join(root, "activity.json"))).mode & 0o777).toBe(0o600)
})

test("別インスタンスからの同時記録を失わない", async () => {
  const { root, log } = await fixture()
  await Promise.all([log, new ActivityLog(root)].map((item, index) => item.record({
    sessionID: `ses_${index}`, trigger: "auto", status: "skipped", reason: "短い作業", proposals: 0,
  })))
  expect(await log.list()).toHaveLength(2)
})

test("壊れたログは上書きせずエラーにする", async () => {
  const { root, log } = await fixture()
  await writeFile(join(root, "activity.json"), "broken")
  await expect(log.record({ sessionID: "s", trigger: "auto", status: "skipped", reason: "短い作業", proposals: 0 })).rejects.toThrow()
  expect(await readFile(join(root, "activity.json"), "utf8")).toBe("broken")
})
