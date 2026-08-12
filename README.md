# 製図時間管理ツール

一級建築士 製図試験（6時間30分）の練習で、**工程ごとの所要時間を計測・記録・分析する**Webツールです。

- **使う** → https://shinji-kivi.github.io/seizu-timer/
- **触って試す（ダミーデータ入り）** → https://shinji-kivi.github.io/seizu-timer/demo.html
- **使い方ガイド** → https://shinji-kivi.github.io/seizu-timer/help.html

インストール・登録・課金は不要です。ブラウザで開けばすぐ使えます。

---

## 何ができるか

工程ごとに「次の工程へ」を押してラップを取ると、目標時間との差と、回を重ねたときの伸びが記録されます。

### 計測

- **カウントアップ式のタイマー**。ワンタップで次の工程へ進む
- **遅れ / 貯金の表示** — 目標に対して全体で何分押しているかを常時表示。工程ごとの赤字と違い、どこで巻くべきかの判断に使える
- **本番時刻への換算** — 開始時刻を設定すると「本番なら今 15:42・残り 1時間48分（終了 17:30）」と表示
- **1つ戻す** — ラップの押し間違いを取り消せる。取り消した分の経過時間は前の工程に足し戻るので累計はずれない
- **画面スリープの防止**（対応ブラウザのみ）
- 一時停止・途中終了に対応。**途中終了した回はベストタイム・成長グラフの対象外**になる
- 計測中にページを閉じても復元できる

### 工程セット

工程の組み合わせを**複数保存して切り替えられます**。「作図のみ」に本番想定（180分・19工程）と作図タイムトライアル（60分・5工程）を並べておき、練習の種類に応じて選ぶ、といった使い方ができます。

- 練習回数・ベストタイム・成長グラフは**工程セットごとに集計**されるので、60分の部分練習をしても通し練習のベストタイムは崩れません
- 工程には内部的に固有の番号が付いており、**工程名を変えても過去の記録と繋がったまま**分析されます
- プリセットから追加できます（作図タイムトライアル 60分 / 本番想定・大枠 6工程）

### 振り返り・分析

- 各工程の**実績 vs 目標 vs 過去平均**を並べて表示。Good / Bad の評価とメモを記録
- 成長推移（合計タイムの折れ線）、工程内訳（積み上げ棒 / 工程を選んで折れ線）
- 工程比較（平均・最速・最遅）、評価分析（工程ごとの Good 率、Bad が多い工程を強調）
- モード・工程セット・課題名でフィルタ

### モード

| モード | 目安 | 範囲 |
|---|---|---|
| フル | 390分 | エスキスから作図・記述まで全工程 |
| エスキスのみ | 150分 | 問題読み取りからエスキス完了まで |
| 作図のみ | 180分 | 作図・断面図・外構など |
| 記述のみ | 60分 | 計画の要点のみ |

工程名・目標時間・並び順はすべて設定画面から変更できます。

### アプリとして使う（PWA）

ホーム画面に追加すると**全画面で起動**し、ブラウザのバーが消えます。長時間の通し練習中に誤タップで画面が飛ぶ事故を防げます。**オフラインでも動作**します。

- iPhone / iPad: 共有ボタン →「ホーム画面に追加」
- Android: メニュー →「アプリをインストール」
- PC（Chrome / Edge）: アドレスバー右のインストールアイコン

---

## データの取り扱い

**記録はお使いの端末のブラウザ内（localStorage）にのみ保存されます。外部への送信は一切ありません。** サーバーもアカウントもありません。

そのため、次の場合は記録が消えます。**設定 → データ管理 → エクスポート**で定期的にバックアップ（JSONファイル）を取ってください。前回のバックアップから記録が10件たまると、ホーム画面でお知らせします。

- ブラウザの閲覧データ（Cookie・サイトデータ）を削除したとき
- プライベートブラウズで使ったとき
- iPhone / iPad で、ホーム画面に追加せず長期間開かなかったとき
- 別の端末・別のブラウザで開いたとき（記録は共有されません）

JSONバックアップはインポートで復元・端末間移行ができます。分析用に CSV（UTF-8 BOM付き、1行 = 1セッション × 1工程）も書き出せるので、スプレッドシートでピボット集計もできます。

---

## 免責

工程と目標時間は練習の目安です。試験の結果を保証するものではありません。本ツールの利用によって生じた不利益について、作者は責任を負いません。

---

## 開発者向け

### 構成

単一 HTML ファイルに HTML / CSS / JS を内包しています。ビルド不要です。

| ファイル | 役割 |
|---|---|
| `index.html` | 本体。これ1つで動く |
| `demo.html` | デモ版。ストレージキーに `demo_` を付けて本番データと分離し、起動時にダミー履歴を生成する |
| `help.html` | 別ページの詳細ガイド |
| `仕様書.md` | 仕様の決定版。工程の目標時間の根拠、設計判断を含む |
| `manifest.json` / `sw.js` | PWA 定義と Service Worker |
| `vendor/chart.umd.min.js` | Chart.js 4.4.4 を同梱（CDN に依存しない） |
| `tests/logic.test.js` | ロジックのテスト |

### テスト

```
node tests/logic.test.js
```

`index.html` の `<script>` を抜き出し、最小限の DOM / localStorage スタブを噛ませて Node で実行します。工程セットの形式チェック、旧形式からの移行、工程 id による履歴の突き合わせ、工程セット単位の集計を検証します。依存パッケージはありません。

### demo.html の再生成

`demo.html` は `index.html` の実質コピーです。手で同期するとずれるため、`index.html` を編集したら機械的に作り直してください。

```python
import io
demo = io.open('demo.html', encoding='utf-8').read()
src  = io.open('index.html', encoding='utf-8').read()
start = demo.index('function generateDemoData()')
end   = demo.index('loadThemeColor();', start)
fn = demo[start:end].rstrip('\n')          # 既存 demo.html からデモデータ生成関数を回収

src = src.replace('<title>製図時間管理ツール</title>', '<title>製図時間管理ツール（デモ）</title>')
src = src.replace('<link rel="manifest" href="manifest.json">\n', '')   # デモはインストール対象外
for k in ['seizu_sessions','seizu_templates','seizu_stats','seizu_active_session',
          'seizu_screen','seizu_theme_color','seizu_intro_seen','seizu_last_version',
          'seizu_clock_start','seizu_backup_at']:
    src = src.replace("'%s'" % k, "'demo_%s'" % k)

anchor_fn = '\nloadThemeColor();\n'
assert src.count(anchor_fn) == 1
src = src.replace(anchor_fn, '\n' + fn + '\n\nloadThemeColor();\n')

anchor_call = "document.getElementById('help-version').textContent = 'v' + APP_VERSION + '（' + APP_VERSION_DATE + '）';\n"
assert src.count(anchor_call) == 1
src = src.replace(anchor_call, anchor_call + 'generateDemoData();\n')

io.open('demo.html','w',encoding='utf-8',newline='').write(src)
```

注意点:

- **ストレージキーを増やしたら、上のリストにも追加すること。** 漏れるとデモ版が本番のデータを触ります。再生成後は `grep -n "'seizu_" demo.html` で本番キーの残留を確認してください（ヒットしてよいのはダウンロードのファイル名3件のみ）
- **保存データの形式を変えたら、先に `demo.html` 側の `generateDemoData()` を追随させること。** 再生成スクリプトはこの関数を既存 `demo.html` から回収して差し込むだけなので、追随を忘れるとデモだけ静かに壊れます

### 設計上の要点

- **工程には固定 id があり、それが履歴の突き合わせキー**です。既定の工程の id（`s_area` など）は**一度配布したら変更しないでください**。変えるとその工程の履歴が割れます。突き合わせは `工程 id → 既定の工程名からの逆引き → 工程名` の3段で解決し、id を持たない古い記録も繋がるようにしています
- **Service Worker のキャッシュ戦略は HTML = ネットワーク優先 / JS・アイコン = キャッシュ優先**です。「更新したのに古い画面が貼り付く」事故を避けるため。`sw.js` の `CACHE` の版数は、同梱の Chart.js やアイコンを差し替えたときだけ上げます
- localStorage への書き込みは失敗しうる（保存領域が一杯・プライベートブラウズ等）ため、必ず成否を確認しています。**記録の保存に失敗したときは画面に留まり、その場でファイルに書き出せる導線**を出します

詳しくは `仕様書.md` を参照してください。

### リリース

`main` への push で GitHub Actions が GitHub Pages へ自動デプロイします。

1. `index.html` の `APP_VERSION` / `APP_VERSION_DATE` を更新（ここが正本）
2. アプリ内ヘルプの「更新履歴」カードと `help.html` の更新履歴に、利用者から見た変化を追記
3. `demo.html` を再生成し、テストと構文チェックを通す
4. **タグを打ってから** push する（`git tag -a vX.Y.Z` → `git push origin main` → `git push origin vX.Y.Z`）

番号は、機能追加が minor、不具合修正のみが patch、使い方が変わる作り替えが major です。更新履歴の正本はヘルプなので、`CHANGELOG.md` は作りません（同じ内容を2ヶ所に置くと必ずずれるため）。

> GitHub Pages は HTML に `Cache-Control: max-age=600` を付けるため、デプロイ成功後も CDN が最大10分ほど前の版を返すことがあります。反映確認のときは URL にクエリを付けて（例: `?cb=123`）オリジン側と比べてください。

### 含まれないもの

工程の目標時間の根拠にした資格学校の配布物は、著作物のため**リポジトリに含めていません**（`.gitignore` で除外）。数値そのものと出典の所在は `仕様書.md` に記載しています。

---

## ライセンス

MIT License（[LICENSE](LICENSE)）

同梱ライブラリ: [Chart.js](https://www.chartjs.org/) 4.4.4 — MIT License, Copyright (c) 2014-2022 Chart.js Contributors
