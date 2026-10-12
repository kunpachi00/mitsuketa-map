# みつけたマップ

みつけたもの（生き物・植物・歴史・地形・食べもの など）を、写真と一緒に地図に記録していく「地図の記録帳」です。

- ビルド不要の静的サイト（GitHub Pages で公開）
- 記録と写真は各端末の中（IndexedDB）にだけ保存。サーバーは使いません
- 家族との共有は zip ファイルの書き出し／取り込み
- 地図：[地理院タイル](https://maps.gsi.go.jp/development/ichiran.html)

## ファイル

| ファイル | 内容 |
|---|---|
| `index.html` / `style.css` / `app.js` | アプリ本体 |
| `manifest.webmanifest` / `sw.js` | ホーム画面に追加して使うための設定（アプリ本体だけキャッシュ） |
| `vendor/` | Leaflet 1.9.4 / Leaflet.markercluster 1.5.3 / JSZip 3.10.1 |
| `icons/` | アプリのアイコン |

## 更新するとき

`app.js` などを直したら、`sw.js` の `CACHE` の番号（例：`v1.0.0` → `v1.0.1`）を上げてから push します。
上げないと、ホーム画面のアプリに古い版が残ります。

## 手元で動かす

```
python -m http.server 8000
```

`http://localhost:8000/` を開きます（現在地は https か localhost でのみ動きます）。
