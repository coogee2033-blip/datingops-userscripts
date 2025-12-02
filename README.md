# DatingOps UserScripts

DatingOps 向け Tampermonkey UserScript の公開置き場です。

## Tampermonkey スクリプト一覧

### サイト別スクリプト（`tm/` ディレクトリ）

| ファイル | 対象サイト | 説明 |
|----------|------------|------|
| `tm/mem44.user.js` | https://mem44.com/* | mem44 専用 AI パネル |
| `tm/olv29.user.js` | https://olv29.com/* | OLV29 専用 AI パネル |

## インストール方法（Private リポジトリ向け）

このリポジトリは Private のため、GitHub Personal Access Token (PAT) を使って更新します。

### 1. GitHub Token を発行

1. https://github.com/settings/tokens/new にアクセス
2. **Note**: 任意の名前（例: `tampermonkey-datingops`）
3. **Expiration**: 任意（No expiration でも可）
4. **Scopes**: `repo` にチェック
5. 「Generate token」→ トークンをコピー

### 2. Tampermonkey にスクリプトを登録

1. Tampermonkey ダッシュボード → **新規スクリプト作成**
2. 以下の URL（`PUT_TOKEN_HERE` を実際のトークンに置換）をブラウザで開く：

**mem44 用:**
```
https://raw.githubusercontent.com/coogee2033-blip/datingops-userscripts/main/tm/mem44.user.js?token=YOUR_TOKEN
```

**OLV29 用:**
```
https://raw.githubusercontent.com/coogee2033-blip/datingops-userscripts/main/tm/olv29.user.js?token=YOUR_TOKEN
```

3. 「このスクリプトをインストール」をクリック
4. インストール後、スクリプトの `@downloadURL` と `@updateURL` の `PUT_TOKEN_HERE` を実際のトークンに書き換える

### 3. 更新方法

- Tampermonkey で「UserScript の更新を確認」をクリック
- 自動的に最新版が反映される

## 重要な注意事項

⚠️ **Token をリポジトリにコミットしないでください**

- スクリプトファイル内の `PUT_TOKEN_HERE` はプレースホルダーです
- 実際の Token は Tampermonkey 内でのみ設定してください
- Token を含むファイルを絶対にコミットしないでください

## 対応サイト

- `https://mem44.com/*` → `tm/mem44.user.js`
- `https://olv29.com/*` → `tm/olv29.user.js`

## バージョン

- mem44: `1.0`
- olv29: `1.0`
