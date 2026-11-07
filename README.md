> AISlop-Inc npm package: `@aislop-inc/opencode-skill-learn`.
> Manual release instructions: [npm publishing](docs/NPM-PUBLISHING.md).

# opencode-skill-learn

OpenCode v2.2.5（OpenCode 2 / Desktop）向けの Learn Plugin。

既存 Skill への変更は、**提案段階で既存本文と教訓をモデルに渡し、意味の重複を整理しつつ既存の節・文章を最小限編集した「統合済み完成形の全文」を作る**方式です。
既存全行の完全保存は要求せず、書き換えを禁止しません。frontmatter と無関係の内容は保持します。
GUI に実際の差分と統合済み全文を示し、**表示した `revision` と `baseHash` が一致した承認時だけ**バックアップ付きで反映します。
承認時にモデルは再実行せず、承認済みの完成形をそのまま書き込みます。

## Hermes の調査と採用方針

外部資料と現行ソースを確認した（現行コミット `c55af2c93b9d61f5db7943fbc5ff50553038171f`）。

| 資料 | 実際の状態 | 判断 |
| --- | --- | --- |
| [PR #38199](https://github.com/NousResearch/hermes-agent/pull/38199) | **merged**（2026-06-10） | 保留レコードと承認時の再実行を参考にした |
| [PR #96059](https://github.com/NousResearch/hermes-agent/pull/96059) | **closed / unmerged** | 現行採用と断定しない。stale 検証は独自に実装 |
| [Issue #98330](https://github.com/NousResearch/hermes-agent/issues/98330) | **closed / completed** | Desktop の確認導線が無いというバグ報告。ComposerPill + Panel で用意 |

真似しないようにした失敗モードは、false staging success、stale full rewrite、misleading preview、exactly-once でない消費、背景提案が黙って溜まる挙動。
特に misleading preview を避けるため、**表示した統合済み全文をそのまま承認・書き込みに使い、承認時に作り直しません**。

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `src/contract.ts` | RPC 定義と server / GUI 共通の型。Node 依存なし |
| `src/server.ts` | イベント購読、振り返りの起動、RPC 実装 |
| `src/review.ts` | 振り返りプロンプト、構造化出力のパース、名前の正規化 |
| `src/compose.ts` | **統合プロンプトと出力検証**。意味の重複整理・最小限編集をモデルに要求する |
| `src/prepare.ts` | 既存本文をマスクしてモデルへ渡し、統合済み全文・実際の差分・節・baseHash・実パスを作る |
| `src/redact.ts` | 秘密情報の伏せ字、可逆プレースホルダ `maskSecrets` / `restoreMasked` |
| `src/diff.ts` | `textDiff`。複数箇所の編集を含む実際の差分（行数上限なし） |
| `src/skills.ts` | 既存 Skill の列挙と `resolveSkillPath`（別名フォルダ・曖昧性対応） |
| `src/transcript.ts` | 会話から最小限の材料だけを抜き出す |
| `src/lint.ts` | 「ログではなく教訓」のためのリンター |
| `src/fs.ts` | ENOENT と他の読み取りエラーの分離、symlink 判定、親ディレクトリ検証 |
| `src/lock.ts` | pending.json の協調ロック（小規模） |
| `src/store.ts` | pending.json の読み書き、承認時の復元と反映、却下 |
| `src/gui.tsx` | ComposerPill / Panel / Command / MenuItem / Style |
| `dist/gui-experimental.cjs` | ビルド済み GUI バンドル |
| `test/*.test.ts` | bun test の回帰・統合テスト |

旧統合コード（`integrate.ts` / `merge.ts` / `lineDiff` / `insertionDiff` とそのテスト）は削除済みです。

## 動作の流れ

1. `session.status`（idle）と `session.idle` を購読する。ツール呼び出しごとには発火しない。
2. `reviewed` / `inFlight` / `attempts` で 1 セッション 1 回だけ振り返る。短いセッションは見送る。
3. 振り返りは `ctx.experimental.generate.text` で 1 回だけ。
4. モデルへ渡すのは伏せ字済みの Skill 名・description・pending 要約・会話だけ。
5. `prepareActions` が `resolveSkillPath` で**列挙済みの実際の SKILL.md パス**を引く。
   frontmatter の `name` とフォルダ名が違っても正しく解決し、同名で候補が複数あれば誤選択せず提案を捨てる。
6. 既存本文を `maskSecrets` で秘密情報を `[[LEARN_KEEP_n]]` に置き換えてから `compose.ts` のプロンプトへ渡す。
   モデルには frontmatter の完全一致、プレースホルダの保全、意味の重複整理、既存文の最小限編集、無関係な内容の保持を要求する。
7. `validateComposedText` は frontmatter の完全一致、プレースホルダの個数、無関係な内容の大幅欠落を検証する。
   **既存全行の完全保存は要求しない**。失敗した提案は `dropped` となり、pending にも SKILL.md にも残らない。
8. pending に置くのは統合済み完成形（`body`）、実際の差分（`diff`）、教訓（`section`）、`baseHash`、`secretCount`、実 `targetPath`。
   秘密情報の原文は pending.json にもモデルにも残らない。
9. GUI は「実際の差分」「追加する教訓」「統合済み全文」「既存の SKILL.md（伏せ字済み）」を表示する。
10. 「承認して書き込む」は `approve({ id, revision, baseHash })` を呼ぶ。server は次を順に実行する。
    - 表示した `revision` と `baseHash` が両方一致するか。
    - 承認時点のターゲットを読み直し、ハッシュが `baseHash` と一致するか。create の非存在・SKILL.md の symlink・親パスも検証する。
    - `baseHash` で同一性を確認した元ファイルから `maskSecrets` で原文断片を取り出し、`restoreMasked` で完成形を復元する。
    - 既存ファイルを 0600 でバックアップし、書き込み直前にターゲットを再確認する。
    - status を先に確定してから temp + rename で反映する。失敗時は pending へ戻す。
    - 失敗段階を `failedAt`（`revision` / `target` / `restore` / `backup` / `write` / `store`）で返す。

## 秘密情報の扱い（最小の実用的な設計）

- モデル入力には既存の `redactSecrets` と同じ規則を使う `maskSecrets` を適用する。
- 完成形・pending・GUI 表示はプレースホルダ付きの**同じ本文**を共有する。表示と承認内容は一致する。
- 承認時は `baseHash` で同一性を確認した元ファイルから原文断片を復元して書き込む。
  原文の秘密情報は壊さず、別の場所へも増やさない（バックアップはユーザー専用領域に 0600）。
- つまり表示と書き込みの差は秘密情報の断片だけであり、その断片は元ファイルから無損失で戻される。
  それ以外の内容は表示した完成形とバイト単位で一致する。
- プレースホルダの欠落・重複・個数不一致を検知した場合は `failedAt: "restore"` で書き込みを止める。

## 安全性と限界

- create は同名 Skill を上書きしない。patch は `baseHash` 不一致を拒否する。
- SKILL.md 本体が symlink なら書き込みを拒否する。親ディレクトリの symlink は既存 skills の通常構成なので許容する。
- ENOENT 以外の読み取りエラーは `readError` として画面へ出す。
- 意味の重複判定はモデル判断と行の部分一致による検証です。言い回しが違う重複は検出しきれない可能性があります。
- 統合位置・編集量はモデル依存です。検証で大幅な欠落は弾きますが、最適な編集を保証するものではありません。
- ロックは協調的です。ロックを無視する外部の非協調プロセス、手動編集、複数サーバーインスタンスを完全には制御できません。
  書き込み直前の再確認と temp + rename を使いますが、**完全な原子性は保証できません**。
- `status` 確定と書き込みは別操作です。途中でプロセスが落ちた場合の回復は手動です。
- これらを理由に機能全体は停止していません。

## 確認できたこと

- 型チェック `tsc --noEmit` 通過。
- テスト **84 pass / 0 fail**（10 ファイル、282 アサーション）。前回報告の 75 pass とは別の結果です。
- **実モデルで一時 Skill の提案生成から RPC 承認まで確認しました。**
  `opencode api post /api/experimental/generate/text` を実際に呼び、別名フォルダの temp Skill に対して
  モデルが既存文を最小限編集して教訓を織り込んだ完成形を生成しました。
  RPC の `detail` → `approve` を通し、承認済み完成形と書き込み内容の一致、frontmatter 保持、
  無関係な内容の保持、バックアップ一致、status `approved` を確認しました（`RESULT: OK`）。
  検証は `/private/var/folders/.../T/opencode/` の一時ディレクトリのみで行い、ユーザーの実 Skill は書き換えていません。
- 回帰テストで、意味の重複整理と既存文修正、frontmatter 保持、別名フォルダ・symlink の実パス解決、
  同名曖昧性の誤選択防止、承認済み内容の一致、revision / baseHash / ターゲット変更の競合、
  秘密情報の復元と `restore` 失敗、提案途中の失敗で書き込まないことを実処理で検証しました。
- ビルド `vite build` 通過。GUI バンドルに `approve({ id, revision, baseHash })` が含まれる。
- `~/.config/opencode/opencode.json` は編集していません。プラグインは有効な状態ですが、この作業では触れていません。

## 未確認

- **OpenCode Desktop の GUI 実画面は未確認です。**
  ComposerPill、Panel、差分と統合済み全文の見え方、ボタン操作を目視していません。
- 実モデル検証は 1 回の成功例です。複数モデル・複雑な既存 Skill での安定性は未検証です。
- 外部の非協調プロセスが同時に同じ SKILL.md を書いた場合の挙動は再現していません。

## 開発コマンド

```sh
/Users/mattyatea/.local/share/mise/installs/bun/1.4.4/bin/bun run typecheck
/Users/mattyatea/.local/share/mise/installs/bun/1.4.4/bin/bun run test
/Users/mattyatea/.local/share/mise/installs/bun/1.4.4/bin/bun run build
```

## npm installation

After the first npm publication, add this entry to the existing OpenCode plugins array:

```json
{"plugins": ["@aislop-inc/opencode-skill-learn@latest"]}
```

Do not add it alongside a local copy of the same plugin.
