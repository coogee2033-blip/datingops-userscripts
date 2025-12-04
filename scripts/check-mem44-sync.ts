/**
 * MEM44 Sync Check Script
 *
 * 「GitHub ↔ ローカル ↔ Tampermonkey」のズレをチェックするスクリプト
 *
 * 使い方:
 *   npx ts-node scripts/check-mem44-sync.ts
 *   または
 *   npm run check:mem44
 *
 * Tampermonkey との比較をする場合:
 *   1. Tampermonkey ダッシュボード → MEM44 スクリプトを開く
 *   2. エディタの内容をすべてコピー
 *   3. tmp/mem44.from-tm.js に貼り付けて保存
 *   4. このスクリプトを再実行
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as https from "node:https";

// ---- 定数 ----
const LOCAL_PATH = "tm/mem44.user.js";
const REMOTE_URL =
  "https://raw.githubusercontent.com/coogee2033-blip/datingops-userscripts/main/tm/mem44.user.js";
const TM_COPY_PATH = "tmp/mem44.from-tm.js";

// ---- ヘルパー関数 ----

/**
 * ファイルが存在すれば内容を返し、なければ null を返す
 */
async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    const absPath = path.resolve(filePath);
    const content = await fs.readFile(absPath, "utf8");
    return content;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * テキストの SHA1 ハッシュを計算
 */
function sha1(text: string): string {
  return crypto.createHash("sha1").update(text, "utf8").digest("hex");
}

/**
 * HTTPS で raw ファイルを取得
 */
function fetchRemoteRaw(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve(data);
        });
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

/**
 * 先頭 N 行を取得
 */
function getFirstLines(text: string, n: number): string[] {
  return text.split("\n").slice(0, n);
}

/**
 * バイト数をフォーマット
 */
function formatBytes(bytes: number): string {
  return `${bytes.toLocaleString()} bytes`;
}

// ---- メイン処理 ----

interface FileInfo {
  path: string;
  content: string | null;
  size: number;
  sha1: string;
}

async function main(): Promise<void> {
  console.log("=".repeat(50));
  console.log("=== MEM44 Sync Check ===");
  console.log("=".repeat(50));
  console.log("");

  let hasError = false;

  // 1. ローカルファイル読み込み（必須）
  const localContent = await readFileIfExists(LOCAL_PATH);
  if (localContent === null) {
    console.error(`❌ ローカルファイルが見つかりません: ${LOCAL_PATH}`);
    process.exit(1);
  }
  const local: FileInfo = {
    path: LOCAL_PATH,
    content: localContent,
    size: Buffer.byteLength(localContent, "utf8"),
    sha1: sha1(localContent),
  };

  // 2. リモートファイル取得（必須）
  let remoteContent: string;
  try {
    remoteContent = await fetchRemoteRaw(REMOTE_URL);
  } catch (err: any) {
    console.error(`❌ GitHub からの取得に失敗: ${err.message}`);
    process.exit(1);
  }
  const remote: FileInfo = {
    path: REMOTE_URL,
    content: remoteContent,
    size: Buffer.byteLength(remoteContent, "utf8"),
    sha1: sha1(remoteContent),
  };

  // 3. TM コピーを読み込み（あれば）
  const tmContent = await readFileIfExists(TM_COPY_PATH);
  let tm: FileInfo | null = null;
  if (tmContent !== null) {
    tm = {
      path: TM_COPY_PATH,
      content: tmContent,
      size: Buffer.byteLength(tmContent, "utf8"),
      sha1: sha1(tmContent),
    };
  }

  // ---- 出力 ----

  // Local
  console.log("[Local]");
  console.log(`  path: ${local.path}`);
  console.log(`  size: ${formatBytes(local.size)}`);
  console.log(`  sha1: ${local.sha1}`);
  console.log("");

  // GitHub
  console.log("[GitHub]");
  console.log(`  url : ${remote.path}`);
  console.log(`  size: ${formatBytes(remote.size)}`);
  console.log(`  sha1: ${remote.sha1}`);
  console.log("");

  // Local vs GitHub 比較
  const localVsGithub = local.sha1 === remote.sha1;
  if (localVsGithub) {
    console.log("→ Local vs GitHub: ✅ MATCH");
  } else {
    console.log("→ Local vs GitHub: ⚠️  DIFF");
    hasError = true;

    // 差分の先頭行を表示
    console.log("");
    console.log("  --- Local (first 5 lines) ---");
    getFirstLines(local.content!, 5).forEach((line, i) => {
      console.log(`  ${i + 1}: ${line}`);
    });
    console.log("");
    console.log("  --- GitHub (first 5 lines) ---");
    getFirstLines(remote.content!, 5).forEach((line, i) => {
      console.log(`  ${i + 1}: ${line}`);
    });
  }
  console.log("");

  // Tampermonkey (optional)
  console.log("-".repeat(50));
  console.log("[Tampermonkey (optional)]");
  if (tm === null) {
    console.log(`  ⚠️  TM との比較はまだです`);
    console.log(`  → ${TM_COPY_PATH} が存在しません`);
    console.log("");
    console.log("  💡 Tampermonkey の内容を確認するには:");
    console.log("     1. TM ダッシュボード → MEM44 スクリプトを開く");
    console.log("     2. エディタの内容をすべてコピー");
    console.log(`     3. ${TM_COPY_PATH} に貼り付けて保存`);
    console.log("     4. このスクリプトを再実行");
  } else {
    console.log(`  path: ${tm.path}`);
    console.log(`  size: ${formatBytes(tm.size)}`);
    console.log(`  sha1: ${tm.sha1}`);
    console.log("");

    // Local vs TM
    const localVsTm = local.sha1 === tm.sha1;
    if (localVsTm) {
      console.log("→ Local vs TM: ✅ MATCH");
    } else {
      console.log("→ Local vs TM: ⚠️  DIFF");
      hasError = true;
    }

    // GitHub vs TM
    const githubVsTm = remote.sha1 === tm.sha1;
    if (githubVsTm) {
      console.log("→ GitHub vs TM: ✅ MATCH");
    } else {
      console.log("→ GitHub vs TM: ⚠️  DIFF");
      hasError = true;
    }

    // 3点すべて一致
    if (localVsGithub && localVsTm && githubVsTm) {
      console.log("");
      console.log("🎉 Local / GitHub / TM すべて一致しています！");
    }
  }

  console.log("");
  console.log("=".repeat(50));

  if (hasError) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("❌ 予期しないエラー:", err);
  process.exit(1);
});

