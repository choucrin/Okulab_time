# 開発依頼

## 自動実行の完了方式
次のdevflowブロックを1つだけ置いてください。プログラムが読み取り、開始時に固定します。

```devflow
{
  "delivery_mode": "pull_request",
  "base_branch": "main",
  "pr_events_reviewed": true,
  "preview_deployments": "deny",
  "after_merge": "none",
  "deployment_tasks": [],
  "pr_title": ""
}
```

- `delivery_mode`: `push`＝従来のprivateリポジトリへ直接push、`pull_request`＝専用ブランチへpushしてPR作成まで。PRの承認・マージはユーザが行う。
- `base_branch`: push先、またはPRのマージ先。例: main。
- `pr_events_reviewed`: PR方式で、作業ブランチpush・PR作成のCI/外部連携が本番配信や自動マージを行わないことを確認したらtrue。許可しないプレビュー配信がないことも確認する。
- `preview_deployments`: PRイベントによるプレビュー配信の許可範囲（deny/allow）。denyでも既存設定を自動無効化するわけではない。上記確認に含める。
- `after_merge`: PR方式で追加配信作業をエージェントへ任せる場合はagent、不要ならnone。
- `deployment_tasks`: 追加作業を日本語の文字列配列で指定。例: ["Firebase Hostingの配信設定を確認し、必要な設定とデプロイを行う"]。具体案はマージ後の対話でユーザが承認してから実行する。
- `pr_title`: PRのタイトル。空なら案件名から生成。

PR方式で追加配信を任せる場合は、delivery_modeをpull_request、確認後のpr_events_reviewedをtrue、after_mergeをagentに変更し、deployment_tasksを記入してください。
push方式ではprivate・Pages未設定・Actions無効・有効Webhookなし・外部自動配信なしが必要です。PR方式では公開・配信中のリポジトリも扱えます。
PR方式ではCI/配信設定ファイル自体を変更する候補は自動送信を停止します。変更が必要なら個別に確認します。

## 目的
- 誰が何のために使うアプリか:開発者と実験被験者が双方で使用するアプリ。開発者が開始ボタンを押下し、被験者が終了ボタンを押下するまでの時間を計測する。
- 既にアプリケーション自体は完成しているため、今回は追加機能の開発を行う。

## 必須機能
- "ラベル機能" : 現状の手入力でのラベル付けに加え、選択的に使用できるラベルを追加する。ラベルのジャンル(例:色)とラベルの内容(例:白, 赤, 緑黄)を自由に作成・追加・削除できるようにする。設定したラベルは、入室したルームに関わらずグローバルで利用できるようにする。また、CSV出力した際に選択したラベルが何かを出力できるようにする。ラベルは未入力・複数選択を可能とする。
- "文字サイズ変更" : 被験者画面で表示する文章の文字サイズが小さいため、1.2倍ほどのサイズに変更すること。過去のログに"画面をスクロールする必要のないサイズにする"という旨の指示があった場合、その指示は無視してよい。

## 受け入れ条件
- 何ができれば今回の依頼を完了としてよいか:上記の必須機能を全て満たし、かつアプリとして問題なく機能すること。

## 対象と制約
- 対象: Windows / iOS / iPadOS（対象ブラウザも指定）
- 実機確認: 必須 / 任意（選択し、実施できる端末を記載）
- 運用費用: 原則無料
- 公開先候補: GitHub Pages / Firebase
- 公開・追加配信設定: マージとは別に、具体的な変更内容をユーザが承認する
- 対象外の機能:

## 技術構成
- 指定があれば記載。未指定ならDesign担当が要件に適した構成を選ぶ。
- 既存案件ではバージョン・既存の検証コマンドを記載する。

## 担当と成果物
- Claude Code: Design / Test。RSD.md、Test.md。
- Codex: Development / Review / 統合確認、ユーザ承認後の追加配信設定。
- 進行管理: CLI起動、引き継ぎ、状態保存、検証後のGit操作・PR作成。
- 指示書や要件の変更はユーザの指示を確認する。

## 補足・任せる判断
- バージョン表記は開発ログを参照し、引き継ぐこと。

## 起動
TASKS.mdを編集してコミットした後:
`~/projects/automation/bin/devflow start ~/projects/repos/<project-name>`

PRをユーザがマージした後、追加配信作業を開始する場合:
`~/projects/automation/bin/devflow after-merge <実行ID>`

初回登録と再開方法は `~/projects/automation/README.md` を参照。
