import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { Learn, type ApproveResult, type Detail, type LearnResult, type RejectResult } from "./contract.ts"
import { errorMessage, redactSecrets } from "./redact.ts"
import { buildReviewPrompt, parseReviewOutput, type PendingLite } from "./review.ts"
import { prepareActions } from "./prepare.ts"
import { listSkills, type SkillSummary } from "./skills.ts"
import { ProposalStore } from "./store.ts"
import { extractTranscript } from "./transcript.ts"

const DEFAULT_MIN_TOOL_CALLS = 4
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_MAX_PENDING = 12

interface SessionMeta {
  title?: string
  metadata?: Record<string, unknown>
}

interface ReviewOutcome {
  ok: boolean
  reason?: string
  proposals: number
}

export default Plugin.define({
  id: "opencode-skill-learn",
  async setup(ctx) {
    const options = ctx.options as unknown as Record<string, unknown>
    const dataDir = stringOption(options.dataDir) ?? join(homedir(), ".local", "share", "opencode-skill-learn")
    const skillsDir = stringOption(options.skillsDir) ?? join(homedir(), ".config", "opencode", "skills")
    const minToolCalls = numberOption(options.minToolCalls) ?? DEFAULT_MIN_TOOL_CALLS
    const maxPending = numberOption(options.maxPending) ?? DEFAULT_MAX_PENDING
    const maxAttempts = numberOption(options.maxAttempts) ?? DEFAULT_MAX_ATTEMPTS

    const store = new ProposalStore({ dataDir, skillsDir, maxPending })

    // 再帰防止と「1 セッション 1 回」のための状態。
    const internal = new Set<string>()
    const reviewed = new Set<string>()
    const inFlight = new Set<string>()
    const attempts = new Map<string, number>()

    const controller = new AbortController()
    let emitChanged: (count: number) => Promise<void> = async () => {}

    const isInternalSession = (info: SessionMeta): boolean =>
      info.metadata?.learnPluginReview === true ||
      info.metadata?.["opencode-skill-learn/review"] === true ||
      (info.title ?? "").startsWith("[learn-plugin]")

    /** 既存 Skill をファイルと OpenCode のレジストリの両方から集める。実際の path を保持する。 */
    const collectSkills = async (): Promise<SkillSummary[]> => {
      const skills: SkillSummary[] = []
      for (const skill of await listSkills(skillsDir)) {
        if (skill.readError) continue
        skills.push(skill)
      }
      const known = new Set(skills.map((skill) => skill.name))
      try {
        const listed = (await ctx.skill.list()) as unknown
        const items = Array.isArray(listed)
          ? listed
          : listed && typeof listed === "object"
            ? (listed as { data?: unknown }).data
            : undefined
        if (Array.isArray(items)) {
          for (const item of items) {
            if (!item || typeof item !== "object") continue
            const row = item as { name?: unknown; id?: unknown; description?: unknown; path?: unknown }
            const name = typeof row.name === "string" && row.name ? row.name : typeof row.id === "string" ? row.id : ""
            const path = typeof row.path === "string" ? row.path : ""
            // path が無いレジストリ項目は解決できない。同名は誤選択を避けるため足さない。
            if (!name || !path || known.has(name)) continue
            skills.push({
              name,
              description: typeof row.description === "string" ? row.description : "",
              path,
              symlink: false,
            })
            known.add(name)
          }
        }
      } catch {
        // レジストリが読めなくてもファイル側の一覧で続行する。
      }
      return skills.sort((left, right) => left.name.localeCompare(right.name))
    }

    /**
     * 本体セッションを汚さない振り返り。
     * `ctx.experimental.generate.text` はセッションを作らず、履歴に残らず、ツールも呼ばない。
     * 再帰防止は internal / reviewed / inFlight の三重ガード。
     */
    const reviewSession = async (sessionID: string, force: boolean): Promise<ReviewOutcome> => {
      if (internal.has(sessionID)) return { ok: false, reason: "内部セッションのため対象外", proposals: 0 }
      if (inFlight.has(sessionID)) return { ok: false, reason: "このセッションの振り返りは実行中", proposals: 0 }
      if (!force && reviewed.has(sessionID)) {
        return { ok: false, reason: "このセッションは振り返り済み", proposals: 0 }
      }

      inFlight.add(sessionID)
      try {
        let info: SessionMeta = {}
        try {
          info = (await ctx.session.get({ sessionID })) as unknown as SessionMeta
        } catch {
          // 取得できなくても続行する。
        }
        if (isInternalSession(info)) {
          internal.add(sessionID)
          return { ok: false, reason: "振り返り用セッションのため対象外", proposals: 0 }
        }

        let messages: readonly unknown[]
        try {
          messages = (await ctx.session.context({ sessionID })) as readonly unknown[]
        } catch (cause) {
          return { ok: false, reason: `会話を読めませんでした: ${errorMessage(cause)}`, proposals: 0 }
        }

        const transcript = extractTranscript(messages)
        if (!force && transcript.toolCalls < minToolCalls) {
          return {
            ok: false,
            reason: `ツール呼び出しが ${transcript.toolCalls} 回の短いセッション`,
            proposals: 0,
          }
        }

        reviewed.add(sessionID)
        const snapshot = await store.list()
        const pending: PendingLite[] = snapshot.proposals
          .filter((item) => item.status === "pending")
          .map((item) => ({
            id: item.id,
            kind: item.kind,
            name: item.name,
            title: redactSecrets(item.title),
            reason: redactSecrets(item.reason),
          }))

        const skills = await collectSkills()
        const prompt = buildReviewPrompt({
          sessionTitle: redactSecrets(info.title ?? ""),
          transcript: redactSecrets(transcript.text),
          toolCalls: transcript.toolCalls,
          skills: skills.map((skill) => ({
            name: skill.name,
            description: redactSecrets(skill.description),
            path: skill.path,
          })),
          pending,
        })

        const generate = async (input: string): Promise<string> => {
          const generated = (await ctx.experimental.generate.text({ prompt: input })) as unknown as { text?: unknown }
          return typeof generated?.text === "string" ? generated.text : ""
        }
        const actions = parseReviewOutput(await generate(prompt))
        // 提案段階で統合済み全文を作る。承認時にモデルは再実行しない。
        const prepared = await prepareActions(actions, { skillsDir, skills, generate })
        const result = await store.add(prepared.actions, { sessionID, title: info.title ?? "" })
        await emitChanged(await store.pendingCount())

        const total = result.added + result.merged
        return {
          ok: true,
          ...(total === 0 && result.reason ? { reason: result.reason } : {}),
          proposals: total,
        }
      } catch (cause) {
        return { ok: false, reason: errorMessage(cause), proposals: 0 }
      } finally {
        inFlight.delete(sessionID)
      }
    }

    const recentSessionID = async (): Promise<string | undefined> => {
      try {
        const page = (await ctx.session.list({ limit: 1 })) as unknown
        const items = Array.isArray(page)
          ? page
          : page && typeof page === "object"
            ? (page as { data?: unknown }).data
            : undefined
        const first = Array.isArray(items) ? items[0] : undefined
        const id = first && typeof first === "object" ? (first as { id?: unknown }).id : undefined
        return typeof id === "string" ? id : undefined
      } catch {
        return undefined
      }
    }

    const registration = await ctx.rpc.register(Learn, {
      list: async () => store.list(),
      detail: async (input) => store.detail(asId(input)) as Promise<Detail>,
      approve: async (input): Promise<ApproveResult> => {
        const result = await store.approve(
          asId(input),
          asField(input, "revision"),
          asField(input, "baseHash"),
        )
        await emitChanged(await store.pendingCount())
        return result
      },
      reject: async (input): Promise<RejectResult> => {
        const result = await store.reject(asId(input), asField(input, "revision"))
        await emitChanged(await store.pendingCount())
        return result
      },
      /** 手動の /learn 相当。明示的な呼び出しなので短いセッションでも振り返る。 */
      learn: async (input): Promise<LearnResult> => {
        const requested =
          input && typeof input === "object" && "sessionID" in input
            ? (input as { sessionID: unknown }).sessionID
            : undefined
        const sessionID =
          typeof requested === "string" && requested ? requested : await recentSessionID()
        if (!sessionID) return { ok: false, reason: "対象セッションがありません", proposals: 0 }
        const result = await reviewSession(sessionID, true)
        return {
          ok: result.ok,
          ...(result.reason ? { reason: result.reason } : {}),
          proposals: result.proposals,
        }
      },
    })

    emitChanged = async (count: number) => {
      await registration.events.emit("changed", { count })
    }

    // ツール呼び出しごとではなく、セッションが落ち着いたとき（idle / 実行完了）だけ評価する。
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
          types: ["session.status", "session.idle"],
        })) {
          let sessionID: string | undefined
          if (event.type === "session.status") {
            if (event.data.status.type !== "idle") continue
            sessionID = String(event.data.sessionID)
          } else if (event.type === "session.idle") {
            sessionID = String(event.data.sessionID)
          }
          if (!sessionID) continue
          if (internal.has(sessionID) || reviewed.has(sessionID) || inFlight.has(sessionID)) continue

          const next = (attempts.get(sessionID) ?? 0) + 1
          attempts.set(sessionID, next)
          if (next > maxAttempts) {
            reviewed.add(sessionID)
            continue
          }
          void reviewSession(sessionID, false)
        }
      } catch {
        // cleanup で abort されたら終了する。
      }
    })()

    return async () => {
      controller.abort()
      await registration.dispose()
    }
  },
})

function asId(input: unknown): string {
  return asField(input, "id")
}

function asField(input: unknown, key: string): string {
  if (input && typeof input === "object" && key in input) {
    const value = (input as Record<string, unknown>)[key]
    if (typeof value === "string") return value
  }
  return ""
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberOption(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}
