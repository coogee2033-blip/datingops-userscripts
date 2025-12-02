# DatingOps UserScripts

DatingOps 向け Tampermonkey UserScript の公開置き場です。

## インストール方法

### 新規インストール

1. [Tampermonkey](https://www.tampermonkey.net/) をブラウザにインストール
2. 以下の URL を開く：
   ```
   https://raw.githubusercontent.com/coogee2033-blip/datingops-userscripts/main/datingops.user.js
   ```
3. 「このスクリプトをインストール」をクリック

### 手動インストール

1. Tampermonkey ダッシュボードを開く
2. 「新規スクリプト作成」をクリック
3. `datingops.user.js` の内容をコピー＆ペースト
4. 保存

## 自動更新について

スクリプト内の `@updateURL` と `@downloadURL` が設定されているため、Tampermonkey の「UserScript の更新を確認」機能で自動更新できます。

```javascript
// @updateURL    https://raw.githubusercontent.com/coogee2033-blip/datingops-userscripts/main/datingops.user.js
// @downloadURL  https://raw.githubusercontent.com/coogee2033-blip/datingops-userscripts/main/datingops.user.js
```

## 対応サイト

- `https://mem44.com/*`
- `https://olv29.com/*`

## バージョン

現在のバージョン: `2025-12-01a`


