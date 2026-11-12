import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import {
  Learn,
  type ApproveResult,
  type ArchiveTarget,
  type CuratorResult,
  type Detail,
  type LearnResult,
  type LearningActivity,
  type RejectResult,
  type SkillsView,
} from "./contract.ts"
import { ActivityLog } from "./activity.ts"
import { curateActions } from "./curate.ts"
import { hashText } from "./hash.ts"
import { formatModelRef, parseModelRef, type ModelRef } from "./model.ts"
import { prepareActions } from "./prepare.ts"
import { errorMessage, redactAndClip, redactSecrets } from "./redact.ts"
import {
  buildConsolidatePrompt,
  buildReviewPrompt,
  buildTopicPrompt,
  parseReviewOutput,
  wasRejected,
  type ConsolidateSkill,
  type PendingLite,
  type ReviewAction,
  type ReviewPromptInput,
  type SkillLite,
} from "./review.ts"
import { listSkills, resolveSkillPath, type SkillSummary } from "./skills.ts"
import { gatherSources, renderSources } from "./sources.ts"
import { LearningState } from "./state.ts"
import { ProposalStore } from "./store.ts"
import { assessLearning, DEFAULT_BUDGET, DEFAULT_OVERLAP, extractTranscript } from "./transcript.ts"
import { archiveSkillDir, curatorView, restoreSkillDir, UsageStore } from "./usage.ts"

/** Hermes の `skills.creation_nudge_interval` と同じ既定値。 */
const DEFAULT_REVIEW_INTERVAL = 10
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_STALE_DAYS = 14
const DEFAULT_ARCHIVE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
/** Skill の整理案の保存先セッション ID。どのセッションの画面にも表示する。 */
const CURATOR_SESSION = "curator"

interface SessionMeta {
  title?: string
  parentID?: string
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
    const reviewInterval = numberOption(options.reviewInterval) ?? DEFAULT_REVIEW_INTERVAL
    const maxAttempts = numberOption(options.maxAttempts) ?? DEFAULT_MAX_ATTEMPTS
    const budget = numberOption(options.contextBudget) ?? DEFAULT_BUDGET
    const overlap = options.contextOverlap === 0 ? 0 : numberOption(options.contextOverlap) ?? DEFAULT_OVERLAP
    const staleDays = numberOption(options.staleDays) ?? DEFAULT_STALE_DAYS
    const archiveDays = Math.max(staleDays, numberOption(options.archiveDays) ?? DEFAULT_ARCHIVE_DAYS)
    const reviewModel = parseModelRef(options.reviewModel)
    const composeModel = parseModelRef(options.composeModel) ?? reviewModel
    const commandName = options.command === false ? undefined : stringOption(options.command) ?? "learn"

    const store = new ProposalStore({ dataDir, skillsDir })
    const activity = new ActivityLog(dataDir)
    const state = new LearningState(dataDir)
    const usage = new UsageStore(dataDir)
    let activityError: string | undefined

    const internal = new Set<string>()
    const inFlight = new Set<string>()
    /** 親タスクごとの実行中の学習の数。入力欄の「学習中」表示に使う。 */
    const running = new Map<string, number>()
    const owners = new Map<string, string>()

    const controller = new AbortController()
    let emitChanged: (count: number) => Promise<void> = async () => {}
    const notify = async () => {
      try {
        await emitChanged(await store.pendingCount())
      } catch (cause) {
        activityError = `画面の更新通知に失敗しました: ${redactSecrets(errorMessage(cause))}`
        console.error(`[opencode-skill-learn] ${activityError}`)
      }
    }

    const record = async (entry: Omit<LearningActivity, "at">) => {
      try {
        await activity.record(entry)
        activityError = undefined
      } catch (cause) {
        activityError = `学習ログを保存できません: ${redactSecrets(errorMessage(cause))}`
        console.error(`[opencode-skill-learn] ${activityError}`)
      }
      await notify()
    }

    const track = async <T>(owner: string, fn: () => Promise<T>): Promise<T> => {
      running.set(owner, (running.get(owner) ?? 0) + 1)
      try {
        return await fn()
      } finally {
        const left = (running.get(owner) ?? 1) - 1
        if (left > 0) running.set(owner, left)
        else running.delete(owner)
        await notify()
      }
    }

    const isInternalSession = (info: SessionMeta): boolean =>
      info.metadata?.learnPluginReview === true ||
      info.metadata?.["opencode-skill-learn/review"] === true ||
      (info.title ?? "").startsWith("[learn-plugin]")

    const ownerSessionID = async (sessionID: string): Promise<string> => {
      if (owners.has(sessionID)) return owners.get(sessionID)!
      let id = sessionID
      const visited = new Set<string>()
      try {
        while (!visited.has(id) && visited.size < 16) {
          visited.add(id)
          const info = (await ctx.session.get({ sessionID: id })) as unknown as SessionMeta
          if (!info.parentID) {
            for (const child of visited) owners.set(child, id)
            return id
          }
          id = info.parentID
        }
      } catch {
        // 読めないセッションを推測で他のタスクへ混ぜない。
      }
      return sessionID
    }

    const snapshotFor = async (sessionID?: string) => {
      const snapshot = await store.list()
      if (!sessionID) return snapshot
      const owner = await ownerSessionID(sessionID)
      const visible = await Promise.all(snapshot.proposals.map(async (item) => ({
        item, owner: await ownerSessionID(item.sourceSessionID),
      })))
      return {
        ...snapshot,
        sessionID,
        // Skill の整理案はセッションに属さないので、どのセッションの画面にも出す。
        proposals: visible.filter((row) => row.owner === owner || row.item.sourceSessionID === CURATOR_SESSION).map((row) => row.item),
        running: running.has(owner) || running.has(CURATOR_SESSION),
      }
    }

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

    /** レビュー用と統合用でモデルを分けられる。未指定なら OpenCode の既定モデル。 */
    const generator = (model: ModelRef | undefined) => async (prompt: string): Promise<string> => {
      try {
        const generated = (await ctx.experimental.generate.text({
          prompt,
          ...(model ? { model: model as never } : {}),
        })) as unknown as { text?: unknown }
        return typeof generated?.text === "string" ? generated.text : ""
      } catch (cause) {
        throw new Error(`${formatModelRef(model)} で生成できませんでした: ${errorMessage(cause)}`)
      }
    }
    const generateReview = generator(reviewModel)
    const generateCompose = generator(composeModel)

    /** 承認待ち・却下済み・既存 Skill をそろえる。モデルへ渡すものはすべて伏せ字済み。 */
    const learningContext = async (sessionID: string | undefined) => {
      const snapshot = await snapshotFor(sessionID)
      const pending: PendingLite[] = snapshot.proposals
        .filter((item) => item.status === "pending")
        .map((item) => ({
          id: item.id,
          kind: item.kind,
          name: item.name,
          title: redactSecrets(item.title),
          reason: redactSecrets(item.reason),
          body: redactSecrets(item.section ?? item.body),
        }))
      const skills = await collectSkills()
      return {
        snapshot,
        pending,
        skills,
        skillLite: skills.map((skill) => ({ name: skill.name, description: redactSecrets(skill.description), path: skill.path })),
      }
    }

    /** 候補の品質確認 → 却下済みの除外 → 統合済み全文の作成 → 承認待ちへの保存。Skill 本体は書き換えない。 */
    const propose = async (input: {
      extracted: ReviewAction[]
      context: ReviewPromptInput
      basePrompt: string
      skills: SkillSummary[]
      rejected: NonNullable<Awaited<ReturnType<typeof store.list>>["rejected"]>
      owner: string
      title: string
    }): Promise<{ ok: boolean; reason: string; proposals: number }> => {
      const extracted = input.extracted.filter((action) => !wasRejected(action, input.rejected))
      const curated = await curateActions(extracted, input.context, input.skills, generateReview, input.basePrompt)
      const actions = curated.filter((action) => !wasRejected(action, input.rejected))
      // 提案段階で統合済み全文を作る。承認時にモデルは再実行しない。
      const prepared = await prepareActions(actions, { skillsDir, skills: input.skills, generate: generateCompose })
      if (controller.signal.aborted) return { ok: false, reason: "リロードにより学習を中断しました。提案は保存していません", proposals: 0 }
      const result = await store.add(prepared.actions, { sessionID: input.owner, title: input.title })
      if (result.stopped) return { ok: false, reason: result.reason ?? "提案の保存に失敗しました", proposals: 0 }
      const total = result.added + result.merged
      const reason = total > 0 ? `承認待ちの提案を ${total} 件保存しました` :
        prepared.dropped.length > 0 ? `統合時に見送り: ${prepared.dropped.map((item) => item.reason).join(" / ")}` :
        extracted.length > 0 && curated.length === 0 ? "品質確認で重複・根拠・再利用できる手順を確認し、候補を見送りました" :
        result.reason ?? (actions.length === 0 ? "再利用できる新しい教訓はありませんでした" : "重複する提案の保存を見送りました")
      return { ok: true, reason, proposals: total }
    }

    /**
     * セッションの振り返り。
     * - 自動: 前回の振り返り（チェックポイント）以降のツール反復が reviewInterval に達したら実行する。
     *   閾値前の見送りはログに残さず、反復は次の完了時に累積して数える。
     * - 手動: 閾値を省略する。新しい会話がなければセッション全体を振り返る。
     * 成功したらチェックポイントを最後のメッセージへ進め、再起動後も同じ区間を読み直さない。
     */
    const reviewSession = async (sessionID: string, trigger: "auto" | "manual"): Promise<ReviewOutcome> => {
      if (controller.signal.aborted) return { ok: false, reason: "プラグインの停止中", proposals: 0 }
      if (internal.has(sessionID)) return { ok: false, reason: "内部セッションのため対象外", proposals: 0 }
      if (inFlight.has(sessionID)) return { ok: false, reason: "このセッションの振り返りは実行中", proposals: 0 }
      inFlight.add(sessionID)
      let fingerprint: string | undefined
      const finish = async (status: LearningActivity["status"], reason: string, proposals = 0) => {
        await record({ sessionID, trigger, status, reason, proposals, ...(fingerprint ? { evidenceHash: fingerprint } : {}) })
        return { ok: status === "succeeded", reason, proposals }
      }
      try {
        const info = (await ctx.session.get({ sessionID })) as unknown as SessionMeta
        if (isInternalSession(info)) {
          internal.add(sessionID)
          return { ok: false, reason: "振り返り用セッションのため対象外", proposals: 0 }
        }
        // 補助セッションは親タスクでまとめて振り返る。完了ごとにログを増やさない。
        if (trigger === "auto" && info.parentID) return { ok: false, reason: "補助セッションは親タスクでまとめて振り返るため対象外", proposals: 0 }

        let messages: readonly unknown[]
        try {
          messages = (await ctx.session.context({ sessionID })) as readonly unknown[]
        } catch (cause) {
          return await finish("failed", `会話を読めませんでした: ${errorMessage(cause)}`)
        }

        let saved
        try {
          saved = await state.get(sessionID)
        } catch (cause) {
          return await finish("failed", redactSecrets(errorMessage(cause)))
        }
        let transcript = extractTranscript(messages, { checkpoint: saved.checkpoint, overlap, budget })
        if (trigger === "manual" && transcript.newMessages === 0) transcript = extractTranscript(messages, { overlap, budget })
        const incremental = transcript.checkpointFound

        const decision = assessLearning(transcript, reviewInterval)
        if (trigger === "auto" && !decision.learn) return { ok: false, reason: decision.reason, proposals: 0 }

        fingerprint = hashText(transcript.text)
        if (trigger === "auto") {
          const previous = saved.attempts?.fingerprint === fingerprint ? saved.attempts.count : 0
          if (previous >= maxAttempts) return { ok: false, reason: "学習の失敗が続いたため、新しい会話が増えるまで自動再試行を止めています", proposals: 0 }
        }

        const owner = await ownerSessionID(sessionID)
        return await track(owner, async () => {
          await record({ sessionID, trigger, status: "running", reason: trigger === "manual" ? "手動で振り返りを実行中" : decision.reason, proposals: 0 })
          const failed = async (reason: string) => {
            await state.update(sessionID, (current) => {
              const attempts = current.attempts
              const count = attempts && attempts.fingerprint === fingerprint ? attempts.count + 1 : 1
              return { ...current, attempts: { fingerprint: fingerprint!, count } }
            }).catch(() => undefined)
            return await finish("failed", reason)
          }
          try {
            const material = await learningContext(sessionID)
            if (material.snapshot.corrupt) return await finish("failed", material.snapshot.error ?? "提案データが壊れています")
            const context: ReviewPromptInput = {
              sessionTitle: redactSecrets(info.title ?? ""),
              transcript: redactSecrets(transcript.text),
              toolCalls: transcript.toolCalls,
              toolIterations: transcript.toolIterations,
              incremental,
              recoveries: transcript.recoveries,
              budget,
              consultedSkills: transcript.consultedSkills,
              skills: material.skillLite,
              pending: material.pending,
              rejected: material.snapshot.rejected,
            }
            const basePrompt = buildReviewPrompt(context)
            const extracted = parseReviewOutput(await generateReview(basePrompt), true)
            const result = await propose({
              extracted, context, basePrompt, skills: material.skills,
              rejected: material.snapshot.rejected ?? [], owner, title: info.title ?? "",
            })
            if (!result.ok) return await failed(result.reason)
            await state.update(sessionID, (current) => {
              const { attempts: _attempts, ...rest } = current
              return {
                ...rest,
                ...(transcript.lastMessageID ? { checkpoint: transcript.lastMessageID } : {}),
                reviewedAt: Date.now(),
                reviews: (current.reviews ?? 0) + 1,
              }
            })
            const scope = incremental ? "前回以降の会話を振り返りました。" : ""
            return await finish("succeeded", `${scope}${result.reason}`, result.proposals)
          } catch (cause) {
            return await failed(redactSecrets(errorMessage(cause)))
          }
        })
      } catch (cause) {
        return await finish("failed", redactSecrets(errorMessage(cause)))
      } finally {
        inFlight.delete(sessionID)
      }
    }

    /**
     * Hermes の `/learn <内容>` 相当。URL・ファイル・フォルダ・手順の説明・今の会話から Skill を提案する。
     * 依頼はユーザー本人の指示として扱い、取得した資料と会話は信頼しない入力として扱う。
     */
    const learnTopic = async (sessionID: string | undefined, topic: string): Promise<ReviewOutcome> => {
      const request = topic.trim()
      if (!request) return { ok: false, reason: "学ぶ内容が空です", proposals: 0 }
      const key = `topic:${sessionID ?? ""}`
      if (inFlight.has(key)) return { ok: false, reason: "手動学習を実行中です", proposals: 0 }
      inFlight.add(key)
      const recordID = sessionID ?? ""
      const finish = async (status: LearningActivity["status"], reason: string, proposals = 0) => {
        await record({ sessionID: recordID, trigger: "manual", status, reason, proposals })
        return { ok: status === "succeeded", reason, proposals }
      }
      try {
        const owner = sessionID ? await ownerSessionID(sessionID) : "manual"
        return await track(owner, async () => {
          await record({ sessionID: recordID, trigger: "manual", status: "running", reason: `指定内容から学習中: ${redactAndClip(request, 120)}`, proposals: 0 })
          try {
            let directory: string | undefined
            try {
              directory = (ctx as unknown as { location?: { directory?: string } }).location?.directory
            } catch {
              directory = undefined
            }
            const sources = await gatherSources(request, { baseDir: directory })
            let conversation = ""
            let title = ""
            if (sessionID) {
              try {
                const info = (await ctx.session.get({ sessionID })) as unknown as SessionMeta
                title = info.title ?? ""
                const messages = (await ctx.session.context({ sessionID })) as readonly unknown[]
                conversation = extractTranscript(messages, { budget: 14_000, overlap: 0 }).text
              } catch {
                // 会話が読めなくても、依頼と資料だけで続ける。
              }
            }
            const sourceText = renderSources(sources)
            const material = await learningContext(sessionID)
            if (material.snapshot.corrupt) return await finish("failed", material.snapshot.error ?? "提案データが壊れています")
            const basePrompt = buildTopicPrompt({
              request: redactSecrets(request),
              sources: sourceText,
              conversation: redactSecrets(conversation),
              skills: material.skillLite,
              pending: material.pending,
              rejected: material.snapshot.rejected,
            })
            const context: ReviewPromptInput = {
              sessionTitle: redactSecrets(title || `/learn ${redactAndClip(request, 60)}`),
              // 品質確認で evidence を照合する材料。依頼・資料・会話のすべてを含める。
              transcript: redactSecrets(`${request}\n\n${sourceText}\n\n${conversation}`),
              toolCalls: 0,
              skills: material.skillLite,
              pending: material.pending,
              rejected: material.snapshot.rejected,
            }
            const extracted = parseReviewOutput(await generateReview(basePrompt), true)
            const result = await propose({
              extracted, context, basePrompt, skills: material.skills,
              rejected: material.snapshot.rejected ?? [], owner, title: title || `/learn ${redactAndClip(request, 60)}`,
            })
            const failedSources = sources.filter((source) => source.error)
            const note = failedSources.length > 0
              ? ` / 取得できなかった資料: ${failedSources.map((source) => `${redactAndClip(source.label, 80)}（${source.error}）`).join("、")}`
              : ""
            return await finish(result.ok ? "succeeded" : "failed", `${result.reason}${note}`, result.proposals)
          } catch (cause) {
            return await finish("failed", redactSecrets(errorMessage(cause)))
          }
        })
      } finally {
        inFlight.delete(key)
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

    const skillsView = async (): Promise<SkillsView> => {
      try {
        return { items: curatorView(await collectSkills(), await usage.all(), { staleDays, archiveDays }), staleDays, archiveDays }
      } catch (cause) {
        return { items: [], staleDays, archiveDays, error: redactSecrets(errorMessage(cause)) }
      }
    }

    /**
     * Hermes の Curator の第2段階（モデルによる統合）。
     * このプラグインで作った Skill のうち重なっているものを1つにまとめる案を作り、承認待ちに保存する。
     * まとめ先の更新と、まとめられた Skill のアーカイブは、提案を承認したときだけ行う。
     */
    const consolidate = async (): Promise<ReviewOutcome> => {
      const key = "consolidate"
      if (inFlight.has(key)) return { ok: false, reason: "Skill の整理案を作成中です", proposals: 0 }
      inFlight.add(key)
      const finish = async (status: LearningActivity["status"], reason: string, proposals = 0) => {
        await record({ sessionID: CURATOR_SESSION, trigger: "manual", status, reason, proposals })
        return { ok: status === "succeeded", reason, proposals }
      }
      try {
        return await track(CURATOR_SESSION, async () => {
          await record({ sessionID: CURATOR_SESSION, trigger: "manual", status: "running", reason: "似た Skill をまとめる案を作成中", proposals: 0 })
          try {
            const rows = await usage.all()
            const material = await learningContext(undefined)
            if (material.snapshot.corrupt) return await finish("failed", material.snapshot.error ?? "提案データが壊れています")
            const managed: (ConsolidateSkill & { hash: string })[] = []
            const others: SkillLite[] = []
            const now = Date.now()
            for (const skill of material.skills) {
              const row = rows[skill.name]
              if (!row || row.createdBy !== "agent" || row.state !== "active" || skill.symlink) {
                others.push({ name: skill.name, description: redactSecrets(skill.description) })
                continue
              }
              let text: string
              try {
                text = await readFile(skill.path, "utf8")
              } catch {
                continue
              }
              // 秘密情報を含む Skill は統合で原文を壊しかねないため対象にしない。
              if (redactSecrets(text) !== text) continue
              const last = Math.max(row.lastUsedAt ?? 0, row.lastPatchedAt ?? 0, row.createdAt ?? 0)
              managed.push({
                name: skill.name,
                description: redactSecrets(skill.description),
                body: text,
                useCount: row.useCount,
                ...(last ? { idleDays: Math.floor((now - last) / DAY_MS) } : {}),
                pinned: row.pinned,
                hash: hashText(text),
              })
            }
            if (managed.length < 2) return await finish("skipped", "まとめる対象の Skill が2つ未満です")

            const prompt = buildConsolidatePrompt({
              managed,
              others,
              pending: material.pending,
              rejected: material.snapshot.rejected,
            })
            const byName = new Map(managed.map((skill) => [skill.name, skill]))
            const used = new Set<string>()
            const actions: ReviewAction[] = []
            for (const action of parseReviewOutput(await generateReview(prompt), true, { absorb: true })) {
              // まとめ先は整理の対象（patch）か新しい Skill（create）だけ。
              if (action.action === "patch" && !byName.has(action.name)) continue
              if (action.action === "create" && material.skills.some((skill) => skill.name === action.name)) continue
              if (used.has(action.name)) continue
              const absorb = (action.absorb ?? []).filter((name) => {
                const skill = byName.get(name)
                return skill && !skill.pinned && name !== action.name && !used.has(name)
              })
              if (absorb.length === 0) continue
              if (wasRejected(action, material.snapshot.rejected ?? [])) continue
              used.add(action.name)
              for (const name of absorb) used.add(name)
              actions.push({ ...action, absorb })
            }
            if (actions.length === 0) return await finish("succeeded", "まとめるべき重なりは見つかりませんでした")

            const prepared = await prepareActions(actions, { skillsDir, skills: material.skills, generate: generateCompose })
            if (controller.signal.aborted) return await finish("failed", "リロードにより整理を中断しました。提案は保存していません")
            const withArchives = prepared.actions.flatMap((action) => {
              const source = actions.find((item) => item.name === action.name)
              const archives = (source?.absorb ?? []).map((name) => ({ name, hash: byName.get(name)!.hash }))
              return archives.length > 0 ? [{ ...action, archives }] : []
            })
            const result = await store.add(withArchives, { sessionID: CURATOR_SESSION, title: "Skill の整理" })
            if (result.stopped) return await finish("failed", result.reason ?? "提案の保存に失敗しました")
            const total = result.added + result.merged
            const reason = total > 0 ? `Skill をまとめる案を ${total} 件保存しました` :
              prepared.dropped.length > 0 ? `統合時に見送り: ${prepared.dropped.map((item) => item.reason).join(" / ")}` :
              result.reason ?? "まとめる案を保存しませんでした"
            return await finish("succeeded", reason, total)
          } catch (cause) {
            return await finish("failed", redactSecrets(errorMessage(cause)))
          }
        })
      } finally {
        inFlight.delete(key)
      }
    }

    /** 整理の提案を承認したあと、まとめられた Skill をアーカイブする。提案時点から変わったものは残す。 */
    const archiveAbsorbed = async (umbrella: string, targets: readonly ArchiveTarget[]) => {
      const archived: string[] = []
      const errors: string[] = []
      const rows = await usage.all()
      const skills = await collectSkills()
      for (const target of targets) {
        const row = rows[target.name]
        if (target.name === umbrella || !row || row.createdBy !== "agent" || row.state !== "active" || row.pinned) {
          errors.push(`${target.name}: このプラグインで作った、残す設定でない Skill ではないためアーカイブしません`)
          continue
        }
        const resolved = resolveSkillPath(skills, target.name)
        if (!resolved.path || resolved.ambiguous) {
          errors.push(`${target.name}: Skill の場所を一意に特定できません`)
          continue
        }
        let text: string
        try {
          text = await readFile(resolved.path, "utf8")
        } catch (cause) {
          errors.push(`${target.name}: SKILL.md を読めません (${errorMessage(cause)})`)
          continue
        }
        if (hashText(text) !== target.hash) {
          errors.push(`${target.name}: 提案のあとに変更されたためアーカイブしません`)
          continue
        }
        const moved = await archiveSkillDir(resolved.path, skillsDir, join(dataDir, "archive"))
        if (!moved.ok) {
          errors.push(`${target.name}: ${moved.reason}`)
          continue
        }
        await usage.markArchived(target.name, resolved.path, moved.path)
        archived.push(target.name)
      }
      return { archived, errors }
    }

    const registration = await ctx.rpc.register(Learn, {
      list: async (input) => {
        const sessionID = asField(input, "sessionID") || undefined
        const snapshot = await snapshotFor(sessionID)
        try {
          return { ...snapshot, activity: await activity.list(), ...(activityError ? { activityError } : {}) }
        } catch (cause) {
          return { ...snapshot, activity: [], activityError: redactSecrets(errorMessage(cause)) }
        }
      },
      detail: async (input) => store.detail(asId(input)) as Promise<Detail>,
      approve: async (input): Promise<ApproveResult> => {
        const id = asId(input)
        const before = await store.detail(id)
        const result = await store.approve(id, asField(input, "revision"), asField(input, "baseHash"))
        if (result.ok && before.proposal && result.targetPath) {
          await usage.recordApproved(before.proposal.name, before.proposal.kind, result.targetPath).catch((cause) => {
            console.error(`[opencode-skill-learn] 利用統計を更新できません: ${redactSecrets(errorMessage(cause))}`)
          })
        }
        if (result.ok && before.proposal?.archives?.length) {
          // SKILL.md は書き込み済み。アーカイブの失敗は承認の失敗にせず、理由を返す。
          try {
            const moved = await archiveAbsorbed(before.proposal.name, before.proposal.archives)
            if (moved.archived.length > 0) result.archived = moved.archived
            if (moved.errors.length > 0) result.archiveErrors = moved.errors
          } catch (cause) {
            result.archiveErrors = [`アーカイブできませんでした: ${redactSecrets(errorMessage(cause))}`]
          }
        }
        await notify()
        return result
      },
      consolidate: async () => {
        const result = await consolidate()
        return { ok: result.ok, ...(result.reason ? { reason: result.reason } : {}), proposals: result.proposals }
      },
      reject: async (input): Promise<RejectResult> => {
        const result = await store.reject(asId(input), asField(input, "revision"))
        await notify()
        return result
      },
      /** 手動の /learn 相当。明示的な呼び出しなので閾値を省略する。topic があれば指定内容から学ぶ。 */
      learn: async (input): Promise<LearnResult> => {
        const requested = asField(input, "sessionID")
        const topic = asField(input, "topic").trim()
        const sessionID = requested || await recentSessionID()
        if (topic) {
          const result = await learnTopic(sessionID, topic)
          return { ok: result.ok, ...(result.reason ? { reason: result.reason } : {}), proposals: result.proposals }
        }
        if (!sessionID) return { ok: false, reason: "対象セッションがありません", proposals: 0 }
        const result = await reviewSession(sessionID, "manual")
        return { ok: result.ok, ...(result.reason ? { reason: result.reason } : {}), proposals: result.proposals }
      },
      skills: async (): Promise<SkillsView> => await skillsView(),
      archive: async (input): Promise<CuratorResult> => {
        const name = asField(input, "name")
        const rows = await usage.all()
        const row = rows[name]
        if (!row || row.createdBy !== "agent") return { ok: false, reason: "このプラグインで作った Skill だけをアーカイブできます" }
        if (row.state === "archived") return { ok: false, reason: "すでにアーカイブ済みです" }
        const resolved = resolveSkillPath(await collectSkills(), name)
        if (!resolved.path || resolved.ambiguous) return { ok: false, reason: "Skill の場所を一意に特定できません" }
        const moved = await archiveSkillDir(resolved.path, skillsDir, join(dataDir, "archive"))
        if (!moved.ok) return { ok: false, reason: moved.reason }
        await usage.markArchived(name, resolved.path, moved.path)
        await notify()
        return { ok: true, path: moved.path }
      },
      restore: async (input): Promise<CuratorResult> => {
        const name = asField(input, "name")
        const row = (await usage.all())[name]
        if (!row || row.state !== "archived" || !row.archivedPath || !row.originalPath) return { ok: false, reason: "アーカイブ済みの Skill が見つかりません" }
        const moved = await restoreSkillDir(row.archivedPath, row.originalPath, join(dataDir, "archive"))
        if (!moved.ok) return { ok: false, reason: moved.reason }
        await usage.markRestored(name)
        await notify()
        return { ok: true, path: moved.path }
      },
      pin: async (input): Promise<CuratorResult> => {
        const name = asField(input, "name")
        if (!name) return { ok: false, reason: "Skill 名がありません" }
        const pinned = Boolean(input && typeof input === "object" && (input as { pinned?: unknown }).pinned === true)
        await usage.setPinned(name, pinned)
        return { ok: true }
      },
    })

    emitChanged = async (count: number) => {
      await registration.events.emit("changed", { count })
    }

    // `/learn` と `/learn <URL・パス・説明>` をスラッシュコマンドとして登録する。
    let command: { dispose: () => Promise<void> } | undefined
    if (commandName) {
      try {
        command = await ctx.command.transform((editor) => {
          editor.add({
            name: commandName,
            description: "Skill として学ぶ（引数なし: このセッションを振り返る / URL・パス・説明: その内容から学ぶ）",
            execute: async ({ sessionID, prompt }) => {
              const topic = promptText(prompt).replace(new RegExp(`^\\s*/${escapeRegExp(commandName)}\\b`), "").trim()
              // 結果は入力欄の上の提案として表示する。会話には書き込まない。
              void (topic ? learnTopic(String(sessionID), topic) : reviewSession(String(sessionID), "manual"))
            },
          })
        })
      } catch (cause) {
        console.error(`[opencode-skill-learn] /${commandName} を登録できません: ${redactSecrets(errorMessage(cause))}`)
      }
    }

    // V2 の完了通知で振り返りを判定し、Skill の読み込みで利用統計を更新する。
    const subscription = (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
          types: ["session.execution.succeeded", "session.skill.activated"],
        })) {
          if (event.type === "session.skill.activated") {
            const name = (event.data as { name?: unknown }).name
            if (typeof name === "string" && name) {
              void usage.recordUse(name).catch((cause) => {
                console.error(`[opencode-skill-learn] 利用統計を更新できません: ${redactSecrets(errorMessage(cause))}`)
              })
            }
            continue
          }
          if (event.type !== "session.execution.succeeded") continue
          const sessionID = String(event.data.sessionID)
          if (!sessionID) continue
          if (internal.has(sessionID) || inFlight.has(sessionID)) continue
          void reviewSession(sessionID, "auto")
        }
        if (!controller.signal.aborted) await record({ sessionID: "", trigger: "system", status: "failed", reason: "自動学習のイベント購読が終了しました", proposals: 0 })
      } catch (cause) {
        if (!controller.signal.aborted) await record({ sessionID: "", trigger: "system", status: "failed", reason: `自動学習のイベント購読に失敗しました: ${errorMessage(cause)}`, proposals: 0 })
      }
    })()

    return async () => {
      controller.abort()
      await subscription
      await command?.dispose()
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

function promptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt
  if (prompt && typeof prompt === "object") {
    const text = (prompt as { text?: unknown }).text
    if (typeof text === "string") return text
  }
  return ""
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberOption(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}
