import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js"
import {
  Command,
  ComposerPill,
  MenuItem,
  Panel,
  Plugin,
  Style,
  type ComposerPillView,
  type PanelTab,
} from "@opencode/plugin/gui"
import {
  Learn,
  type ApproveResult,
  type CuratorItem,
  type CuratorResult,
  type Detail,
  type LearnResult,
  type Proposal,
  type RejectResult,
  type SkillsView,
  type Snapshot,
} from "./contract.ts"
import { errorMessage } from "./redact.ts"
import { diffPreview } from "./diff-preview.ts"

const css = `
.learn { display: flex; flex-direction: column; gap: 10px; padding: 12px; color: var(--v2-text-text-base); font-size: 13px; line-height: 1.5; }
.learn-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.learn-header h2 { margin: 0; font-size: 14px; font-weight: 600; }
.learn-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.learn button { border: 1px solid var(--v2-background-bg-layer-01); border-radius: 6px; background: var(--v2-background-bg-layer-01); color: inherit; padding: 4px 9px; cursor: pointer; font: inherit; }
.learn button:hover:not(:disabled) { filter: brightness(1.15); }
.learn button:disabled { opacity: .5; cursor: default; }
.learn button.learn-approve { border-color: var(--v2-state-fg-success, #2f9e44); }
.learn-error { margin: 0; color: var(--v2-text-text-danger, #c44536); }
.learn-notice { margin: 0; padding: 7px 9px; border-radius: 6px; background: var(--v2-background-bg-layer-01); color: var(--v2-state-fg-success, #2f9e44); }
.learn-note { margin: 0; color: var(--v2-text-text-muted); }
.learn-meta, .learn-empty, .learn-reason, .learn-target { margin: 0; color: var(--v2-text-text-muted); }
.learn-list { display: flex; flex-direction: column; gap: 4px; }
.learn-row { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; text-align: left; width: 100%; padding: 7px 9px; }
.learn-row-active { outline: 1px solid var(--v2-text-text-base); }
.learn-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.learn-row-name, .learn-kind { color: var(--v2-text-text-muted); font-size: 11px; }
.learn-kind { border: 1px solid var(--v2-background-bg-layer-01); border-radius: 4px; padding: 1px 5px; white-space: nowrap; }
.learn-warn { color: var(--v2-text-text-warning, #c47b12); font-size: 11px; }
.learn-detail { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--v2-background-bg-layer-01); padding-top: 10px; }
.learn-detail h3 { margin: 0; font-size: 14px; font-weight: 600; }
.learn-detail h4 { margin: 4px 0 0; font-size: 12px; font-weight: 600; color: var(--v2-text-text-muted); }
.learn-fields { display: flex; align-items: center; gap: 8px; }
.learn-fields code { font-size: 12px; }
.learn-warnings { margin: 0; padding-left: 18px; color: var(--v2-text-text-warning, #c47b12); }
.learn-pre { margin: 0; padding: 8px; border-radius: 6px; background: var(--v2-background-bg-layer-01); white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto; font-size: 12px; }
.learn-current summary { cursor: pointer; color: var(--v2-text-text-muted); }
.learn-body { padding: 12px; border: 1px solid var(--v2-background-bg-layer-01); border-radius: 8px; overflow-wrap: anywhere; }
.learn-body h1, .learn-body h2, .learn-body h3 { font-size: 14px; margin: 12px 0 6px; }
.learn-body p, .learn-body li { line-height: 1.8; }
.learn-target { overflow-wrap: anywhere; font-size: 12px; }
.learn-changes { display: flex; flex-direction: column; gap: 12px; }
.learn-hunk { border: 1px solid var(--v2-background-bg-layer-01); border-radius: 8px; overflow: hidden; }
.learn-hunk-title { margin: 0; padding: 6px 10px; font-size: 11px; color: var(--v2-text-text-muted); background: var(--v2-background-bg-layer-01); }
.learn-diff-block { padding: 8px 12px; overflow-wrap: anywhere; border-inline-start: 3px solid transparent; }
.learn-diff-block + .learn-diff-block { border-top: 1px solid var(--v2-background-bg-layer-01); }
.learn-diff-label { display: block; margin-bottom: 4px; font-size: 11px; font-weight: 600; }
.learn-diff-text { white-space: pre-wrap; font: inherit; line-height: 1.8; }
.learn-diff-block p { margin: 4px 0; }
.learn-diff-block ul, .learn-diff-block ol { margin: 4px 0; padding-left: 20px; }
.learn-diff-block h1, .learn-diff-block h2, .learn-diff-block h3 { margin: 6px 0; font-size: 13px; }
.learn-diff-block pre { overflow-x: auto; }
.learn-diff-context { color: var(--v2-text-text-muted); font-size: 12px; }
.learn-diff-add { background: #2f9e4418; border-inline-start-color: #58b875; }
.learn-diff-add > .learn-diff-label { color: var(--v2-state-fg-success, #58b875); }
.learn-diff-remove { background: #c4453618; border-inline-start-color: #e18478; }
.learn-diff-remove > .learn-diff-label { color: var(--v2-text-text-danger, #e18478); }
.learn-section { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--v2-background-bg-layer-01); padding-top: 10px; }
.learn-section h3 { margin: 0; font-size: 13px; font-weight: 600; }
.learn textarea { width: 100%; box-sizing: border-box; min-height: 64px; resize: vertical; border: 1px solid var(--v2-background-bg-layer-01); border-radius: 6px; background: transparent; color: inherit; padding: 6px 8px; font: inherit; }
.learn-skill { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; align-items: center; padding: 6px 8px; border-radius: 6px; background: var(--v2-background-bg-layer-01); }
.learn-skill-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.learn-skill-meta { grid-column: 1 / -1; color: var(--v2-text-text-muted); font-size: 11px; }
.learn-status-stale { color: var(--v2-text-text-warning, #c47b12); }
.learn-status-archive-candidate { color: var(--v2-text-text-danger, #c44536); }
`

export default Plugin.define({
  i18n: {
    en: {
      "panel.title": "Skill proposals",
      "command.open": "Review Skill proposals",
      "command.learn": "Learn from this session",
      "command.curate": "Review Skill usage",
      "pill.running": "Learning Skills…",
      "pill.label": "Skill proposals {count}",
      "pill.title": "Skill proposals awaiting approval",
      "pill.all": "Review all proposals",
      "menu.open": "Skill proposals",
    },
    ja: {
      "panel.title": "Skill 提案",
      "command.open": "Skill 提案を確認",
      "command.learn": "このセッションから学ぶ",
      "command.curate": "Skill を整理",
      "pill.running": "Skill を学習中…",
      "pill.label": "Skillの提案があります（{count}件）",
      "pill.title": "承認待ちの Skill 提案",
      "pill.all": "提案をすべて確認",
      "menu.open": "Skill 提案",
    },
  },
  setup(ctx) {
    const [snapshot, setSnapshot] = createSignal<Snapshot>()
    const [detail, setDetail] = createSignal<Detail>()
    const [selected, setSelected] = createSignal<string>()
    const [selectedRevision, setSelectedRevision] = createSignal<string>()
    const [selectedBaseHash, setSelectedBaseHash] = createSignal<string>()
    const [busy, setBusy] = createSignal(false)
    const [error, setError] = createSignal<string>()
    const [loadError, setLoadError] = createSignal<string>()
    const [notice, setNotice] = createSignal<string>()
    const [topic, setTopic] = createSignal("")
    const [skills, setSkills] = createSignal<SkillsView>()
    let refreshing = false

    const pending = () => snapshot()?.sessionID === ctx.sessions.current()?.id
      ? (snapshot()?.proposals ?? []).filter((item) => item.status === "pending") : []

    const refresh = async () => {
      if (refreshing) return
      const sessionID = ctx.sessions.current()?.id
      if (!sessionID) { setSnapshot(undefined); return }
      refreshing = true
      try {
        const result = (await ctx.client.rpc(Learn).list({ sessionID })) as Snapshot
        if (ctx.sessions.current()?.id !== sessionID) return
        setSnapshot(result)
        setLoadError()
      } catch (cause) {
        setLoadError(errorMessage(cause))
      } finally {
        refreshing = false
        if (ctx.sessions.current()?.id !== sessionID) void refresh()
      }
    }

    const openPanel = () => {
      const session = ctx.sessions.current()
      if (session) ctx.layout.open(`${ctx.id}:review`, session, { tab: "select" })
      void refresh()
    }

    const openProposal = async (id: string) => {
      const sessionID = ctx.sessions.current()?.id
      setSelected(id)
      setSelectedRevision(undefined)
      setSelectedBaseHash(undefined)
      setNotice()
      setBusy(true)
      try {
        const result = (await ctx.client.rpc(Learn).detail({ id })) as Detail
        if (selected() !== id || ctx.sessions.current()?.id !== sessionID) return
        setDetail(result)
        setSelectedRevision(result.revision)
        setSelectedBaseHash(result.proposal?.baseHash ?? "")
        setError()
        openPanel()
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setBusy(false)
      }
    }

    // detail() で表示した revision と baseHash を両方添える。片方でも違えば承認しない。
    const approveProposal = async () => {
      const id = selected()
      const revision = selectedRevision()
      const baseHash = selectedBaseHash()
      if (!id || !revision || baseHash === undefined || busy()) return
      setBusy(true)
      try {
        const result = (await ctx.client.rpc(Learn).approve({ id, revision, baseHash })) as ApproveResult
        if (!result.ok) {
          setNotice()
          setError(`承認に失敗しました（${result.failedAt ?? "不明"}） ${result.reason ?? ""}`)
        } else {
          setError()
          setNotice(
            `SKILL.md に反映しました ${result.targetPath ?? ""}` +
              (result.backupPath ? ` / バックアップ ${result.backupPath}` : "") +
              (result.files?.length ? ` / 補助ファイル ${result.files.join(", ")}` : "") +
              (result.archived?.length ? ` / アーカイブ ${result.archived.join(", ")}` : ""),
          )
          if (result.archiveErrors?.length) setError(`アーカイブしなかった Skill: ${result.archiveErrors.join(" / ")}`)
          setSelected(undefined)
          setSelectedRevision(undefined)
          setSelectedBaseHash(undefined)
          setDetail(undefined)
        }
        await refresh()
      } catch (cause) {
        setNotice()
        setError(errorMessage(cause))
      } finally {
        setBusy(false)
      }
    }

    const rejectProposal = async () => {
      const id = selected()
      const revision = selectedRevision()
      if (!id || !revision || busy()) return
      setBusy(true)
      try {
        const result = (await ctx.client.rpc(Learn).reject({ id, revision })) as RejectResult
        if (!result.ok) {
          setError(result.reason ?? "却下に失敗しました")
        } else {
          setError()
          setNotice("提案を却下しました")
          setSelected(undefined)
          setSelectedRevision(undefined)
          setSelectedBaseHash(undefined)
          setDetail(undefined)
        }
        await refresh()
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setBusy(false)
      }
    }

    const learnNow = async () => {
      if (busy()) return
      setBusy(true)
      try {
        const session = ctx.sessions.current()
        const result = (await ctx.client.rpc(Learn).learn(
          session ? { sessionID: session.id } : {},
        )) as LearnResult
        await refresh()
        setError(result.ok ? undefined : (result.reason ?? "学習に失敗しました"))
        setNotice(result.ok ? (result.reason ?? `提案 ${result.proposals} 件`) : undefined)
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setBusy(false)
      }
    }

    /** /learn <内容> 相当。URL・パス・手順の説明から学ぶ。結果は承認待ちの提案になる。 */
    const learnTopic = async () => {
      const text = topic().trim()
      if (!text || busy()) return
      setBusy(true)
      setNotice()
      try {
        const session = ctx.sessions.current()
        const result = (await ctx.client.rpc(Learn).learn(
          session ? { sessionID: session.id, topic: text } : { topic: text },
        )) as LearnResult
        await refresh()
        setError(result.ok ? undefined : (result.reason ?? "学習に失敗しました"))
        setNotice(result.ok ? (result.reason ?? `提案 ${result.proposals} 件`) : undefined)
        if (result.ok) setTopic("")
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setBusy(false)
      }
    }

    const loadSkills = async () => {
      try {
        setSkills((await ctx.client.rpc(Learn).skills({})) as SkillsView)
      } catch (cause) {
        setError(errorMessage(cause))
      }
    }

    /** アーカイブ・復元・ピン留めは、ユーザーがボタンを押したときだけ実行する。 */
    const curate = async (action: "archive" | "restore" | "pin" | "unpin", name: string) => {
      if (busy()) return
      setBusy(true)
      try {
        const rpc = ctx.client.rpc(Learn)
        const result = (action === "archive" ? await rpc.archive({ name }) :
          action === "restore" ? await rpc.restore({ name }) :
          await rpc.pin({ name, pinned: action === "pin" })) as CuratorResult
        if (!result.ok) {
          setNotice()
          setError(result.reason ?? "操作に失敗しました")
        } else {
          setError()
          setNotice(action === "archive" ? `アーカイブへ移しました ${result.path ?? ""}` :
            action === "restore" ? `元の場所へ戻しました ${result.path ?? ""}` :
            action === "pin" ? `${name} を整理の対象から外しました` : `${name} を整理の対象に戻しました`)
        }
        await loadSkills()
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setBusy(false)
      }
    }

    /** Curator の第2段階。まとめる案を作るだけで、統合とアーカイブは承認したときに行う。 */
    const consolidate = async () => {
      if (busy()) return
      setBusy(true)
      setNotice()
      try {
        const result = (await ctx.client.rpc(Learn).consolidate({})) as LearnResult
        await refresh()
        setError(result.ok ? undefined : (result.reason ?? "整理案を作れませんでした"))
        setNotice(result.ok ? (result.reason ?? `提案 ${result.proposals} 件`) : undefined)
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setBusy(false)
      }
    }

    const openCurator = () => {
      openPanel()
      void loadSkills()
    }

    const tab: PanelTab = {
      id: "review",
      get title() {
        return ctx.t("panel.title")
      },
      closable: "compact",
      fallback: true,
    }

    ctx.add(Panel, {
      id: "review",
      region: "side",
      mobile: {
        get title() {
          return ctx.t("panel.title")
        },
        order: 70,
        kind: "menu",
        icon: "brain",
      },
      list: (input) => (input.open.includes("review") ? [tab] : []),
      render: () => (
        <LearnView
          snapshot={snapshot}
          detail={detail}
          selected={selected}
          busy={busy}
          error={() => error() ?? loadError()}
          notice={notice}
          select={(id) => void openProposal(id)}
          approve={() => void approveProposal()}
          reject={() => void rejectProposal()}
          refresh={() => void refresh()}
          learn={() => void learnNow()}
          topic={topic}
          setTopic={setTopic}
          learnTopic={() => void learnTopic()}
          skills={skills}
          loadSkills={() => void loadSkills()}
          curate={(action, name) => void curate(action, name)}
          consolidate={() => void consolidate()}
          markdown={(text) => <ctx.ui.Markdown text={text} />}
        />
      ),
    })

    ctx.add(ComposerPill, {
      id: "proposals",
      show: (): ComposerPillView | undefined => {
        const items = pending()
        if (items.length === 0) {
          // 学習はバックグラウンドで走る。実行中だけ控えめに知らせる。
          if (snapshot()?.sessionID !== ctx.sessions.current()?.id || !snapshot()?.running) return undefined
          return { label: ctx.t("pill.running"), icon: "brain", run: () => openPanel() }
        }
        return {
          label: ctx.t("pill.label").replace("{count}", String(items.length)),
          title: ctx.t("pill.title"),
          icon: "brain",
          tone: "warning",
          rows: [
            ...items.slice(0, 6).map((item) => ({
              id: item.id,
              label: `${item.archives?.length ? "整理" : item.kind === "patch" ? "更新" : "新規"} ${item.title}`,
              detail: item.name,
              icon: "brain" as const,
              run: () => void openProposal(item.id),
            })),
            {
              id: "__all",
              label: ctx.t("pill.all"),
              icon: "bullet-list" as const,
              run: () => openPanel(),
            },
          ],
        }
      },
    })

    ctx.add(MenuItem, () => ({
      menu: "session.panel" as const,
      id: "open",
      title: ctx.t("menu.open"),
      icon: "brain" as const,
      run: () => openPanel(),
    }))

    ctx.add(Command, () => ({
      id: "open",
      title: ctx.t("command.open"),
      keywords: "skill learn proposal 提案",
      run: () => openPanel(),
    }))

    ctx.add(Command, () => ({
      id: "learn",
      title: ctx.t("command.learn"),
      keywords: "learn skill 学ぶ 教訓",
      run: () => void learnNow(),
    }))

    ctx.add(Command, () => ({
      id: "curate",
      title: ctx.t("command.curate"),
      keywords: "skill curator archive usage 整理 アーカイブ",
      run: () => openCurator(),
    }))

    ctx.add(Style, css)

    createEffect(() => {
      ctx.sessions.current()?.id
      setSnapshot(undefined)
      setSelected(undefined)
      setSelectedRevision(undefined)
      setSelectedBaseHash(undefined)
      setDetail(undefined)
      setNotice(undefined)
      setError(undefined)
      setLoadError(undefined)
      void refresh()
    })
    let unsubscribe: (() => void) | undefined
    try {
      const subscription = ctx.client.rpc(Learn).events.on("changed", () => void refresh())
      unsubscribe = typeof subscription === "function" ? (subscription as () => void) : undefined
    } catch {
      // イベントが使えない環境でもポーリングで更新する。
    }
    const timer = setInterval(() => void refresh(), 60_000)

    return () => {
      clearInterval(timer)
      unsubscribe?.()
    }
  },
})

interface LearnViewProps {
  snapshot: () => Snapshot | undefined
  detail: () => Detail | undefined
  selected: () => string | undefined
  busy: () => boolean
  error: () => string | undefined
  notice: () => string | undefined
  select: (id: string) => void
  approve: () => void
  reject: () => void
  refresh: () => void
  learn: () => void
  topic: () => string
  setTopic: (value: string) => void
  learnTopic: () => void
  skills: () => SkillsView | undefined
  loadSkills: () => void
  curate: (action: "archive" | "restore" | "pin" | "unpin", name: string) => void
  consolidate: () => void
  markdown: (text: string) => JSX.Element
}

function kindLabel(item: Proposal): string {
  if (item.archives?.length) return "整理"
  return item.kind === "patch" ? "既存を統合" : "新規作成"
}

function LearnView(props: LearnViewProps): JSX.Element {
  const pending = () => (props.snapshot()?.proposals ?? []).filter((item) => item.status === "pending")

  return (
    <div class="learn">
      <header class="learn-header">
        <h2>Skill 提案</h2>
        <div class="learn-actions">
          <button type="button" disabled={props.busy()} onClick={() => props.learn()}>
            このセッションから学ぶ
          </button>
          <button type="button" disabled={props.busy()} onClick={() => props.refresh()}>
            更新
          </button>
        </div>
      </header>

      <Show when={props.error()}>{(message) => <p class="learn-error">{message()}</p>}</Show>
      <Show when={props.notice()}>{(message) => <p class="learn-notice">{message()}</p>}</Show>
      <Show when={props.snapshot()?.corrupt}>
        <p class="learn-error">
          pending.json が壊れています。{props.snapshot()?.error} 書き込み系は停止しています。
        </p>
      </Show>

      <div class="learn-list">
        <For each={pending()} fallback={<p class="learn-empty">承認待ちの提案はありません。</p>}>
          {(item) => (
            <button
              type="button"
              class="learn-row"
              classList={{ "learn-row-active": props.selected() === item.id }}
              onClick={() => props.select(item.id)}
            >
              <span class="learn-kind">{kindLabel(item)}</span>
              <span class="learn-row-title">{item.title}</span>
              <span class="learn-row-name">{item.name}</span>
              <Show when={item.warnings.length > 0}>
                <span class="learn-warn">⚠ {item.warnings.length}</span>
              </Show>
            </button>
          )}
        </For>
      </div>

      <Show when={props.detail()?.proposal}>
        {(proposal) => (
          <section class="learn-detail">
            <h3>{proposal().title}</h3>
            <div class="learn-fields">
              <span class="learn-kind">{kindLabel(proposal())}</span>
              <code>{proposal().name}</code>
            </div>
            <h4>この提案の理由</h4>
            <p class="learn-reason">{proposal().reason}</p>
            <p class="learn-meta">{proposal().kind === "create" ? "新しい Skill として保存し、今後の作業で使います。" : "既存 Skill の手順を更新し、今後の作業に反映します。"}</p>

            <Show when={proposal().warnings.length > 0}>
              <ul class="learn-warnings">
                <For each={proposal().warnings}>{(warning) => <li>⚠ {warning}</li>}</For>
              </ul>
            </Show>

            <Show when={props.detail()?.targetChanged}>
              <p class="learn-warn">
                提案のあとに SKILL.md が変更されています。この提案は承認できません。却下して振り返り直してください。
              </p>
            </Show>

            <Show when={proposal().kind === "patch"} fallback={
              <>
                <h4>覚えておくこと</h4>
                <div class="learn-body">{props.markdown(proposal().body.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, ""))}</div>
              </>
            }>
              <h4>変更する箇所</h4>
              <Changes diff={proposal().diff} markdown={props.markdown} />
              <details class="learn-current">
                <summary>更新後の全文を読む</summary>
                <div class="learn-body">{props.markdown(proposal().body.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, ""))}</div>
              </details>
              <details class="learn-current">
                <summary>差分の原文を確認</summary>
                <pre class="learn-pre">{proposal().diff}</pre>
              </details>
            </Show>
            <details class="learn-current">
              <summary>保存するファイル全文を確認</summary>
              <pre class="learn-pre">{proposal().body}</pre>
            </details>

            <Show when={proposal().archives?.length}>
              <h4>まとめて片付ける Skill</h4>
              <p class="learn-note">承認すると、次の Skill をアーカイブへ移します（削除はしません）。提案のあとに変更された Skill は残します。</p>
              <ul class="learn-warnings">
                <For each={proposal().archives ?? []}>{(target) => <li><code>{target.name}</code></li>}</For>
              </ul>
            </Show>

            <Show when={proposal().files?.length}>
              <h4>一緒に作る補助ファイル</h4>
              <p class="learn-note">Skill のフォルダに新しく作ります。既存のファイルは上書きしません。</p>
              <For each={proposal().files ?? []}>
                {(file) => (
                  <details class="learn-current">
                    <summary><code>{file.path}</code></summary>
                    <pre class="learn-pre">{file.content}</pre>
                  </details>
                )}
              </For>
            </Show>

            <Show when={props.detail()?.readError}>
              {(message) => <p class="learn-error">{message()}</p>}
            </Show>

            <Show when={props.detail()?.current}>
              {(current) => (
                <details class="learn-current">
                  <summary>既存の SKILL.md（伏せ字済み）</summary>
                  <pre class="learn-pre">{current()}</pre>
                </details>
              )}
            </Show>

            <p class="learn-target">保存先<br /><code>{props.detail()?.targetPath?.replace(/^\/Users\/[^/]+\//, "~/")}</code></p>
            <div class="learn-actions">
              <button
                type="button"
                class="learn-approve"
                disabled={props.busy() || props.detail()?.targetChanged === true || props.detail()?.writable === false}
                onClick={() => props.approve()}
              >
                この内容を覚える
              </button>
              <button type="button" disabled={props.busy()} onClick={() => props.reject()}>
                覚えない
              </button>
            </div>
          </section>
        )}
      </Show>

      <section class="learn-section">
        <h3>指定した内容から学ぶ</h3>
        <p class="learn-note">URL、ファイルやフォルダのパス、手順の説明を書いてください。今の会話も参考にします。結果は承認待ちの提案になります。</p>
        <textarea
          value={props.topic()}
          placeholder="例: https://example.com/guide のデプロイ手順 / ./docs/release.md / 変更前に必ず typecheck を走らせる"
          onInput={(event) => props.setTopic(event.currentTarget.value)}
        />
        <div class="learn-actions">
          <button type="button" disabled={props.busy() || !props.topic().trim()} onClick={() => props.learnTopic()}>
            この内容から学ぶ
          </button>
        </div>
      </section>

      <section class="learn-section">
        <div class="learn-header">
          <h3>Skill の整理（使用状況）</h3>
          <button type="button" disabled={props.busy()} onClick={() => props.loadSkills()}>
            {props.skills() ? "再読み込み" : "表示"}
          </button>
        </div>
        <Show when={props.skills()}>
          {(view) => (
            <>
              <p class="learn-note">
                このプラグインで作った Skill だけが対象です。{view().staleDays} 日使われないと「しばらく未使用」、{view().archiveDays} 日で「アーカイブ候補」になります。アーカイブは削除ではなく、データ領域へ移すだけです。
              </p>
              <div class="learn-actions">
                <button type="button" disabled={props.busy()} onClick={() => props.consolidate()}>
                  似た Skill をまとめる案を作る
                </button>
              </div>
              <p class="learn-note">重なっている Skill を1つにまとめる案を、承認待ちの提案として作ります。承認するまで Skill は変わりません。</p>
              <Show when={view().error}>{(message) => <p class="learn-error">{message()}</p>}</Show>
              <For each={view().items} fallback={<p class="learn-empty">記録のある Skill はまだありません。</p>}>
                {(item) => <SkillRow item={item} busy={props.busy} curate={props.curate} />}
              </For>
            </>
          )}
        </Show>
      </section>

    </div>
  )
}

const STATUS_LABEL: Record<CuratorItem["status"], string> = {
  active: "使用中",
  stale: "しばらく未使用",
  "archive-candidate": "アーカイブ候補",
  archived: "アーカイブ済み",
}

function SkillRow(props: {
  item: CuratorItem
  busy: () => boolean
  curate: (action: "archive" | "restore" | "pin" | "unpin", name: string) => void
}): JSX.Element {
  const days = () => props.item.lastActivityAt ? Math.floor((Date.now() - props.item.lastActivityAt) / 86_400_000) : undefined
  return (
    <div class="learn-skill">
      <span class="learn-skill-name">
        <code>{props.item.name}</code>{" "}
        <span class={`learn-status-${props.item.status}`}>{STATUS_LABEL[props.item.status]}</span>
      </span>
      <span class="learn-actions">
        <Show when={props.item.status === "archived"}>
          <button type="button" disabled={props.busy()} onClick={() => props.curate("restore", props.item.name)}>復元</button>
        </Show>
        <Show when={props.item.managed && props.item.status !== "archived"}>
          <button type="button" disabled={props.busy()} onClick={() => props.curate(props.item.pinned ? "unpin" : "pin", props.item.name)}>
            {props.item.pinned ? "残す設定を解除" : "残す"}
          </button>
          <button type="button" disabled={props.busy()} onClick={() => props.curate("archive", props.item.name)}>アーカイブ</button>
        </Show>
      </span>
      <span class="learn-skill-meta">
        使用 {props.item.useCount} 回 / 更新 {props.item.patchCount} 回
        {props.item.reusedAfterPatch ? " / 更新後も使用あり" : ""}
        {days() !== undefined ? ` / 最終活動 ${days()} 日前` : ""}
        {props.item.managed ? " / このプラグインで作成" : " / 手作業の Skill（整理の対象外）"}
        {props.item.pinned ? " / 残す設定" : ""}
      </span>
    </div>
  )
}

function Changes(props: { diff: string; markdown: (text: string) => JSX.Element }): JSX.Element {
  const preview = createMemo(() => diffPreview(props.diff))
  return (
    <div class="learn-changes">
      <For each={preview().hunks} fallback={
        <p class="learn-note">変更箇所の差分がありません。更新後の全文と既存の SKILL.md を確認してください。</p>
      }>
        {(hunk, index) => (
          <section class="learn-hunk" aria-label={`変更箇所 ${index() + 1}`}>
            <p class="learn-hunk-title">変更箇所 {index() + 1}</p>
            <For each={hunk.blocks}>
              {(block) => (
                <div class={`learn-diff-block learn-diff-${block.kind}`}>
                  <span class="learn-diff-label">
                    {block.kind === "add" ? "＋ 追加する内容" : block.kind === "remove" ? "− 削除する内容" : "前後の文脈（変更なし）"}
                  </span>
                  <Show when={block.text.trim()} fallback={<span class="learn-diff-text">空行</span>}>
                    {props.markdown(block.text)}
                  </Show>
                </div>
              )}
            </For>
          </section>
        )}
      </For>
      <Show when={preview().truncated}>
        <p class="learn-note">差分の続きは省略されています。更新後の全文も確認してください。</p>
      </Show>
    </div>
  )
}
