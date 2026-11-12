> AISlop-Inc npm package: `@aislop-inc/opencode-skill-learn`.
> Manual release instructions: [npm publishing](docs/NPM-PUBLISHING.md).

# opencode-skill-learn

OpenCode v2.2.5（OpenCode 2 / Desktop）向けの Learn Plugin。

既存 Skill への変更は、**提案段階で既存本文と教訓をモデルに渡し、意味の重複を整理しつつ既存の節・文章を最小限編集した「統合済み完成形の全文」を作る**方式です。
既存全行の完全保存は要求せず、書き換えを禁止しません。frontmatter と無関係の内容は保持します。
GUI に実際の差分と統合済み全文を示し、**表示した `revision` と `baseHash` が一致した承認時だけ**バックアップ付きで反映します。
承認時にモデルは再実行せず、承認済みの完成形をそのまま書き込みます。

## Hermes の調査と採用方針

現行ソースを再確認した（`main` の `ca4360692055bdb4df3a695c164646e528891da8`）。
参照した判断基準は [background_review.py の学習方針](https://github.com/NousResearch/hermes-agent/blob/ca4360692055bdb4df3a695c164646e528891da8/agent/background_review.py#L401-L526)。
ユーザーの訂正、有効だった非自明な手順、既存Skillの不足を学習差分として拾い、既存の作業分野Skillへの更新を新規作成より優先する。
回数はレビュー開始の目安であり、学習価値や難易度そのものとは扱わない。
未解決の試行、一時的な環境エラー、すでに常時読み込まれているルールを恒久的な新規Skillにしない。
候補を作った後に関連Skillの本文も読んで品質確認し、同じ目的の候補をまとめる。
意味的な重複の判断はモデルによるもので、完全な保証ではない。

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
| `src/activity.ts` | 学習の実行・見送り・失敗を直近50件、`activity.json` に保存 |
| `src/review.ts` | 振り返りプロンプト、構造化出力のパース、名前の正規化 |
| `src/compose.ts` | **統合プロンプトと出力検証**。意味の重複整理・最小限編集をモデルに要求する |
| `src/curate.ts` | 候補・保留提案の本文と関連Skill本文を比較し、粒度・根拠・重複を再点検する |
| `src/prepare.ts` | 既存本文をマスクしてモデルへ渡し、統合済み全文・実際の差分・節・baseHash・実パスを作る |
| `src/redact.ts` | 秘密情報の伏せ字、可逆プレースホルダ `maskSecrets` / `restoreMasked` |
| `src/diff.ts` | `textDiff`。複数箇所の編集を含む実際の差分（行数上限なし） |
| `src/skills.ts` | 既存 Skill の列挙と `resolveSkillPath`（別名フォルダ・曖昧性対応） |
| `src/transcript.ts` | チェックポイント以降を原文、それ以前を要約にした会話材料、ツール反復数、失敗→成功の経緯を作る |
| `src/state.ts` | セッションごとのチェックポイント・振り返り回数・失敗回数を `state.json` に保存 |
| `src/model.ts` | `reviewModel` / `composeModel` の指定（`"provider/model#variant"` など）を読む |
| `src/sources.ts` | `/learn` に渡された URL・ファイル・フォルダから資料を集める（秘密情報らしいファイルは読まない） |
| `src/usage.ts` | Skill の利用統計（`usage.json`）、Curator の判定、アーカイブと復元 |
| `src/lint.ts` | 「ログではなく教訓」のためのリンター |
| `src/fs.ts` | ENOENT と他の読み取りエラーの分離、symlink 判定、親ディレクトリ検証 |
| `src/lock.ts` | pending.json の協調ロック（小規模） |
| `src/store.ts` | pending.json の読み書き、承認時の復元と反映、却下 |
| `src/gui.tsx` | ComposerPill / Panel / Command / MenuItem / Style |
| `dist/gui-experimental.cjs` | ビルド済み GUI バンドル |
| `test/*.test.ts` | bun test の回帰・統合テスト |

旧統合コード（`integrate.ts` / `merge.ts` / `lineDiff` / `insertionDiff` とそのテスト）は削除済みです。

## 動作の流れ

1. V2 の `session.execution.succeeded` と `session.skill.activated` を購読する。
   旧来の `session.status` / `session.idle` は自動起動には使わない。
2. `state.json` のチェックポイント以降だけを数え、`inFlight` と失敗回数で重複実行を防ぐ。
   振り返りが成功したらチェックポイントを最後のメッセージへ進める。
3. 振り返りは `ctx.experimental.generate.text` を使う。
   `reviewModel` を指定すればそのモデルで、未指定なら OpenCode の既定モデルで実行する。
   候補がある場合だけ品質確認を追加し、既存Skillへの統合が必要なら完成形の生成も行う。
4. モデルへ渡すのは伏せ字済みの Skill 名・description・pending 要約・会話だけ。
5. `prepareActions` が `resolveSkillPath` で**列挙済みの実際の SKILL.md パス**を引く。
   frontmatter の `name` とフォルダ名が違っても正しく解決し、同名で候補が複数あれば誤選択せず提案を捨てる。
6. 既存本文を `maskSecrets` で秘密情報を `[[LEARN_KEEP_n]]` に置き換えてから `compose.ts` のプロンプトへ渡す。
   モデルには frontmatter の完全一致、プレースホルダの保全、意味の重複整理、既存文の最小限編集、無関係な内容の保持を要求する。
7. `validateComposedText` は frontmatter の完全一致、プレースホルダの個数、無関係な内容の大幅欠落を検証する。
   **既存全行の完全保存は要求しない**。失敗した提案は `dropped` となり、pending にも SKILL.md にも残らない。
8. pending に置くのは統合済み完成形（`body`）、実際の差分（`diff`）、教訓（`section`）、`baseHash`、`secretCount`、実 `targetPath`。
   秘密情報の原文は pending.json にもモデルにも残らない。
9. GUI は提案理由と「覚えておくこと／更新後の内容」を Markdown で読みやすく表示する。
   差分・保存するファイル全文・既存本文は折りたたみで確認できる。
10. 「この内容を覚える」は `approve({ id, revision, baseHash })` を呼ぶ。server は次を順に実行する。
    - 表示した `revision` と `baseHash` が両方一致するか。
    - 承認時点のターゲットを読み直し、ハッシュが `baseHash` と一致するか。create の非存在・SKILL.md の symlink・親パスも検証する。
    - `baseHash` で同一性を確認した元ファイルから `maskSecrets` で原文断片を取り出し、`restoreMasked` で完成形を復元する。
    - 既存ファイルを 0600 でバックアップし、書き込み直前にターゲットを再確認する。
    - status を先に確定してから temp + rename で反映する。失敗時は pending へ戻す。
    - 失敗段階を `failedAt`（`revision` / `target` / `restore` / `backup` / `write` / `store`）で返す。

## 自動学習の判定と状態確認

- Hermes の `creation_nudge_interval` と同じく、**前回の振り返り以降のツール反復**が `reviewInterval`（既定10回）に達したら振り返る。
  ツール反復は「ツールを1つ以上呼んだ assistant ステップ」の数で、1ステップ内の並列呼び出しは1回と数える。
  短い作業が続いても反復は累積するので、何度目かの完了で閾値に届く。
  閾値前の見送りは学習ログに残さない（完了のたびにログが増えないようにするため）。
- ユーザーの訂正があり、ツールを1回以上使っていれば、閾値前でも振り返る（このプラグイン独自の拡張）。
  ツールが失敗しただけで価値のある教訓だとは判断しない。
- チェックポイントは `state.json` に保存するため、OpenCode を再起動しても同じ区間を読み直さない。
  会話の圧縮などでチェックポイントのメッセージが消えた場合は、会話全体を対象にする。
- モデルへ渡す会話は3つに分ける。
  - 振り返り済みの古い会話は、発言の抜粋とツール名・失敗数だけの要約にする。
  - チェックポイント直前の数件（`contextOverlap`、既定6件）は「振り返り済みの文脈」として原文で渡す。ここから新しい教訓は作らない。
  - チェックポイント以降を「今回の振り返り対象」として原文で渡す。予算（`contextBudget`、既定24,000文字）の約8割を割り当て、入りきらない古い部分は要約へ回す。
- 失敗から学ぶため、ツールのエラー内容と、シェルの成功結果・一度失敗したツールの成功結果を短く残す。
  「失敗→何ステップ後に成功」「未解決の失敗」の一覧もモデルへ渡す。
  未解決の失敗は成功手順として扱わないようプロンプトで指示している。
- 学習価値はモデルが会話を読んで判定する。
  読み取り中心の調査でも新しい知見があれば候補にでき、長い作業でも新しい教訓がなければ提案しない。
  本文の日本語・英語はどちらも許容する。
- 補助セッションの完了だけで細かなSkillを次々に作らず、親タスク側でまとめて振り返る。
- 提案の保存IDと表示はセッション単位。
  既存データの補助セッション由来の提案も、その親タスクへ関連付けて表示する。
  別タスクの提案を混ぜず、全セッション共用の保留件数上限は設けない。
- 見送りでは失敗の再試行枠を消費しない。
  生成の失敗は同じ材料で `maxAttempts`（既定3回）まで自動再試行し、回数は `state.json` に残す。
  新しい会話が増えて材料が変われば数え直す。
  手動学習は閾値を省略し、新しい会話がなければセッション全体を振り返る。
- `~/.local/share/opencode-skill-learn/activity.json` に日時・セッションID・自動／手動・結果・理由を直近50件保存する。
  会話やモデル入力は記録しない。
  学習状況・失敗履歴・解決済み件数は提案画面には表示しない。
  入力欄の表示は、現在のタスクに承認待ちの提案があるときと、学習の実行中（「Skill を学習中…」）だけ出す。
  「実行開始」は開始記録であり、プロセスの生存確認ではない。
- 却下履歴を `pending.json` に保持し、振り返りモデルにも渡す。
  同名の新規Skillと、同じ既存Skillへの同じ教訓（空白・記号の違いは無視）は保存時にも止める。
  別の教訓で提案が更新されても、以前の却下履歴は残る。
  意味が同じでも名前や文章を大きく変えた提案の抑止はモデル判断に依存する。
- セッション別表示・却下履歴の保持は、このプラグイン独自の要件。
  Hermes の現行の却下処理は保留レコードの削除であり、同様の再提案防止が実装されているとは扱わない。

## 設定項目

`opencode.json` のプラグイン設定で指定する。
すべて省略でき、省略時は下の既定値を使う。

| 項目 | 既定値 | 内容 |
| --- | --- | --- |
| `reviewInterval` | `10` | 自動で振り返るツール反復の回数（Hermes の既定値と同じ） |
| `reviewModel` | OpenCode の既定モデル | 振り返りと品質確認に使うモデル。`"provider/model"`、`"provider/model#variant"`、`{ "providerID", "id", "variant" }` のどれか |
| `composeModel` | `reviewModel` | 既存 Skill への統合全文を作るモデル |
| `contextBudget` | `24000` | モデルへ渡す会話の文字数の上限 |
| `contextOverlap` | `6` | 今回の対象の直前に、文脈として原文で渡すメッセージ数（`0` で無効） |
| `maxAttempts` | `3` | 同じ材料で生成に失敗したときの自動再試行の上限 |
| `staleDays` | `14` | 作成した Skill を「しばらく未使用」にする日数 |
| `archiveDays` | `30` | 作成した Skill を「アーカイブ候補」にする日数 |
| `command` | `"learn"` | スラッシュコマンドの名前。`false` で登録しない |
| `dataDir` / `skillsDir` | `~/.local/share/opencode-skill-learn` / `~/.config/opencode/skills` | データの保存先と Skill の場所 |

以前の `minToolCalls` は `reviewInterval` に置き換えた。

## `/learn` で指定した内容から学ぶ

Hermes の `/learn <内容>` に合わせたスラッシュコマンド。

- `/learn` だけなら、今のセッションを閾値なしで振り返る。
- `/learn <内容>` なら、書いた内容から Skill を提案する。
  - URL（最大5件。HTML は本文だけを取り出す。15秒で打ち切る）
  - ファイル（`~/`、絶対パス、セッションの作業フォルダからの `./` 相対パス）
  - フォルダ（2階層・150件までの構成と、README・AGENTS.md・package.json などの主要ファイル）
  - 手順の説明だけの文章
- `.env`、`*.pem`、`credentials.json` など秘密情報を含みやすいファイルは読まない。
  読まなかった資料と取得に失敗した資料は、学習ログの理由に残す。
- 依頼文はユーザー本人の指示として扱い、取得した資料と会話は信頼しない入力として扱う（資料の中の指示には従わない）。
- 結果は他の提案と同じく承認待ちになり、Skill は書き換えない。
  コマンドは会話に何も書き込まず、入力欄の上の表示で進み具合と結果を知らせる。
- 提案画面の「指定した内容から学ぶ」欄からも同じことができる。

## Skill の利用統計と整理（Curator）

- `session.skill.activated` を受けるたびに、Skill ごとの使用回数と最終使用日時を `usage.json` に記録する。
  承認で書き込んだときは更新回数と更新世代を記録し、更新後に使われたかも分かるようにする。
  本文や会話は保存しない。
- **このプラグインの承認で作成した Skill だけ**を整理の対象にする。
  最後の使用・更新・作成から `staleDays` 日で「しばらく未使用」、`archiveDays` 日で「アーカイブ候補」と表示する。
  手作業の Skill と「残す」に設定した Skill は候補にしない。
- 判定は表示だけで、移動は自動で行わない。
  提案画面の「Skill の整理（使用状況）」欄、またはコマンド「Skill を整理」から、ユーザーがボタンを押したときだけアーカイブ・復元・残す設定を行う。
- アーカイブは削除ではない。
  Skill のフォルダを `<dataDir>/archive/<名前>-<日時>` へ移し、「復元」で元の場所へ戻せる。
  skills フォルダ直下の実フォルダだけを移し、シンボリックリンクや入れ子のフォルダは移さない。
  元の場所に同名のフォルダがあれば復元しない。

### 似た Skill をまとめる（Curator の第2段階）

Hermes の Curator がモデルで行う統合に当たる。
ただし自動では動かさず、**まとめる案を承認待ちの提案として作るだけ**にした。

1. 「Skill の整理」欄の「似た Skill をまとめる案を作る」を押すと、RPC `consolidate` が動く。
2. 対象は、このプラグインで作った、アーカイブしていない、シンボリックリンクでない Skill。
   本文に秘密情報らしい文字列がある Skill は、原文を壊さないため対象から外す。
   対象が2つ未満なら、モデルを呼ばずに見送る。
3. 振り返り用のモデル（`reviewModel`）に、対象の Skill の本文と使用状況を渡す。
   手作業の Skill は名前と説明だけを参考として渡し、まとめ先にもアーカイブ対象にもしない。
4. モデルは「まとめ先（`name`）」と「まとめられる Skill（`absorb`）」を返す。
   サーバー側で、`absorb` を対象の Skill だけに絞る。
   「残す」設定の Skill、まとめ先自身、別の案ですでに使った Skill は外す。
5. まとめ先への追記は、通常の提案と同じく統合済み全文（`composeModel`）にする。
   まとめられる Skill の名前と、その時点の SKILL.md のハッシュを `archives` として提案に付ける。
   提案は特定のセッションに属さない（`sourceSessionID: "curator"`）。どのセッションの提案画面にも出る。
6. 承認すると、まず通常の承認と同じ検査をしてまとめ先の SKILL.md を書く。
   その後、まとめられる Skill を1つずつ確かめてアーカイブへ移す（削除はしない）。
   次の場合は移さず、理由を `archiveErrors` で返す。
   - このプラグインで作った Skill でない、すでにアーカイブ済み、「残す」設定になっている。
   - 提案のあとに SKILL.md が変更された（ハッシュが一致しない）。
   - 場所を一意に決められない。
   まとめ先の書き込みは成功しているので、承認自体は成功として扱う。
   アーカイブした Skill は、これまでどおり「復元」で戻せる。

## 補助ファイル（references/・templates/）

Hermes の Skill は SKILL.md のほかに補助ファイルを持てる。
このプラグインでは、**実行されないテキストファイルだけ**を扱う。

- 置ける場所は `references/` と `templates/` の直下だけ。入れ子のフォルダ、`..`、絶対パスは通さない。
- 拡張子は `md`・`txt`・`json`・`yaml`/`yml`・`toml`・`csv`。
- 1つの提案につき最大3件、1件あたり20,000文字まで。中身は秘密情報を伏せてから保存する。
- `scripts/` のような実行するファイルは作らない。
- **新しく作るファイルだけ**を扱い、既存の補助ファイルは書き換えない。
  - 提案を作る時点ですでにあるファイルは、提案から外し、警告に出す。
  - 承認時にもう一度確かめる。ファイルができていたら何も書かずに止める（`failedAt: "target"`）。
  - `references/`・`templates/` がシンボリックリンクや通常のフォルダでなければ書き込まない。
- 承認時は補助ファイルを先に作り（既存ファイルを上書きしない `wx` で開く）、最後に SKILL.md を書く。
  途中で失敗したら、作ったファイルとフォルダを消して pending に戻す。
- 補助ファイルの内容は提案の版（`revision`）に含まれる。表示したあとに中身が変わった提案は承認できない。
- 提案画面では、補助ファイルごとにパスと全文を折りたたみで確認できる。

## 保存するファイル

| ファイル | 内容 |
| --- | --- |
| `pending.json` | 承認待ち・却下済みの提案（補助ファイルの中身と、まとめる案のアーカイブ対象を含む） |
| `activity.json` | 学習の実行記録（直近50件） |
| `state.json` | セッションごとのチェックポイント（最後に振り返ったメッセージ ID）、振り返り回数、失敗回数 |
| `usage.json` | Skill ごとの使用回数・更新回数・作成者・残す設定・アーカイブ先 |
| `archive/` | アーカイブした Skill のフォルダ |
| `backups/` | 承認時に書き換えた SKILL.md のバックアップ |

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
- Hermes 寄りへの変更後、`bun test ./test` で **132 pass / 0 fail**（変更前は114 pass）。3回続けて実行し、同じ結果だった。
  追加した主なテストは次のとおり。
  - チェックポイントが再起動後も残り、次は前回以降だけを対象にする。ツール反復が完了をまたいで累積する。
  - 訂正による早期の振り返り、失敗回数の `state.json` への保存と上限。
  - `reviewModel` が `generate.text` の `model` に渡る。モデル指定の読み取り。
  - 失敗→成功の経緯、エラー内容と成功結果の表示。
  - `/learn` の登録と実行、`command: false`、ファイル指定での学習と `.env` を読まないこと、URL とフォルダの資料収集。
  - 利用統計、Curator の判定（未使用・アーカイブ候補・残す設定・手作業の Skill を除外）、アーカイブと復元、シンボリックリンクと入れ子を移さないこと。
- 似た Skill のまとめと補助ファイルを追加したあと、**144 pass / 0 fail**。3回続けて実行し、同じ結果だった。
  追加したテストは次のとおり。
  - 補助ファイルのパス検査（`scripts/`・入れ子・`..`・絶対パスを通さない）、件数の上限、秘密情報を伏せること。
  - 既存の補助ファイルを提案から外して警告にすること。承認時に補助ファイルができていたら止めること。
  - `references/` がシンボリックリンクなら書かないこと。書き込みの途中で失敗したら作ったものを消して pending に戻すこと。
  - 補助ファイルが変わると版も変わること。
  - まとめる案の作成から承認まで（まとめ先の更新、まとめられた Skill のアーカイブ、「残す」設定と手作業の Skill を外すこと、どのセッションにも案が出ること）。
  - 案のあとにまとめられる Skill が変わったらアーカイブしないこと。対象が2つ未満ならモデルを呼ばないこと。
- 以下の実モデル確認は、Hermes 寄りへの変更**前**の実装で行ったもの。
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
- Hermes 寄りへの変更後は、実際の OpenCode 上で次を確認していません（テストはスタブの `ctx` で行った）。
  - `/learn` がスラッシュコマンドとして表示・実行されるか（`ctx.command.transform` の実動作）。
  - `session.skill.activated` が実際に届き、使用回数が増えるか。
  - `reviewModel` を指定した実モデルでの振り返り。
  - 「Skill を学習中…」表示、「指定した内容から学ぶ」欄、「Skill の整理」欄の見た目と操作。
- 似た Skill のまとめと補助ファイルは、実際の OpenCode と実モデルでは確認していません。
  - 実モデルが妥当なまとめ先と `absorb` を返すか、補助ファイルを必要なときだけ付けるか。
  - 提案画面の「整理」表示、補助ファイルとアーカイブ対象の見え方。

## 残作業（Hermes との差）

- Curator の第2段階は、承認を前提にした手動実行だけにした。Hermes のように定期的・自動的には実行しない。
- 補助ファイルは `references/`・`templates/` のテキストだけ。`scripts/` と、既存の補助ファイルの更新は扱わない。
- Hermes のメモリ（ユーザーの好みなど）への振り分けは行わない。Skill への教訓だけを扱う。

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
