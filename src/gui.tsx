import { createSignal, For, Show, type JSX } from "solid-js"
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
  type Detail,
  type LearnResult,
  type RejectResult,
  type Snapshot,
} from "./contract.ts"
import { errorMessage } from "./redact.ts"

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
.learn-note { margin: 0; color: var(--v2-text-text-warning, #c47b12); }
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
.learn-resolved { border-top: 1px solid var(--v2-background-bg-layer-01); padding-top: 8px; color: var(--v2-text-text-muted); font-size: 12px; }
`

export default Plugin.define({
  i18n: {
    en: {
      "panel.title": "Skill proposals",
      "command.open": "Review Skill proposals",
      "command.learn": "Learn from this session",
      "pill.label": "Skill proposals {count}",
      "pill.title": "Skill proposals awaiting approval",
      "pill.all": "Review all proposals",
      "menu.open": "Skill proposals",
    },
    ja: {
      "panel.title": "Skill 提案",
      "command.open": "Skill 提案を確認",
      "command.learn": "このセッションから学ぶ",
      "pill.label": "Skill提案 {count}件",
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
    const [notice, setNotice] = createSignal<string>()
    let refreshing = false

    const pending = () => (snapshot()?.proposals ?? []).filter((item) => item.status === "pending")

    const refresh = async () => {
      if (refreshing) return
      refreshing = true
      try {
        setSnapshot((await ctx.client.rpc(Learn).list({})) as Snapshot)
        setError()
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        refreshing = false
      }
    }

    const openPanel = () => {
      const session = ctx.sessions.current()
      if (session) ctx.layout.open(`${ctx.id}:review`, session, { tab: "select" })
      void refresh()
    }

    const openProposal = async (id: string) => {
      setSelected(id)
      setSelectedRevision(undefined)
      setSelectedBaseHash(undefined)
      setNotice()
      setBusy(true)
      try {
        const result = (await ctx.client.rpc(Learn).detail({ id })) as Detail
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
              (result.backupPath ? ` / バックアップ ${result.backupPath}` : ""),
          )
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
        setError(result.ok ? undefined : (result.reason ?? "学習に失敗しました"))
        await refresh()
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setBusy(false)
      }
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
          error={error}
          notice={notice}
          select={(id) => void openProposal(id)}
          approve={() => void approveProposal()}
          reject={() => void rejectProposal()}
          refresh={() => void refresh()}
          learn={() => void learnNow()}
        />
      ),
    })

    ctx.add(ComposerPill, {
      id: "proposals",
      show: (): ComposerPillView | undefined => {
        const items = pending()
        if (items.length === 0) return undefined
        return {
          label: ctx.t("pill.label").replace("{count}", String(items.length)),
          title: ctx.t("pill.title"),
          icon: "brain",
          tone: "warning",
          rows: [
            ...items.slice(0, 6).map((item) => ({
              id: item.id,
              label: `${item.kind === "patch" ? "更新" : "新規"} ${item.title}`,
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

    ctx.add(Style, css)

    void refresh()
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
}

function LearnView(props: LearnViewProps): JSX.Element {
  const pending = () => (props.snapshot()?.proposals ?? []).filter((item) => item.status === "pending")
  const resolved = () => (props.snapshot()?.proposals ?? []).filter((item) => item.status !== "pending")

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
      <p class="learn-note">
        承認すると表示した revision と baseHash が一致する場合だけ、この統合済み全文を反映します。
        [[LEARN_KEEP_n]] は原文の一部で、承認時に元ファイルから復元します。承認時にモデルは再実行しません。
        外部の非協調プロセスとの完全な原子性は保証されません。
      </p>
      <p class="learn-meta">
        保留 {pending().length} 件 / 上限 {props.snapshot()?.maxPending ?? "-"} 件
      </p>

      <div class="learn-list">
        <For each={pending()} fallback={<p class="learn-empty">承認待ちの提案はありません。</p>}>
          {(item) => (
            <button
              type="button"
              class="learn-row"
              classList={{ "learn-row-active": props.selected() === item.id }}
              onClick={() => props.select(item.id)}
            >
              <span class="learn-kind">{item.kind === "patch" ? "既存を統合" : "新規作成"}</span>
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
              <span class="learn-kind">{proposal().kind === "patch" ? "既存を統合" : "新規作成"}</span>
              <code>{proposal().name}</code>
            </div>
            <p class="learn-reason">{proposal().reason}</p>

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

            <h4>実際の差分</h4>
            <pre class="learn-pre">{proposal().diff || "（差分なし）"}</pre>

            <Show when={proposal().kind === "patch" && proposal().section}>
              {(section) => (
                <>
                  <h4>追加する教訓</h4>
                  <pre class="learn-pre">{section()}</pre>
                </>
              )}
            </Show>

            <h4>{proposal().kind === "patch" ? "統合済み全文（承認時に反映する完成形）" : "書き込む本文"}</h4>
            <pre class="learn-pre">{proposal().body}</pre>

            <Show when={props.detail()?.readError}>
              {(message) => <p class="learn-error">{message()}</p>}
            </Show>
            <Show when={props.detail()?.writable === false}>
              <p class="learn-warn">書き込み先がシンボリックリンク等のため、書き込みには適しません。</p>
            </Show>

            <Show when={props.detail()?.current}>
              {(current) => (
                <details class="learn-current">
                  <summary>既存の SKILL.md（伏せ字済み）</summary>
                  <pre class="learn-pre">{current()}</pre>
                </details>
              )}
            </Show>

            <p class="learn-target">{props.detail()?.targetPath}</p>
            <div class="learn-actions">
              <button
                type="button"
                class="learn-approve"
                disabled={props.busy() || props.detail()?.targetChanged === true || props.detail()?.writable === false}
                onClick={() => props.approve()}
              >
                承認して書き込む
              </button>
              <button type="button" disabled={props.busy()} onClick={() => props.reject()}>
                却下
              </button>
            </div>
          </section>
        )}
      </Show>

      <Show when={resolved().length > 0}>
        <div class="learn-resolved">解決済み {resolved().length} 件（承認・却下の記録）</div>
      </Show>
    </div>
  )
}
