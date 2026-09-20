# T3 Code / Codex App Server 統合 Handoff

最終更新: 2026-09-21 (Asia/Tokyo)

このファイルは、T3 Code の Codex App Server 統合を別の担当者が引き継ぐための実装・運用メモです。現在のコード、ライブサービス、既存の Codex セッション、過去に発生した問題、今後の検証ポイントをまとめています。

認証トークン、Pairing Token、秘密鍵、secrets.json の内容は記載していません。

## 1. 目的とユーザーが求めている状態

この作業の最終目的は、T3 Code の Codex 操作の根本を T3 独自のプロバイダーセッション管理から Codex App Server に寄せることです。

ユーザーの主な要求は次のとおりです。

- Codex CLI / Codex App Server が所有する既存スレッドを T3 Code からすべて表示できること。
- Codex 側で実行中のスレッドが T3 側でも実行中としてリアルタイムに同期されること。
- メッセージ、思考・reasoning、ツールコール、Agent/サブエージェント、Diff、承認要求などを既存の T3 クライアント表示へ正しく投影すること。
- T3 側のセッション管理、履歴コピー、通知ルーターを可能な限り減らし、Codex App Server をスレッド・ターン・履歴の権威にすること。
- Web、Desktop、Mobile のクライアント側を変更せず、サーバー側のパッチだけで既存機能との互換性を維持すること。
- 公式 T3 Nightly へ切り戻すのではなく、このフォークのパッチ版を実際の T3 サービスとして動かすこと。
- upstream に大きな変更を戻すことよりも、自分のフォークで実験・利用できることを優先すること。
- 実装や運用を行う各作業では Goal を設定すること。

重要な設計上の前提は、「T3 のセッションを完全にゼロにする」ではありません。既存クライアントとの互換性のため、T3 はスレッドのシェル、プロジェクト、Provider binding、live projection、UI 用の読み取りモデルを保持します。ただし、Codex の durable transcript、native thread ID、native turn、履歴、実行状態を T3 が二重管理しないことが目標です。

## 2. 現在のリポジトリ状態

### パスとブランチ

- リポジトリ: /run/media/nico/d/学校/app/t3code
- 現在のブランチ: experiment/codex-app-server
- origin: https://github.com/pingdotgg/t3code.git
- fork: https://github.com/nico2525nn/t3code.git
- origin/main の現在値: 82cd1d1aa
- origin/main は現在の HEAD の祖先になっている。
- Handoff 作成開始時点で Git 作業ツリーは clean。

### 直近の重要コミット

```text
f4e3a8d4d fix(server): reconcile Nightly schemas before Codex startup
0b1ef647c merge: sync origin/main into Codex App Server branch
82cd1d1aa origin/main: fix(mobile): preserve multiple model favorites (#12505)
```

f4e3a8d4d が、この Handoff 作成前のパッチ版サービスに含まれる最後のコードコミットです。

### 関連する既存ワークツリー

以前の整理作業で、複数のワークツリーが存在しています。現在の T3 サービスに使うべき場所はリポジトリ直下の /run/media/nico/d/学校/app/t3code だけです。

- 現在の Codex App Server 統合: /run/media/nico/d/学校/app/t3code
- OpenCode 2: /run/media/nico/d/学校/app/t3code-work-opencode2
- OpenCode 2 native: /run/media/nico/d/学校/app/t3code-work-opencode2-native
- Pi provider: /run/media/nico/d/学校/app/t3code-work-pi
- PR 7863: /run/media/nico/d/学校/app/t3code-work-pr7863

過去には experiment/codex-app-server が別のワークツリーで使用中というエラーが発生した。現在はこのリポジトリ直下のブランチが使用中であり、同じブランチを別ワークツリーへ checkout しようとしてはいけません。

### サービスが参照する成果物

ソースを変更しただけではライブサービスは更新されません。サーバーバンドルを再生成し、systemd サービスを再起動する必要があります。

```text
/run/media/nico/d/学校/app/t3code/apps/server/dist/bin.mjs
```

この dist は生成物です。ソース変更後に必ず次を実行します。

```bash
./node_modules/.bin/vp run --filter=t3 build:bundle
systemctl --user restart t3code.service
```

## 3. 現在のライブサービス

### systemd ユニット

ユニットファイル:

```text
/home/nico/.config/systemd/user/t3code.service
```

現在の重要部分は次の構成です。

```ini
[Service]
Type=simple
WorkingDirectory=%h
Environment=T3CODE_HOME=/home/nico/.t3
Environment=T3_BOOT_SERVICE_UNIT=t3code.service
ExecStart=/home/nico/.local/opt/node-v22.23.2-linux-x64/bin/node /run/media/nico/d/学校/app/t3code/apps/server/dist/bin.mjs serve --base-dir /home/nico/.t3 --port 3773 --host 127.0.0.1 --no-browser
KillMode=mixed
OOMPolicy=continue
Restart=always
RestartSec=5
StandardOutput=append:/home/nico/.t3/userdata/logs/boot-service.log
StandardError=append:/home/nico/.t3/userdata/logs/boot-service.log
```

公式 Nightly の ~/.t3/runtime/versions/.../node_modules/t3/dist/bin.mjs は現在のサービス実行コマンドではありません。過去のログには公式 Nightly 時代の内容が残っていますが、ログの古い行と現在の実行ファイルを混同しないこと。

### 現在の稼働確認

最終確認時点では、サービスは次のコマンドで稼働しています。

```text
/home/nico/.local/opt/node-v22.23.2-linux-x64/bin/node /run/media/nico/d/学校/app/t3code/apps/server/dist/bin.mjs serve --base-dir /home/nico/.t3 --port 3773 --host 127.0.0.1 --no-browser
```

ローカル確認:

```bash
systemctl --user status t3code.service --no-pager -l
systemctl --user show t3code.service -p ActiveState -p SubState -p MainPID -p ExecStart
curl -fsS http://127.0.0.1:3773/.well-known/t3/environment
curl -I http://127.0.0.1:3773/
```

最終確認結果:

- t3code.service: active (running)
- 127.0.0.1:3773: TCP listen 中
- /.well-known/t3/environment: HTTP 200
- /: HTTP 200
- server version: 0.0.42
- environment ID: 02c35d7b-838d-4baa-bb83-e9a3b15eee5a

ログ:

```text
/home/nico/.t3/userdata/logs/boot-service.log
```

ログの末尾で Migrations ran successfully、Listening on http://127.0.0.1:3773、T3 Code server is ready. を確認できます。

### サービス再起動時の注意

通常は次だけでよいです。

```bash
systemctl --user restart t3code.service
```

以前、Codex App Server の既存DBスキーマ不整合によってプロセスが起動前にハングし、systemd の stop-sigterm 状態から終了しないことがありました。その場合は、まず状態と MainPID を確認します。

```bash
systemctl --user status t3code.service --no-pager -l
systemctl --user show -p MainPID -p ActiveState -p SubState t3code.service
```

対象がこの t3code.service の起動中プロセスであることを確認できた場合に限り、サービス単位で停止します。

```bash
systemctl --user kill --kill-who=main --signal=SIGKILL t3code.service
systemctl --user reset-failed t3code.service
systemctl --user restart t3code.service
```

pkill -f、プロセス名検索結果をまとめて kill、ワークツリー文字列による kill は絶対に使わないこと。Codex Desktop、Codex App Server、別ワークツリーの開発サーバーを巻き込む危険があります。

## 4. Codex App Server 統合のアーキテクチャ

### Codex の既存 daemon を再利用する境界

Unix では Codex の既存 AppServerDaemon を優先して接続します。canonical control socket は次です。

```text
/home/nico/.codex/app-server-control/app-server-control.sock
```

主要コード:

- [CodexAppServerManager.ts](apps/server/src/provider/Layers/CodexAppServerManager.ts)
- [CodexAppServerTransport.ts](apps/server/src/provider/Layers/CodexAppServerTransport.ts)
- [CodexDriver.ts](apps/server/src/provider/Drivers/CodexDriver.ts)
- [CodexAdapter.ts](apps/server/src/provider/Layers/CodexAdapter.ts)
- [CodexHomeLayout.ts](apps/server/src/provider/Drivers/CodexHomeLayout.ts)
- [codexLaunchArgs.ts](apps/server/src/provider/Layers/codexLaunchArgs.ts)

CodexAppServerManager の責務:

- provider instance ごとに App Server manager を作る。
- preferExistingDaemon: true で有効な Codex home の canonical socket を優先する。
- 既存 socket がなければ T3 管理の一時 App Server を起動する fallback を持つ。
- Unix socket 上の WebSocket 接続を複数の App Server client で共有する。
- initialize / initialized handshake を行う。
- thread/list と thread/read をページングしながら読み取る。
- transport error や daemon exit で接続を再試行する。
- T3 が不要になったときに、T3 管理の fallback daemon だけを閉じる。

この実装は、Codex の既存 daemon を勝手に kill しません。既存 daemon の PID は起動ごとに変わるため、再起動・停止が必要な場合は、必ずその時点のプロセスと socket を確認してください。

### WebSocket over Unix socket transport

Codex App Server の protocol package は JSONL-shaped Stdio を想定します。一方、既存 daemon は Unix socket 上の HTTP-upgraded WebSocket を提供します。

CodexAppServerTransport.ts は次を変換します。

```text
Codex App Server WebSocket over Unix socket
        ↓
one WebSocket message = one JSON line
        ↓
effect-codex-app-server Stdio / typed JSON-RPC client
```

transport では次を行っています。

- Unix socket path への net.createConnection。
- ws://localhost/rpc の WebSocket upgrade。
- WebSocket close/error を clean EOF ではなく typed input failure として通知。
- 大きな command output を含む Codex turn のため、payload 上限を明示的に設定。
- peer close 時に pending request が永遠に待ち続けないようにする。

### T3 のスレッド同期

主要コード:

- [CodexAppServerThreadSync.ts](apps/server/src/orchestration/CodexAppServerThreadSync.ts)
- [ProviderAdapter.ts](apps/server/src/provider/Services/ProviderAdapter.ts)
- [serverRuntimeStartup.ts](apps/server/src/serverRuntimeStartup.ts)

Codex native thread ID から T3 の canonical ID を次の形式で作ります。

```text
codex:<native-codex-thread-id>
```

初期起動時と通常約5秒間隔で、次を行います。

- active / archived の native thread catalog を読み取る。
- Codex thread の cwd から T3 project を作成・再利用する。
- T3 の shell thread を作成・更新する。
- ProviderSessionDirectory に native threadId を resume cursor として保存する。
- Codex 側の archived / active 状態を T3 shell に反映する。
- native title の変更を T3 shell に反映する。
- Codex 側が idle なら T3 の stale running shell を settle する。
- Codex 側が active で T3 に live session がなければ、resume cursor 付きで session を再接続する。

この catalog pass は transcript を T3 event store に一件ずつ再インポートするものではありません。Codex が transcript の権威であり、T3 は参照用の shell と binding を維持します。

### Read-through history

主要コード:

- [CodexAppServerHistory.ts](apps/server/src/provider/Layers/CodexAppServerHistory.ts)
- [CodexAppServerHistoryProjection.ts](apps/server/src/provider/Layers/CodexAppServerHistoryProjection.ts)
- [CodexAppServerThreadSnapshot.ts](apps/server/src/provider/Layers/CodexAppServerThreadSnapshot.ts)
- [CodexAppServerEventProjection.ts](apps/server/src/provider/Layers/CodexAppServerEventProjection.ts)

canonical Codex thread の詳細表示時は、T3 の古いコピーを読むのではなく、App Server の native history を読み取って既存の T3 snapshot shape に投影します。

投影対象には次が含まれます。

- user / assistant message
- native turn と turn status
- reasoning / thinking item
- tool call と tool result
- command execution
- approval / user input request
- native diff / checkpoint-related information
- runtime event を T3 activity に変換した情報
- current turn / active turn

履歴はページングされます。古い履歴を読むときは native turn cursor を使い、通常の catalog/liveness pass では履歴全体を読みません。

### Live runtime ingestion

主要コード:

- [ProviderRuntimeIngestion.ts](apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts)
- [ProviderRuntimeActivityProjection.ts](apps/server/src/orchestration/ProviderRuntimeActivityProjection.ts)
- [ActivityPayloadProjection.ts](apps/server/src/orchestration/ActivityPayloadProjection.ts)
- [ProjectionPipeline.ts](apps/server/src/orchestration/Layers/ProjectionPipeline.ts)
- [ProviderCommandReactor.ts](apps/server/src/orchestration/Layers/ProviderCommandReactor.ts)
- [ws.ts](apps/server/src/ws.ts)
- [orchestration/http.ts](apps/server/src/orchestration/http.ts)

Codex の live protocol event を T3 の既存 runtime event / activity / message / turn projection へ変換します。履歴読み取りと live delivery の形を揃えることが、過去に発生した「履歴では見えるが実行中表示では見えない」「ツールコールだけ消える」「回答後にツールコールが出たように見える」問題を減らすための重要な境界です。

### T3 側にまだ残る状態

完全な T3 session 管理の削除はしていません。互換性のため、T3 側には次が残ります。

- thread/project shell projection
- provider_session_runtime
- provider instance binding
- live event projection
- client が従来の contract で取得する snapshot
- T3 の command receipt / orchestration event

ただし、Codex native transcript を T3 の message table に重複して常時コピーする設計を避け、native thread ID と App Server read-through を使います。

## 5. Diff / checkpoint 関連

主要コード:

- [CheckpointDiffQuery.ts](apps/server/src/checkpointing/CheckpointDiffQuery.ts)
- [ProviderDiffNormalization.ts](apps/server/src/checkpointing/ProviderDiffNormalization.ts)
- [Utils.ts](apps/server/src/checkpointing/Utils.ts)
- [GitVcsDriver.ts](apps/server/src/vcs/GitVcsDriver.ts)
- [ProjectionSnapshotQuery.ts](apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts)

Codex native diff と T3 checkpoint diff の境界を ProviderDiffNormalization にまとめています。native turn に対して missing/preview/ready の状態を区別し、assistant message と turn diff の関連を維持する設計です。

過去に次の症状がありました。

- cpp-fabricmc、my-quick-git、このスレッドなどで Diff が表示されない。
- Orca Desktop のレンダリング不具合スレッドだけは Diff が表示される。
- CodeView.addItem: duplicate id。
- duplicate id が /home/nico/.bun/install/global/package.json や、その同じパスの連結値になる。
- Git checkpoint 作成時に 30 秒で VCS process timed out になる。

現在のサーバー側では、Git checkpoint capture 系の command timeout を長くし、durable update/ref と diff normalization のテストを追加・維持しています。ただし、CodeView.addItem はクライアントの表示レイヤーで発生する可能性もあるため、サーバーを置き換えただけで UI 症状が完全に解消したと断定してはいけません。再発時は次の順で切り分けます。

1. native thread/read の turn / diff が存在するか。
2. T3 の snapshot response に重複ファイル ID が含まれていないか。
3. WebSocket の同一 event が二重配送されていないか。
4. クライアントの Diff file list が同一 path を二重 append していないか。
5. 同じ snapshot をクライアントが再適用していないか。

## 6. DB migration 衝突と今回の起動停止

### 原因

公式 Nightly とこのブランチが migration ID 50 以降を別用途で使っていました。

公式 Nightly の live DB には次のような記録がありました。

```text
50 CheckpointDiffBlobStatus
51 RepairCodexMessageDuplicates
52 RepairCodexLiveHistoryDuplicates
53 RepairCodexLiveMessageTurnIds
54 ProjectionThreadMessagePhase
55 ExistingNightlySchemaCompatibility
```

一方、このブランチの migration manifest では、同じ番号が別のスキーマに対応しています。既存DBは「migration ID が新しい」ため、パッチ版が期待する title_state_json などを追加せずに起動を進め、最終的に次のエラーになっていました。

```text
no such column: title_state_json
```

その結果、systemd 上では Node プロセス自体が残るものの、HTTP listener 起動前に startup fiber が失敗する状態になっていました。

### 修正

関連ファイル:

- [Migrations.ts](apps/server/src/persistence/Migrations.ts)
- [055_ExistingNightlySchemaCompatibility.ts](apps/server/src/persistence/Migrations/055_ExistingNightlySchemaCompatibility.ts)
- [056_ReconcileExistingNightlySchema.ts](apps/server/src/persistence/Migrations/056_ReconcileExistingNightlySchema.ts)
- [056_ReconcileExistingNightlySchema.test.ts](apps/server/src/persistence/Migrations/056_ReconcileExistingNightlySchema.test.ts)

56_ReconcileExistingNightlySchema を追加しました。この migration は migration 名を信用せず、実際の SQLite schema を確認します。

- projection thread pull request table を冪等に作成・補完。
- projection thread message の context_json を不足時だけ追加。
- projection thread の title_state_json を不足時だけ追加。
- pull_request_files_viewed table を冪等に作成。

ライブDBには migration 56 が適用済みです。

```text
projection_threads.title_state_json: present
pull_request_files_viewed: present
```

セッション本文や Codex native history は削除していません。DBのスナップショットを使った起動テストでも migration 56 適用後に Listening on まで進むことを確認しています。

### ライブDBの扱い

ライブDB:

```text
/home/nico/.t3/userdata/state.sqlite
```

このディレクトリは開発者の実データです。テスト時に直接 --base-dir /home/nico/.t3 を使うのは、ライブサービスの置き換えを意図する場合だけに限定してください。

安全なテストスナップショット:

```bash
debug_home=$(mktemp -d /tmp/t3code-live-snapshot.XXXXXX)
mkdir -p "$debug_home/userdata"
DEBUG_HOME="$debug_home" bun -e 'const { Database } = require("bun:sqlite"); const src = new Database(process.env.HOME + "/.t3/userdata/state.sqlite", { readonly: true }); src.run("VACUUM INTO ?", [process.env.DEBUG_HOME + "/userdata/state.sqlite"]); src.close();'
```

plain cp は live SQLite の -wal / -shm と整合しない可能性があるため、サービス稼働中は VACUUM INTO を使います。スナップショットは live DB に戻さず、一方向にコピーして使います。

## 7. 過去の問題と現在の扱い

### ワークツリー・ブランチの混乱

以前は次のようなエラーが発生しました。

```text
fatal: 'experiment/codex-app-server' is already used by worktree at '/run/media/nico/d/学校/app/t3code-work-codex-app-server'
```

また、t3code フォルダ、pr7863、opencode2-native の内容が混ざっている疑いがありました。最終的には origin/main を取得し、Codex App Server 変更を残したまま experiment/codex-app-server に merge しています。現在の service root はリポジトリ直下です。

別ブランチへ切り替える前に、必ず次を確認します。

```bash
git worktree list
git branch -vv
git status --short --branch
```

### メッセージ重複・未表示

ユーザーから次の症状が繰り返し報告されました。

- T3 から送ったメッセージが表示されない。
- しばらくすると同じ送信メッセージが2つ表示される。
- Codex CLI 側で実行中なのに T3 では running にならない。
- 回答終了後に reasoning と tool call がまとまらない。
- tool call の大部分が見えない。
- 送信後に、過去の tool call が回答後に実行されたように見える。

このブランチでは、native message ID / turn ID を使う projection、Codex history と live event の dedupe、Codex native history read-through、runtime event projection を実装しています。関連テストは通っていますが、ブラウザやモバイルの実画面での全スレッド再検証は別タスクとして残っています。

DBを毎回削除することは解決策ではありません。重複の原因が native history、T3 live projection、client snapshot replay のどこにあるかを分けて調べる必要があります。

### cpp-fabricmc 7th

このスレッドは過去の検証対象です。現在確認されている native thread ID は次です。

```text
native: 01a06c5e-fc8f-7ed3-a36c-6cce16750309
T3:     codex:01a06c5e-fc8f-7ed3-a36c-6cce16750309
```

以前は T3 側の読み込みが数日前までで止まっているように見え、Agent / Diff / running 状態の確認に使われました。今後このスレッドを再検証するときは、T3 projection ではなく App Server の thread/read が最新 turn を返すかを先に確認します。

### このタスクの Codex thread

現在の Codex App Server native ID:

```text
01a07b99-5e6e-7211-9700-73b5dc71e559
```

T3 canonical ID:

```text
codex:01a07b99-5e6e-7211-9700-73b5dc71e559
```

最終確認時点では、この thread の provider binding は running でした。

### CodeView.addItem: duplicate id

過去に次のクライアントエラーが出ました。

```text
Error: CodeView.addItem: duplicate id "/home/nico/.bun/install/global/package.json/home/nico/.bun/install/global/package.json"
```

このエラーは T3 の Diff UI の重複 append を示している可能性が高く、Codex App Server protocol の thread catalog だけで説明できるとは限りません。サーバー側では Diff normalization と checkpoint query の重複を減らしていますが、再発時は client 側の snapshot replay も調査対象です。サーバーのみで完全に直ったと断言しないこと。

### Agent タブ / サブエージェント

Agent タブは本家プロトコルを単に spoof すれば自動的に直る機能ではありません。Codex App Server の native sub-agent / collab item を、T3 の既存 runtime activity / agent presentation contract に変換する必要があります。

現在の環境 descriptor には次の capability がありました。

```text
agentActivityPublishing: false
```

これは T3 Connect 側の agent activity publishing capability と関係する可能性があり、Codex native sub-agent protocol が到着していることと同義ではありません。Agent タブを再検証する場合は、次を個別に確認します。

1. Codex native thread history に sub-agent item が存在するか。
2. CodexAppServerEventProjection が runtime event に変換しているか。
3. ProviderRuntimeIngestion が activity row を作っているか。
4. server capability が client の Agent tab を有効にしているか。
5. web / desktop / mobile で同じ snapshot shape が表示されるか。

### VCS timeout

過去に次のエラーがありました。

```text
VCS process timed out in GitVcsDriver.checkpoints.captureCheckpoint: git ... after 30000ms
```

現在の GitVcsDriver では checkpoint capture 系の command timeout を長くし、durable ref 更新と recovery を維持しています。テストは以下です。

```bash
./node_modules/.bin/vp test run apps/server/src/vcs/GitVcsDriver.test.ts
```

### SSH の t3 CLI が見つからない問題

別の問題として、Windows の T3 クライアントから SSH environment を準備すると次が出ました。

```text
Remote host is missing the t3 CLI and could not install t3@... because node/npm/npx are unavailable on PATH.
```

リモートホストには /home/nico/.bun/bin/bun、bunx、t3 がありましたが、non-interactive SSH の PATH に ~/.bun/bin が含まれていませんでした。これは App Server 統合の protocol 問題ではなく、SSH の非対話シェル環境問題です。systemd でこのパッチ版を動かす構成とは別に扱います。

確認例:

```bash
ssh nico 'printf "user=%s\nhome=%s\npath=%s\n" "$USER" "$HOME" "$PATH"; command -v t3; command -v bun; command -v bunx'
```

~/.local/bin に symlink を作る場合、リンク先の実在性と、非対話シェルがその PATH を読むことを確認します。単にクライアントを変えたり、Node を再インストールしたりする前に、command -v と ls -l で切り分けます。

### Mobile / Expo

Mobile アプリは React Native / Expo の構成です。Expo の app metadata が表示されたこと自体は Codex App Server 統合とは別問題です。今回の server-only 方針では mobile source を Codex thread protocol 用に変更していません。

Mobile の remote environment 接続時に HTTPS endpoint が必要な経路へ plain HTTP を送って 400 になる問題がありました。Tailscale の forward / proxy を使う場合は、実際にクライアントがアクセスする scheme とポートが一致しているかを確認します。

## 8. 検証済みのテスト

### 実行済みテスト

過去の統合確認で次が成功しています。

```bash
./node_modules/.bin/vp test run apps/server/src/vcs/GitVcsDriver.test.ts
```

- 49 tests passed

```bash
./node_modules/.bin/vp test run apps/server/src/provider/Layers/CodexSessionRuntime.test.ts
```

- 56 tests passed

```bash
./node_modules/.bin/vp test run apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts
```

- 88 tests passed

```bash
./node_modules/.bin/vp test run apps/server/src/persistence/Migrations/055_ExistingNightlySchemaCompatibility.test.ts apps/server/src/persistence/Migrations/056_ReconcileExistingNightlySchema.test.ts
```

- 2 test files passed
- 2 tests passed

```bash
./node_modules/.bin/vp run --filter=t3 typecheck
```

- exit code 0
- Effect の既存 suggestion 診断は大量に出るが、型エラーはなし

```bash
./node_modules/.bin/vp run --filter=t3 build:bundle
```

- exit code 0
- apps/server/dist/bin.mjs を生成

### isolated live DB 起動テスト

/home/nico/.t3/userdata/state.sqlite を VACUUM INTO で一時ディレクトリへ snapshot し、そこを --base-dir にして別ポートでサーバーを起動しました。

修正前は title_state_json がないため失敗しました。修正後は次を確認済みです。

```text
Migrations ran successfully
  migrations: [ '56_ReconcileExistingNightlySchema' ]
Listening on http://127.0.0.1:<temporary-port>
T3 Code server is ready.
```

### まだ未実施の検証

この Handoff 作成時点では、次を「実画面で完全に確認済み」とは扱いません。

- Web UI で cpp-fabricmc 7th の最新ページを最後まで表示すること。
- Diff tab で全ファイルが重複なく表示されること。
- Agent tab で sub-agent が表示されること。
- Mobile app で同一スレッドの native history / live event が一致すること。
- 同じメッセージを T3 と Codex CLI から交互に送った際に重複しないこと。
- Codex CLI 実行中に T3 を再接続して running / tool call / reasoning が崩れないこと。

これらを行う場合は、リポジトリの test-t3-app / test-t3-mobile skill とプロジェクトの AGENTS.md を先に読み、isolated state を使います。ライブの /home/nico/.t3 に dev server を向けないこと。

## 9. 再開手順

### まず読むもの

1. リポジトリ直下の AGENTS.md。
2. この Handoff.md。
3. Codex 関連なら apps/server/src/provider/Layers/CodexAppServerManager.ts、CodexAppServerThreadSnapshot.ts、orchestration/CodexAppServerThreadSync.ts。
4. Effect code を変更する場合は .repos/effect-smol/LLMS.md。

### 状態確認

```bash
cd /run/media/nico/d/学校/app/t3code
git status --short --branch
git log --oneline --decorate -8
git worktree list
systemctl --user status t3code.service --no-pager -l
curl -fsS http://127.0.0.1:3773/.well-known/t3/environment
```

### Codex daemon の確認

```bash
test -S /home/nico/.codex/app-server-control/app-server-control.sock && echo socket-present
ps -eo pid,ppid,stat,etime,args | rg '[c]odex.*app-server'
```

既存 daemon の確認には、名前検索結果をそのまま kill に使わないこと。Codex Desktop 内蔵の App Server と、Codex CLI の App Server が複数存在する可能性があります。

### ソース変更後

```bash
./node_modules/.bin/vp fmt --write <changed-files>
./node_modules/.bin/vp fmt --check <changed-files>
./node_modules/.bin/vp test run <focused-tests>
./node_modules/.bin/vp run --filter=t3 typecheck
./node_modules/.bin/vp run --filter=t3 build:bundle
systemctl --user restart t3code.service
curl -fsS http://127.0.0.1:3773/.well-known/t3/environment
tail -n 100 /home/nico/.t3/userdata/logs/boot-service.log
```

AGENTS.md の方針に従い、通常は vp check、repo-wide test、repo-wide typecheck を実行しません。変更範囲に対応した focused test を実行します。

### スレッドを確認するとき

T3 のローカル投影だけで判断せず、native thread ID を確認します。

```text
T3 ID: codex:<native-id>
native ID: <native-id>
```

確認の順序:

1. App Server の thread/list に thread が存在するか。
2. thread/read の native turns/items に最新メッセージ、tool、reasoning、diff があるか。
3. T3 ProviderSessionDirectory の resume_cursor_json が同じ native ID を指すか。
4. T3 snapshot が native history を投影しているか。
5. WebSocket live event が snapshot と重複していないか。

## 10. 今後の優先課題

優先度の高い順に、次の課題が残っています。

1. cpp-fabricmc 7th を実データで読み取り、最新 native turn まで T3 が表示することを確認する。
2. 同スレッドで Codex CLI を実行し、T3 の running / settled / tool call / reasoning 同期を確認する。
3. Diff の重複 id エラーが server snapshot 由来か client append 由来かを分離する。
4. Agent tab の native sub-agent item、runtime activity、capability の接続を確認する。
5. T3 から送ったメッセージと Codex CLI から送ったメッセージを交互に送り、duplicate / missing message がないことを確認する。
6. 起動時の Codex catalog sync が daemon 不調時に HTTP listener を無期限に遅延させないよう、timeout または non-blocking startup を検討する。ただし、単に同期を無効にして互換性を失わせないこと。
7. Node 24 系が必要になった場合に systemd の Node runtime を更新する。現在は Node v22.23.2 で build/test/service が動作しているが、依存側から Node ^24.13.1 の engine warning が出ていた。
8. source change を push する場合は、現在の fork remote と branch protection を確認してから行う。作業範囲に push が含まれない場合は勝手に push しない。

## 11. 変更してはいけないもの

- /home/nico/.t3/userdata をテスト用に削除・初期化しない。
- state.sqlite、Codex session JSONL、Pairing Token、secrets.json を手動で消さない。
- pkill -f や広いパターンの kill を使わない。
- 公式 Nightly の runtime をサービスに戻さない。ユーザーの明示的な方針はパッチ版をサービスで使うこと。
- クライアント側に大きな変更を加える前に、まず server contract / native protocol projection で解決できるか確認する。
- T3 の transcript コピーを再導入しない。Codex App Server の native history を権威として維持する。
- dev server に VITE_HTTP_URL / VITE_WS_URL を設定しない。remote browser / mobile 接続を壊す可能性がある。
- 新しい Codex daemon を無条件に起動して既存 daemon と二重化しない。まず canonical control socket を再利用する。

## 12. 現在の結論

現在の実装は、origin/main に追従した experiment/codex-app-server 上で、既存 Codex App Server daemon を利用するパッチ版 T3 サーバーとして稼働しています。

特に重要なのは次の4点です。

1. ライブサービスは公式 Nightly ではなく、現在のワークツリーから生成した apps/server/dist/bin.mjs を直接実行している。
2. Codex native thread / history を読み取り、T3 は既存クライアント互換の shell / projection を提供している。
3. 公式 Nightly と migration ID が衝突していた問題を migration 56 で補完し、既存DBを削除せずに起動できるようにした。
4. Diff、Agent、duplicate message、tool/reasoning の完全な実画面検証は今後の対象であり、server unit test 成功だけで完了扱いにしない。

このファイルを読んだ担当者は、まずサービスと Git 状態を確認し、変更を行う場合は Goal を設定してから focused test → bundle build → systemd restart → HTTP / native Codex 確認の順で進めてください。
