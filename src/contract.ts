import { Rpc } from "@opencode/plugin/rpc"

/** Skill への提案の種類。create は新規、patch は既存 Skill への統合。 */
export type ProposalKind = "create" | "patch"
export type ProposalStatus = "pending" | "approved" | "rejected"

/**
 * 承認待ちの提案。id は `${kind}:${name}` で固定し、同じ Skill への提案を 1 件にまとめる。
 *
 * patch の body は「既存本文と教訓を統合した完成形の全文」。
 * 既存本文に秘密情報があれば [[LEARN_KEEP_n]] のプレースホルダに置き換えてあり、
 * 原文そのものは pending.json にもモデルにも残らない。
 * 承認時は baseHash で同一性を確認した元ファイルから原文断片を復元して書き込む。
 * section は統合に使った教訓、create の body は新規 SKILL.md の全文。
 */
export interface Proposal {
  id: string
  kind: ProposalKind
  name: string
  title: string
  reason: string
  body: string
  diff: string
  warnings: string[]
  sourceSessionID: string
  sourceTitle: string
  createdAt: number
  updatedAt: number
  status: ProposalStatus
  resolvedAt?: number
  /** patch のとき、統合に使う教訓の節。 */
  section?: string
  /** patch のとき、提案時点の既存 SKILL.md のハッシュ。 */
  baseHash?: string
  /** patch のとき、完成形に含まれるプレースホルダの個数。 */
  secretCount?: number
  /** 列挙で判明した実際の書き込み先。name から組み立て直さない。 */
  targetPath?: string
}

export interface Snapshot {
  proposals: Proposal[]
  maxPending: number
  generatedAt: number
  /** pending.json が壊れている。このとき書き込み系はすべて停止する。 */
  corrupt?: boolean
  error?: string
}

export interface Detail {
  found: boolean
  proposal?: Proposal
  /** 既存 SKILL.md の伏せ字済み抜粋。全文検査を通したものだけを返す。 */
  current?: string
  targetPath?: string
  /** ENOENT 以外の読み取り失敗。空白にせず画面へ出す。 */
  readError?: string
  /** 書き込み先として適切か（シンボリックリンク等でないか）。 */
  writable?: boolean
  /** 提案時点からターゲットが変わっている。承認は拒否される。 */
  targetChanged?: boolean
  /** 表示した提案の内容ハッシュ。承認・却下時に一致を確認する。 */
  revision?: string
}

/** 承認書き込みが失敗した段階。GUI で理由を分類して表示する。 */
export type ApproveFailureStage =
  | "revision"
  | "target"
  | "restore"
  | "backup"
  | "write"
  | "store"

export interface ApproveResult {
  ok: boolean
  reason?: string
  targetPath?: string
  backupPath?: string
  failedAt?: ApproveFailureStage
}

export interface RejectResult {
  ok: boolean
  reason?: string
}

export interface LearnResult {
  ok: boolean
  reason?: string
  proposals: number
}

const proposal = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: ["create", "patch"] },
    name: { type: "string" },
    title: { type: "string" },
    reason: { type: "string" },
    body: { type: "string" },
    diff: { type: "string" },
    warnings: { type: "array", items: { type: "string" } },
    sourceSessionID: { type: "string" },
    sourceTitle: { type: "string" },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    status: { type: "string", enum: ["pending", "approved", "rejected"] },
    resolvedAt: { type: "number" },
    section: { type: "string" },
    baseHash: { type: "string" },
    secretCount: { type: "number" },
    targetPath: { type: "string" },
  },
  required: [
    "id",
    "kind",
    "name",
    "title",
    "reason",
    "body",
    "diff",
    "warnings",
    "sourceSessionID",
    "sourceTitle",
    "createdAt",
    "updatedAt",
    "status",
  ],
  additionalProperties: false,
} as const

const idInput = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
} as const

/** 却下は、画面に表示した版と同じ内容に対してだけ許可する。 */
const rejectInput = {
  type: "object",
  properties: { id: { type: "string" }, revision: { type: "string" } },
  required: ["id", "revision"],
  additionalProperties: false,
} as const

/** 承認は、表示した提案の revision と baseHash の両方が一致するときだけ許可する。 */
const approveInput = {
  type: "object",
  properties: {
    id: { type: "string" },
    revision: { type: "string" },
    baseHash: { type: "string" },
  },
  required: ["id", "revision", "baseHash"],
  additionalProperties: false,
} as const

/** server 部と GUI 部の契約。GUI バンドルにも入るため、Node 依存を持たせない。 */
export const Learn = Rpc.define({
  id: "opencode-skill-learn",
  methods: {
    list: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          proposals: { type: "array", items: proposal },
          maxPending: { type: "number" },
          generatedAt: { type: "number" },
          corrupt: { type: "boolean" },
          error: { type: "string" },
        },
        required: ["proposals", "maxPending", "generatedAt"],
        additionalProperties: false,
      },
    },
    detail: {
      input: idInput,
      output: {
        type: "object",
        properties: {
          found: { type: "boolean" },
          proposal: proposal,
          current: { type: "string" },
          targetPath: { type: "string" },
          readError: { type: "string" },
          writable: { type: "boolean" },
          targetChanged: { type: "boolean" },
          revision: { type: "string" },
        },
        required: ["found"],
        additionalProperties: false,
      },
    },
    approve: {
      input: approveInput,
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          reason: { type: "string" },
          targetPath: { type: "string" },
          backupPath: { type: "string" },
          failedAt: {
            type: "string",
            enum: ["revision", "target", "restore", "backup", "write", "store"],
          },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    reject: {
      input: rejectInput,
      output: {
        type: "object",
        properties: { ok: { type: "boolean" }, reason: { type: "string" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    /** 手動の /learn 相当。sessionID を省略すると直近のセッションを対象にする。 */
    learn: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          reason: { type: "string" },
          proposals: { type: "number" },
        },
        required: ["ok", "proposals"],
        additionalProperties: false,
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: { count: { type: "number" } },
        required: ["count"],
        additionalProperties: false,
      },
    },
  },
})
