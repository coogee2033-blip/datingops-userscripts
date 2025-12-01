// ==UserScript==
// @name         DatingOps Panel（個別送信のみ・ドラッグ可・送信時メモ自動保存 v2025-12-01a）
// @namespace    tamper-datingops
// @version      2025-12-01a
// @updateURL    https://raw.githubusercontent.com/coogee2033-blip/datingops-userscripts/main/datingops.user.js
// @downloadURL  https://raw.githubusercontent.com/coogee2033-blip/datingops-userscripts/main/datingops.user.js
// @description  個別送信ページだけでAIパネル表示。中央カラムから会話抽出→n8nへ送信→返信欄へ自動挿入。サイドカラム除外、クラス優先+座標fallbackの男女判定、最新20件の完全送信、profileText活用、送信フェイルオーバ、メモ候補抽出＆ふたりメモ追記機能。
// @run-at       document-idle
// @match        https://mem44.com/*
// @match        https://olv29.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @connect      127.0.0.1
// @connect      192.168.*.*
// ==/UserScript==

console.log("TM auto-update test2 v2025-12-01a");

(() => {
  "use strict";

  // [2025-12-01a] iframe 内では動かさない
  if (window.top !== window.self) {
    console.debug("[DatingOps] skip: in iframe");
    return;
  }

  // [2025-11-30d] 二重実行ガード（IIFE レベル）
  const g = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  if (g.__datingOpsInitDone) {
    console.log("[DatingOps] already initialized, skip duplicate load");
    return;
  }
  g.__datingOpsInitDone = true;

  /** ===== 設定 ===== */
  // NOTE:
  // - 開発中はローカル n8n 向き (localhost:5678) を使う。
  // - AbleNet に n8n を立てたら、この配列の中身を
  //   `http://<AbleNetのIP>:5678/webhook/chat` や
  //   `https://datingops.example.com/webhook/chat`
  //   に差し替える想定。
  const WEBHOOKS = [
    "http://localhost:5678/webhook/chat-v2",
    "http://127.0.0.1:5678/webhook/chat-v2",
    // "http://<ABLE_NET_IP>:5678/webhook/chat-v2", // TODO: AbleNet n8n 起動後に有効化する
  ];
  const PANEL_ID = "n8n-ai-panel";
  // 自動送信ポリシー：
  // - ページ表示時に 1 回だけ自動で n8n に投げて返信欄に挿入
  // - 新着男性検知などによる追加自動送信は一切しない
  const AUTO_SEND_ON_LOAD = true;
  const AUTO_SEND_ON_NEW_MALE = false;
  const LOAD_DELAY_MS = 600;
  const RETRY_READ_CHAT = 3;
  const RETRY_READ_GAP = 250;
  const DUP_WINDOW_MS = 10_000; // 同一発話での二重送信抑止窓

  // [2025-11-29j] 自由メモ dirty フラグ（送信時自動保存用）
  let pairMemoDirty = false;
  let pairMemoInitialValue = null;

  /** ===== util ===== */
  const qs = (s, r = document) => r.querySelector(s);
  const qsa = (s, r = document) => [...r.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowMs = () => Date.now();
  const hash = (s) =>
    String(
      (s || "")
        .split("")
        .reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)
    );

  const log = (...a) => console.debug("[DatingOps]", ...a);

  /** ===== 個別送信ページ判定（URL + 返信欄の存在） ===== */
  function isPersonalSendPage() {
    const urlOk = /\/staff\/personalbox/i.test(location.pathname);
    if (!urlOk) return false;
    const sendBtn = qsa('input[type="submit"],button').find((b) =>
      /送信して閉じる/.test(b.value || b.textContent || "")
    );
    const anyTextarea = qsa("textarea").length > 0;
    return !!(sendBtn && anyTextarea);
  }

  /** ===== パネル（ドラッグ可） ===== */
  function ensurePanel() {
    if (qs("#" + PANEL_ID)) return;
    const wrap = document.createElement("div");
    wrap.id = PANEL_ID;
    wrap.style.cssText = `
      position:fixed; right:16px; bottom:16px; z-index:999999;
      width:320px; background:#111; color:#eee; border-radius:12px;
      box-shadow:0 12px 30px rgba(0,0,0,.35); font-family:system-ui,-apple-system,Segoe UI,sans-serif;
    `;
    wrap.innerHTML = `
      <div id="n8n_drag_handle" style="cursor:move;padding:10px 12px; display:flex; align-items:center; gap:8px; border-bottom:1px solid #333;">
        <div style="font-weight:700;">n8n 自動返信</div>
        <div id="n8n_status" style="margin-left:auto;font-size:12px;color:#9aa;">起動</div>
      </div>
      <div style="padding:10px 12px; display:flex; flex-direction:column; gap:8px;">
        <label style="font-size:12px;color:#aaa;">一言プロンプト（任意）</label>
        <textarea id="n8n_prompt" rows="3" placeholder="例）もう少し丁寧に" style="width:100%;resize:vertical;border-radius:8px;border:1px solid #444;background:#1b1b1b;color:#eee;padding:8px;"></textarea>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:12px;color:#aaa;">温度</span>
          <input id="n8n_temp" type="range" min="0" max="2.0" step="0.1" value="0.7" style="flex:1;">
          <span id="n8n_temp_val" style="width:40px;text-align:right;font-size:12px;color:#ccc;">0.7</span>
        </div>
        <div style="display:flex;gap:8px;">
          <button id="n8n_send" style="flex:1;background:#16a34a;border:none;color:#fff;border-radius:8px;padding:10px 12px;font-weight:700;cursor:pointer;">再生成</button>
          <button id="n8n_copy" style="width:84px;background:#333;border:1px solid #444;color:#eee;border-radius:8px;cursor:pointer;">コピー</button>
        </div>
        <div style="margin-top:4px; padding-top:6px; border-top:1px solid #333; display:flex; flex-direction:column; gap:4px;">
          <label style="font-size:11px;color:#aaa;">メモ候補（男性の事実メモ）</label>
          <textarea id="n8n_memo_candidate" rows="3" readonly style="width:100%;resize:vertical;border-radius:8px;border:1px solid #444;background:#181818;color:#9ef;padding:6px;font-size:11px;"></textarea>
          <button id="n8n_copy_memo" style="align-self:flex-end;background:#334155;border:1px solid #475569;color:#e5e7eb;border-radius:8px;padding:4px 8px;font-size:11px;cursor:pointer;">メモにコピー</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    // Drag
    (function dragify(box, handle) {
      let sx = 0,
        sy = 0,
        ox = 0,
        oy = 0,
        dragging = false;
      const onDown = (e) => {
        dragging = true;
        sx = e.clientX;
        sy = e.clientY;
        const r = box.getBoundingClientRect();
        ox = r.left;
        oy = r.top;
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        e.preventDefault();
      };
      const onMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - sx,
          dy = e.clientY - sy;
        box.style.left = ox + dx + "px";
        box.style.top = oy + dy + "px";
        box.style.right = "auto";
        box.style.bottom = "auto";
      };
      const onUp = () => {
        dragging = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      box.style.position = "fixed";
      handle.addEventListener("mousedown", onDown);
    })(wrap, qs("#n8n_drag_handle", wrap));

    qs("#n8n_temp", wrap).addEventListener("input", () => {
      qs("#n8n_temp_val", wrap).textContent = (+qs("#n8n_temp", wrap)
        .value).toFixed(1);
    });
    qs("#n8n_copy", wrap).addEventListener("click", async () => {
      const convo20 = await getConversation20(); // 20件（古→新）
      const clip = `PROMPT:\n${(
        qs("#n8n_prompt")?.value || ""
      ).trim()}\n\nCONVO20:\n${convo20}\n\nPROFILE:\n${getSideInfoText()}`;
      await navigator.clipboard.writeText(clip);
      setStatus("コピーOK", "#4ade80");
    });
    qs("#n8n_send", wrap).addEventListener("click", sendManual);

    // メモコピーボタン: クリップボードにコピー＋ふたりメモ欄に追記
    qs("#n8n_copy_memo", wrap)?.addEventListener("click", async () => {
      const ta = qs("#n8n_memo_candidate", wrap);
      const text = (ta?.value || "").trim();
      if (!text) {
        setStatus("メモ候補なし", "#f59e0b");
        return;
      }
      // クリップボードにコピー
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        console.warn("[DatingOps] clipboard error:", e);
      }
      // ふたりメモ欄に追記
      const memoTa = getPairMemoTextarea();
      if (memoTa) {
        const cur = memoTa.value.trim();
        memoTa.value = cur ? cur + "\n" + text : text;
        ["input", "change", "keyup"].forEach((ev) =>
          memoTa.dispatchEvent(new Event(ev, { bubbles: true }))
        );
        // [2025-11-29i] メモ追記後に自動保存
        savePairMemo("copy-memo");
        setStatus("メモ追記OK", "#4ade80");
      } else {
        setStatus("メモ欄見つからず", "#f59e0b");
      }
    });
  }
  function setStatus(msg, color = "#9aa") {
    const s = qs("#n8n_status");
    if (s) {
      s.textContent = msg;
      s.style.color = color;
    }
  }

  /** ===== メモ候補欄の更新（毎回必ず上書き） ===== */
  // [2025-11-29f] memo_candidate を毎回必ず UI に反映する
  // 空文字や null の場合も必ずクリアする
  function updateMemoCandidateBox(memoCandidateRaw) {
    const box = qs("#n8n_memo_candidate");
    if (!box) {
      log("updateMemoCandidateBox: box not found");
      return;
    }
    // null / undefined → 空文字に強制
    const text = (memoCandidateRaw ?? "").trim();
    // デバッグ用ログ
    console.log("[datingops] memo_candidate from n8n:", memoCandidateRaw, "=>", text);
    // ★毎回必ず上書きする★（前回の値を残さない）
    box.value = text;
  }

  /** ===== 会話ルート推定 ===== */
  // [2025-11-30c] mem44 専用の早期リターンを追加
  function getChatRoot() {
    const hostname = location.hostname || "";

    // mem44 専用: 中央の会話カラムを強制的に root とする
    if (/mem44\.com$/i.test(hostname)) {
      const direct =
        qs("#mm1.inbox.inbox_chat") ||
        qs(".inbox.inbox_chat");
      if (direct) {
        console.debug("[DatingOps] getChatRoot: mem44 direct inbox", direct);
        return direct;
      }
    }

    const sendBtn = qsa('input[type="submit"],button').find((b) =>
      /送信して閉じる/.test(b.value || b.textContent || "")
    );
    if (sendBtn) {
      const host =
        (sendBtn.closest("form") || document).parentElement || document;
      const candidates = [
        qs("#mm1.inbox.inbox_chat", host),
        qs(".inbox.inbox_chat", host),
        host.previousElementSibling,
        host.parentElement?.querySelector(".inbox"),
        document.body,
      ].filter(Boolean);

      let best = null,
        score = -1;
      for (const c of candidates) {
        const cnt = qsa(
          ".mmmsg_char, .mmmsg_member, .mb_M, .mb_L, .message, .talk_row, .msg",
          c
        ).length;
        if (cnt > score) {
          score = cnt;
          best = c;
        }
      }
      return best || document.body;
    }
    return (
      qs("#mm1.inbox.inbox_chat") || qs(".inbox.inbox_chat") || document.body
    );
  }

  /** ===== 会話抽出（memサイト専用クラス判定 + 他サイトはクラス/座標fallback） ===== */
  // [2025-11-29] mem44: 左(緑)=female, 右(白)=male で speaker を判定
  // [2025-11-30] exec-29741 対応: 会話スクレイピングを大幅修正
  // - プロフィールヘッダー（6桁数字で始まる行）を除外
  // - 自由メモ（「自分 :」で始まる行）を除外
  // - speaker 判定を強化（クラス優先 → 座標 fallback）
  // - conversation_long20 にプロフィールやふたりメモが混ざらないこと
  // - 右の白吹き出しが ♂, 左の緑吹き出しが ♀ になること
  // [2025-12-01a] 日付・時間を残す方針に変更、mem44 は el.matches() で確実に判定
  function scrapeConversationRaw() {
    const root = getChatRoot();
    const host = location.hostname || "";
    // [2025-12-01a] mem44 / olv29 を対象
    const isMemSite =
      /mem44\.com$/i.test(host) ||
      /olv29\.com$/i.test(host);

    // [修正1] 左右サイドカラムを除外対象として取得
    // これらに含まれる要素は会話から除外する（プロフィール・ふたりメモなど）
    const sideBlocks = [
      qs(".left_col") || qs(".キャラ情報") || qs(".char_info"),
      qs(".right_col") || qs(".ユーザー情報") || qs(".user_info"),
    ].filter(Boolean);

    // [2025-11-30d] memサイトは吹き出しクラスのみ、他サイトは広めに取得
    let nodes;
    if (isMemSite) {
      // memサイト専用: 吹き出しクラスのみを取得対象に
      nodes = qsa(".mmmsg_char, .mmmsg_member, .mb_M, .mb_L", root);
    } else {
      // 他サイト: 広めに取得
      nodes = qsa(
      "div.mb_M, div.mb_L, .mmmsg_char, .mmmsg_member, .message, .talk_row, .msg",
      root
    );
    }
    nodes = nodes.filter((el) => (el.innerText || "").trim());

    log("会話ノード数:", nodes.length, "root:", root?.className || root?.id || "body", "isMemSite:", isMemSite);

    // 会話カラムの中央X座標を計算（非memサイトの座標fallback用）
    const chatRect = root.getBoundingClientRect?.() || {
      left: 0,
      right: window.innerWidth,
    };
    const chatMidX = (chatRect.left + chatRect.right) / 2;
    log("chatMidX:", chatMidX, "chatRect:", chatRect.left, "-", chatRect.right);

    const lines = [];
    for (const el of nodes) {
      // [修正1続き] サイドカラムに属する要素は会話から除外
      if (sideBlocks.some((b) => b.contains(el))) {
        log("サイドカラム除外:", el.innerText?.slice(0, 30));
        continue;
      }

      const raw = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (!raw) continue;

      // [2025-11-30] exec-29741 対応: プロフィールヘッダーを除外
      // 「769706 ゆき (42) 完全可変 千葉県...」のような6桁数字で始まる行
      if (/^\d{6}\s/.test(raw)) {
        log("プロフィールヘッダー除外:", raw.slice(0, 40));
        continue;
      }

      // [2025-11-30] exec-29741 対応: 自由メモ欄のテキストを除外
      // 「自分 : 相手 : 仕事 : Webマーケティング...」のようなパターン
      if (/^自分\s*:/.test(raw)) {
        log("自由メモ除外:", raw.slice(0, 40));
        continue;
      }

      // クラス名は大文字小文字両方でチェック（元のクラス名を保持）
      const clsOriginal = el.className || "";

      // 要素の中央X座標を計算（非memサイトの座標fallback用）
      const rect = el.getBoundingClientRect?.() || { left: 0, width: 0 };
      const centerX = rect.left + rect.width / 2;
      const isRightSide = centerX > chatMidX;

      // [2025-12-01a] 役割判定：mem44 は el.matches() で確実に、他サイトは regex + 座標 fallback
      let isMale = null;
      let detectionMethod = "";

      // 1) mem44 用のクラスベース判定（最優先・el.matches() で確実に判定）
      if (isMemSite) {
        if (el.matches("div.mb_M, .mmmsg_member")) {
        isMale = true;
          detectionMethod = "mem44 class (mb_M/mmmsg_member)";
        } else if (el.matches("div.mb_L, .mmmsg_char")) {
          isMale = false;
          detectionMethod = "mem44 class (mb_L/mmmsg_char)";
        }
      }

      // 2) まだ決まっていなければ、従来のクラス判定（他サイト含む）
      if (isMale === null) {
        if (/\bmb_m\b/i.test(clsOriginal) || /\bmmmsg_member\b/i.test(clsOriginal)) {
          isMale = true;
          detectionMethod = "class regex (mb_M/mmmsg_member)";
        } else if (/\bmb_l\b/i.test(clsOriginal) || /\bmmmsg_char\b/i.test(clsOriginal)) {
        isMale = false;
          detectionMethod = "class regex (mb_L/mmmsg_char)";
        }
      }

      // 3) それでも決まらない場合だけ座標 fallback を使う
      if (isMale === null) {
        isMale = isRightSide;
        detectionMethod = `fallback position(centerX=${Math.round(centerX)}, midX=${Math.round(chatMidX)})`;
      }

      log(`判定: ${isMale ? "♂男" : "♀女"} [${detectionMethod}] cls="${clsOriginal}" text="${raw.slice(0, 20)}..."`);

      // 管理テキスト類は conversation から除外する（※サイドへは別途収集）
      const isAdminMeta =
        /(管理者メモ|自己紹介文|使用絵文字・顔文字|残り\s*\d+\s*pt|入金|本登録|最終アクセス|累計送信数|返信文グループ|自由メモ|ジャンル|エロ・セフレ募集系|ポイント残高|ふたりメモ|キャラ情報|ユーザー情報)/.test(
          raw
        );
      if (isAdminMeta) {
        log("管理テキスト除外:", raw.slice(0, 30));
        continue;
      }

      // [2025-12-01a] 日付・時間は削らない方針に変更
      // 「11/30 23:06 いいよ！俺に決めてくれ！」→ そのまま AI に渡す
      // 削るのは「開封済み」のみ（明らかにノイズ）
      const text = raw
        .replace(/開封済み/g, "")
        .trim();
      if (!text) continue;

      const who = isMale ? "♂" : "♀";
      lines.push(`${who} ${text}`);
    }

    log("抽出結果:", lines.length, "件", lines.map(l => l.slice(0, 30)));

    // [2025-11-30] デバッグログ: 直近6件をサンプル表示
    console.log("[DatingOps] scrapeConversationRaw sample:", lines.slice(-6));

    // DOM 順＝古→新の前提で、最後の20件を保持（さらに後で6件切り出し）
    return lines.slice(-20);
  }

  async function getConversation20() {
    for (let i = 0; i < RETRY_READ_CHAT; i++) {
      const arr = scrapeConversationRaw();
      if (arr.length) return arr.join("\n");
      await sleep(RETRY_READ_GAP);
    }
    return scrapeConversationRaw().join("\n");
  }

  function mapLineToStructuredEntry(line) {
    if (!line) return null;
    const symbol = line[0] || "";
    let speaker = "unknown";
    if (symbol === "♂") speaker = "male";
    else if (symbol === "♀") speaker = "female";
    else if (/管理|system/i.test(symbol)) speaker = "system";

    const text = line.replace(/^.[\s]*/, "").trim();
    return text ? { speaker, text, timestamp: null } : null;
  }

  function buildStructuredConversation(lines) {
    return lines
      .map(mapLineToStructuredEntry)
      .filter((entry) => entry && entry.text);
  }

  function getSiteId() {
    const host = location.hostname || "";
    if (!host) return "";
    return host.split(".")[0] || host;
  }

  function getThreadId() {
    const selectors = [
      'input[name*="thread" i]',
      'input[id*="thread" i]',
      'input[name*="messageid" i]',
      'input[id*="messageid" i]',
    ];
    for (const sel of selectors) {
      const el = qs(sel);
      const val = el?.value?.trim();
      if (val) return val;
    }
    const searchMatch = location.search.match(
      /(?:thread|msg|id)=([A-Za-z0-9_-]{4,})/i
    );
    if (searchMatch) return searchMatch[1];
    const pathMatch = location.pathname.match(/(\d{4,})/);
    if (pathMatch) return pathMatch[1];
    return null;
  }

  function getToneSetting() {
    const select = qs('select[name*="tone" i], select[id*="tone" i]');
    const btn = qs('[data-tone]');
    const input = qs('input[name*="tone" i]:checked');
    const val =
      select?.value?.trim() ||
      input?.value?.trim() ||
      btn?.dataset?.tone?.trim() ||
      "";
    return val || null;
  }

  function getBlueStage() {
    const el =
      qs("[data-blue-stage]") ||
      qs('[name*="blue" i]:checked') ||
      qs('[id*="blue" i][data-stage]');
    const val =
      el?.dataset?.blueStage ||
      el?.dataset?.stage ||
      el?.value ||
      el?.textContent ||
      "";
    return val ? val.trim().toLowerCase() : null;
  }

  function getLastUtteranceSync() {
    const arr = scrapeConversationRaw(); // すでに古→新の最新20件
    const last = arr[arr.length - 1] || "";
    const who = last.startsWith("♂") ? "M" : last.startsWith("♀") ? "F" : "";
    const text = last.replace(/^.[\s]*/, "");
    return { who, text, fp: hash(last) };
  }

  /** ===== ふたりメモ alert パッチ（ダイアログ抑制） ===== */
  // [2025-11-29i] 「ふたりメモを更新しました。」のアラートを自動スキップ
  function patchPairMemoAlertOnce() {
    try {
      const w = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
      if (!w || w.__datingOpsAlertPatched) return;
      const originalAlert = w.alert;
      if (typeof originalAlert !== "function") return;
      w.alert = function patchedAlert(message) {
        try {
          if (typeof message === "string" && message.indexOf("ふたりメモを更新しました") !== -1) {
            console.log("[DatingOps] auto-skip pair memo alert:", message);
            // 何もしない = ダイアログを出さずに終了
            return;
          }
        } catch (e) {
          console.warn("[DatingOps] patchedAlert error", e);
        }
        // それ以外の alert は元の挙動のまま
        return originalAlert.call(this, message);
      };
      w.__datingOpsAlertPatched = true;
      console.log("[DatingOps] patched window.alert for pair memo");
    } catch (e) {
      console.warn("[DatingOps] patchPairMemoAlertOnce failed", e);
    }
  }

  /** ===== ふたりメモ「更新」ボタンを探す ===== */
  function findPairMemoUpdateButton(textarea) {
    if (!textarea) return null;
    // ふたりメモのセルを起点にボタンを探す
    let cell = textarea.closest("td");
    if (cell) {
      const btnInCell = cell.querySelector('input[type="button"][value="更新"], input[type="submit"][value="更新"]');
      if (btnInCell) return btnInCell;
    }
    // 近くの「ふたりメモ」カラム内からボタンを探す
    let col = textarea.closest("td.freemmobg_gray, td.freememobg_gray, td.freememo_bg_gray, td.freememo_bg_gray_pd0");
    if (col) {
      const btnInCol = col.querySelector('input[type="button"][value="更新"], input[type="submit"][value="更新"]');
      if (btnInCol) return btnInCol;
    }
    // フォールバック: ページ全体から「更新」ボタンを拾うが、ふたりメモ領域に近いものを優先
    const allButtons = document.querySelectorAll('input[type="button"][value="更新"], input[type="submit"][value="更新"]');
    if (!allButtons.length) return null;
    let best = null;
    let bestScore = -Infinity;
    for (const btn of allButtons) {
      let score = 0;
      // ふたりメモ領域っぽい class/name の近くならスコア加点
      const parentTd = btn.closest("td");
      if (parentTd) {
        const txt = parentTd.textContent || "";
        if (txt.indexOf("ふたりメモ") !== -1 || txt.indexOf("ユーザー通算数") !== -1) score += 3;
        if (parentTd.className && parentTd.className.indexOf("freememo") !== -1) score += 5;
      }
      // textarea からの距離が近いほど加点
      if (textarea && textarea.parentElement && btn.parentElement) {
        const taRect = textarea.getBoundingClientRect();
        const btnRect = btn.getBoundingClientRect();
        const dy = Math.abs(taRect.top - btnRect.top);
        if (dy < 200) score += 2;
        if (dy < 100) score += 2;
      }
      if (score > bestScore) {
        bestScore = score;
        best = btn;
      }
    }
    return best;
  }

  /** ===== ふたりメモを自動保存 ===== */
  // [2025-11-29j] コールバック対応＋dirty フラグリセット
  function savePairMemo(reason, onDone) {
    try {
      const textarea = getPairMemoTextarea && getPairMemoTextarea();
      if (!textarea) {
        console.log("[DatingOps] savePairMemo: textarea not found", reason);
        onDone && onDone();
        return;
      }
      const btn = findPairMemoUpdateButton(textarea);
      if (!btn) {
        console.log("[DatingOps] savePairMemo: update button not found", reason);
        onDone && onDone();
        return;
      }
      console.log("[DatingOps] auto-click pair memo update button:", reason);
      btn.click();
      // 保存後に dirty フラグをリセット＆初期値を更新
      pairMemoInitialValue = textarea.value;
      pairMemoDirty = false;
      // alert パッチにより同期的に処理されるので、少し待ってからコールバック
      if (onDone) {
        setTimeout(onDone, 100);
      }
    } catch (e) {
      console.warn("[DatingOps] savePairMemo error", e);
      onDone && onDone();
    }
  }

  /** ===== 自由メモ変更監視（dirty フラグ管理） ===== */
  // [2025-11-29j] 自由メモの変更を監視し、dirty フラグを立てる
  function watchPairMemoChanges() {
    const ta = getPairMemoTextarea();
    if (!ta) {
      console.log('[DatingOps] watchPairMemoChanges: textarea not found');
      return;
    }
    if (ta.dataset.n8nWatched === '1') return;
    ta.dataset.n8nWatched = '1';

    pairMemoInitialValue = ta.value;
    pairMemoDirty = false;

    ta.addEventListener('input', () => {
      // 値が初期値と違えば dirty 扱い
      pairMemoDirty = (ta.value !== pairMemoInitialValue);
    });
    console.log('[DatingOps] watchPairMemoChanges: watching textarea for changes');
  }

  /** ===== 「送信して閉じる」ボタンを探す ===== */
  function getSendAndCloseButton() {
    const selectors = [
      'input[type="submit"][value="送信して閉じる"]',
      'input[type="button"][value="送信して閉じる"]',
      'button[value="送信して閉じる"]',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn) return btn;
    }
    return null;
  }

  /** ===== 送信ボタン押下時に自動保存するフック ===== */
  // [2025-11-29j] dirty なら先に保存してから送信
  function hookSendButtonAutoSave() {
    const sendBtn = getSendAndCloseButton();
    if (!sendBtn) {
      console.log('[DatingOps] hookSendButtonAutoSave: send button not found');
      return;
    }
    if (sendBtn.dataset.n8nMemoHooked === '1') return;
    sendBtn.dataset.n8nMemoHooked = '1';

    sendBtn.addEventListener('click', (ev) => {
      // dirty でなければ何もしない（そのまま送信）
      if (!pairMemoDirty) return;

      console.log('[DatingOps] hookSendButtonAutoSave: memo dirty, auto-saving before send');

      ev.preventDefault();
      ev.stopPropagation();

      savePairMemo('before-send', () => {
        console.log('[DatingOps] hookSendButtonAutoSave: memo saved, now send');
        // もう一度クリックして本来の送信処理を実行
        pairMemoDirty = false;
        sendBtn.click();
      });
    }, true); // キャプチャ段階で先に拾う

    console.log('[DatingOps] hookSendButtonAutoSave: hooked send button');
  }

  /** ===== ふたりメモ欄を探す（mem44専用 + 他サイト対応） ===== */
  // [2025-11-29g] mem44 の DOM 構造に最適化
  // <td class="freememo_bg_gray p0b">
  //   <textarea name="memo_free_memo1" ...>
  // </td>
  function getPairMemoTextarea() {
    // 1) mem44 専用: ふたりメモカラム内の自由メモ
    const direct = document.querySelector(
      'td.freememo_bg_gray textarea[name="memo_free_memo1"]'
    );
    if (direct) {
      console.log('[DatingOps] getPairMemoTextarea: found via freememo_bg_gray/name=memo_free_memo1');
      return direct;
    }

    // 2) name 属性優先で fallback
    const byName = document.querySelector('textarea[name="memo_free_memo1"]');
    if (byName) {
      console.log('[DatingOps] getPairMemoTextarea: found via name=memo_free_memo1');
      return byName;
    }

    // 3) それでもダメなら memo/free を含む textarea から一番右側のものを選ぶ
    const candidates = Array.from(
      document.querySelectorAll('textarea[name*="memo"], textarea[id*="memo"], textarea[name*="free"], textarea[id*="free"]')
    );
    if (candidates.length > 0) {
      // 画面右側にあるものほどふたりメモの可能性が高いので、offsetLeft でソート
      const sorted = candidates
        .map(el => ({ el, x: el.getBoundingClientRect().left }))
        .sort((a, b) => a.x - b.x);
      const picked = sorted[sorted.length - 1].el;
      console.log('[DatingOps] getPairMemoTextarea: picked right-most memo-like textarea as fallback', picked);
      return picked;
    }

    console.warn('[DatingOps] getPairMemoTextarea: textarea not found');
    return null;
  }

  /** ===== 自由メモテンプレート自動挿入 ===== */
  // [2025-11-29g] 自由メモ欄が空の場合にだけテンプレを挿入する
  function ensurePairMemoTemplate() {
    try {
      const ta = getPairMemoTextarea();
      if (!ta) {
        console.warn('[DatingOps] ensurePairMemoTemplate: textarea not found, skip');
        return;
      }
      const current = (ta.value || '').trim();
      // すでに何か入っていれば何もしない（勝手に上書きしない）
      if (current.length > 0) {
        console.log('[DatingOps] ensurePairMemoTemplate: already has content, skip');
        return;
      }
      const template = [
        '■アポ■',
        '',
        '',
        '--------------',
        '♂：',
        '',
        '',
        '♀：',
        ''
      ].join('\n');
      ta.value = template;
      // イベントを発火して変更を通知
      ['input', 'change'].forEach(ev =>
        ta.dispatchEvent(new Event(ev, { bubbles: true }))
      );
      console.log('[DatingOps] inserted default pair memo template');
      // [2025-11-29i] テンプレ挿入後に自動保存
      savePairMemo("auto-template");
    } catch (e) {
      console.error('[DatingOps] ensurePairMemoTemplate error', e);
    }
  }

  /** ===== サイド情報（右カラム「ユーザー情報」のみを使用） ===== */
  // [2025-11-29e] profileText は右カラム（男性ユーザー情報）のみを使う
  // 左カラム（キャラ情報）は混ぜない
  // [2025-11-30] exec-29741 対応: ラベルだけでなく実際のプロフィール内容を取得するよう改善
  function getSideInfoText() {
    // mem44 専用: 右側の「ユーザー情報」カラムだけを取得
    // 左側の「キャラ情報」は含めない（他ユーザーの情報が混ざるのを防ぐ）

    let userInfoContent = "";

    // [2025-11-30] 方法1: 「ユーザー情報」ラベルを探して、その兄弟/親から実データを取得
    const allElements = qsa("td, th, div, span, h2, h3, b, strong");
    for (const el of allElements) {
      const labelText = (el.textContent || "").trim();
      // 「ユーザー情報」というラベルを見つけた
      if (labelText === "ユーザー情報" || labelText === "会員情報") {
        log("ユーザー情報ラベル発見:", el.tagName, labelText);

        // 方法1a: 同じ行（tr）の次のセルを探す
        const parentRow = el.closest("tr");
        if (parentRow) {
          const cells = qsa("td", parentRow);
          for (const cell of cells) {
            if (cell !== el && !cell.contains(el)) {
              const cellText = (cell.innerText || "").trim();
              if (cellText && cellText !== labelText && cellText.length > 10) {
                userInfoContent = cellText;
                log("同行セルからプロフィール取得:", cellText.slice(0, 50));
                break;
              }
            }
          }
        }

        // 方法1b: 次の兄弟要素を探す
        if (!userInfoContent) {
          let sibling = el.nextElementSibling;
          while (sibling && !userInfoContent) {
            const sibText = (sibling.innerText || "").trim();
            if (sibText && sibText.length > 10) {
              userInfoContent = sibText;
              log("兄弟要素からプロフィール取得:", sibText.slice(0, 50));
            }
            sibling = sibling.nextElementSibling;
          }
        }

        // 方法1c: 親要素の中で、ラベル以外のテキストを収集
        if (!userInfoContent) {
          const parentBlock = el.closest("td") || el.closest("div");
          if (parentBlock) {
            const fullText = (parentBlock.innerText || "").trim();
            // ラベル部分を除去
            userInfoContent = fullText.replace(/^(ユーザー情報|会員情報)\s*/i, "").trim();
            if (userInfoContent.length > 10) {
              log("親要素からプロフィール取得:", userInfoContent.slice(0, 50));
            } else {
              userInfoContent = "";
            }
          }
        }

        if (userInfoContent) break;
      }
    }

    // 方法2: クラス名で探す（フォールバック）
    if (!userInfoContent) {
      const userInfoBlock = qs(".right_col") || qs(".user_info");
      if (userInfoBlock) {
        userInfoContent = (userInfoBlock.innerText || "").trim();
        log("クラス名からプロフィール取得:", userInfoContent.slice(0, 50));
      }
    }

    // 方法3: テーブルの右端カラムを探す（mem44 の3カラムレイアウト）
    if (!userInfoContent) {
      const tables = qsa("table");
      for (const table of tables) {
        const rows = qsa("tr", table);
        for (const row of rows) {
          const cells = qsa("td", row);
          if (cells.length >= 3) {
            // 3カラム以上のテーブルの右端を使う
            const rightCell = cells[cells.length - 1];
            const txt = (rightCell.innerText || "").trim();
            // ユーザー情報っぽい内容があるか確認（具体的なデータを含む）
            if (
              (txt.includes("年齢") || txt.includes("都道府県") || txt.includes("職業") || txt.includes("無職")) &&
              txt.length > 20
            ) {
              userInfoContent = txt;
              log("テーブル右端からプロフィール取得:", txt.slice(0, 50));
              break;
            }
          }
        }
        if (userInfoContent) break;
      }
    }

    // [2025-11-30] 不要なラベルを除去
    if (userInfoContent) {
      userInfoContent = userInfoContent
        .replace(/^(ユーザー情報|会員情報|管理者メモ)\s*/gi, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    if (!userInfoContent || userInfoContent.length < 10) {
      log("ユーザー情報ブロックが見つかりません、または内容が少なすぎます");
      return "(ユーザー情報なし)";
    }

    // [2025-11-30] デバッグログ
    console.log("[DatingOps] sideInfoText:", userInfoContent.slice(0, 200));

    return userInfoContent;
  }

  function getCityFromSide() {
    const t = getSideInfoText();
    const m = t.match(
      /(北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)[^\n ]*/
    );
    return m ? m[0].trim() : "";
  }
  function getPartnerNameFromSide() {
    const t = getSideInfoText();
    const m = t.match(
      /\b([A-Za-zぁ-んァ-ヶ一-龠々ー][A-Za-zぁ-んァ-ヶ一-龠々ー0-9._-]{1,24})\b/
    );
    return m ? m[1] : "";
  }
  function getOperatorIdFromSide() {
    const t = getSideInfoText();
    const m = t.match(/\b(\d{5,7})\b/);
    return m ? m[1] : "";
  }

  /** ===== 返信欄 ===== */
  function pickReplyTextarea() {
    const sendBtn = qsa('input[type="submit"],button').find((b) =>
      /送信して閉じる/.test(b.value || b.textContent || "")
    );
    const form = sendBtn ? sendBtn.closest("form") || null : null;

    if (form) {
      const direct = form.querySelector(
        'textarea[name*="message" i], textarea[id*="message" i]'
      );
      if (direct) return direct;
      const t2 = [...form.querySelectorAll("textarea")][0];
      if (t2) return t2;
    }
    const all = [...document.querySelectorAll("textarea")];
    if (!all.length) return null;
    if (!sendBtn) return all[0];
    const sb = sendBtn.getBoundingClientRect();
    return (
      all.reduce((best, ta) => {
        const r = ta.getBoundingClientRect();
        const d = Math.hypot(
          (r.left + r.right) / 2 - (sb.left + sb.right) / 2,
          r.bottom - sb.top
        );
        return !best || d < best.d ? { el: ta, d } : best;
      }, null)?.el || null
    );
  }
  function insertReply(text) {
    if (!text) return false;
    const ta = pickReplyTextarea();
    if (!ta) return false;
    // 手動操作前提なので、常に上書きして OK
    ta.focus();
    ta.value = text;
    ["input", "change", "keyup"].forEach((ev) =>
      ta.dispatchEvent(new Event(ev, { bubbles: true }))
    );
    try {
      ta.selectionStart = ta.selectionEnd = ta.value.length;
    } catch {}
    return true;
  }

  /** ===== 送信（フェイルオーバ） ===== */
  function postJSONWithFallback(payload) {
    const data = JSON.stringify(payload);
    const tryOne = (url) =>
      new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "POST",
          url,
          data,
          headers: { "Content-Type": "application/json" },
          timeout: 20000,
          onload: (res) => {
            console.log(
              "[DatingOps] n8n response:",
              url,
              res.status,
              res.responseText
            );
            if (res.status >= 200 && res.status < 300) {
              try {
                resolve(JSON.parse(res.responseText || "{}"));
              } catch {
                resolve({ ok: true, raw: res.responseText });
              }
            } else
              reject(
                new Error("HTTP " + res.status + " " + (res.responseText || ""))
              );
          },
          onerror: (err) => {
            console.error("[DatingOps] n8n request error:", url, err);
            reject(new Error("GM_xhr onerror"));
          },
          ontimeout: () => {
            console.error("[DatingOps] n8n request timeout:", url);
            reject(new Error("GM_xhr timeout"));
          },
        });
      });

    let p = Promise.reject(new Error("init"));
    WEBHOOKS.forEach((u, i) => {
      p = p.catch(() => tryOne(u));
    });
    return p;
  }

  async function buildWebhookPayload() {
    const convoLines = (await getConversation20()).split("\n").filter(Boolean);
    const structured20 = buildStructuredConversation(convoLines);

    // [2025-11-29e] 直近6件 = structured20 の末尾6件（新しい方から）
    const short6 = structured20.slice(-6);

    const profileText = getSideInfoText() || "";

    // デバッグログ: n8n の INPUT と比較しやすくする
    log("[mem44] conv6:", short6);
    log("[mem44] conv20:", structured20);
    log("[mem44] profileText:", profileText.slice(0, 100) + "...");

    return {
      site: getSiteId(),
      threadId: getThreadId(),
      tone: getToneSetting(),
      blueStage: getBlueStage(),
      conversation: short6,
      conversation_long20: structured20,
      profileText,
    };
  }

  async function sendManual() {
    setStatus("送信中…", "#ffa94d");
    try {
      const payload = await buildWebhookPayload();
      console.log("[DatingOps] sending payload to n8n:", payload);
      const res = await postJSONWithFallback(payload);
      setStatus("ok (200)", "#4ade80");
      const reply =
        res?.reply || // n8n標準レスポンス（優先）
        res?.text || // 旧バージョン互換
        res?.message || // 別形式
        res?.choices?.[0]?.message?.content || // OpenAI直呼び出し
        "";
      if (reply) {
        const ok = insertReply(reply);
        setStatus(ok ? "挿入OK" : "挿入NG", ok ? "#4ade80" : "#f87171");
      } else {
        setStatus("応答空", "#f59e0b");
      }

      // メモ候補をパネルに表示（毎回必ず上書き）
      updateMemoCandidateBox(res?.memo_candidate);
    } catch (e) {
      setStatus("送信失敗", "#f87171");
      console.warn("[DatingOps] send error:", e);
      alert("n8n送信エラー：" + (e?.message || e));
    }
  }

  /** ===== 自動送信：ページロード時に 1 回だけ実行 ===== */
  function mountAuto() {
    if (!AUTO_SEND_ON_LOAD) {
      log("auto-send disabled: mountAuto noop (manual send only)");
      return;
    }

    log("auto-send: run once on load");
    setStatus("初回送信…", "#ffa94d");

    (async () => {
      try {
        const payload = await buildWebhookPayload();
        console.log("[DatingOps] sending payload to n8n (auto-on-load):", payload);
        const res = await postJSONWithFallback(payload);
        setStatus("ok (auto)", "#4ade80");
        const reply =
          res?.reply ||
          res?.text ||
          res?.message ||
          res?.choices?.[0]?.message?.content ||
          "";
        if (reply) {
          insertReply(reply);
        } else {
          setStatus("応答空", "#f59e0b");
        }

        // メモ候補をパネルに表示（毎回必ず上書き）
        updateMemoCandidateBox(res?.memo_candidate);
      } catch (e) {
        setStatus("自動送信失敗", "#f87171");
        console.warn("[DatingOps] auto-send error:", e);
      }
    })();
  }

  // TODO: 動作確認チェックリスト
  // [2025-11-29f] memo_candidate 上書きバグ修正の確認:
  // - Aさんの個別送信ページを開く（メモ候補が「X」に見える）
  // - Bさんのページを開く：Console に新しい [datingops] memo_candidate ... ログが出ている
  // - Bさんで memo_candidate が空の場合、右下パネルのメモ候補欄が 完全に空 になる
  // - 再度 Aさんページに戻ったとき、Aさん用のログと候補が正しく出る（Bさんの値が残らない）
  // - mem44 個別送信ページを開いた瞬間：
  //   - n8n に 1 execution が走ること
  //   - 返信欄に AI 文が自動で挿入されること
  //   - パネルの「メモ候補」に何かしらのテキストが入ること（なければ空）
  // - パネルの「再生成」ボタンを押すと：
  //   - 返信欄が上書きされること
  //   - メモ候補が更新されること
  // - 「メモにコピー」ボタンを押すと：
  //   - クリップボードにメモ候補がコピーされること
  //   - ふたりメモ欄に追記されること（DOM 構造が変わらない限り）

  /** ===== Main ===== */
  (async function init() {
    if (!isPersonalSendPage()) {
      log("skip: not personalbox");
      return;
    }

    // [2025-12-01a] 同一ページでの二重初期化防止
    if (window.__datingOpsInitialized) {
      console.debug("[DatingOps] skip: already initialized in init()");
      return;
    }
    window.__datingOpsInitialized = true;

    // [2025-11-29i] ふたりメモ更新アラートをパッチ（ダイアログ抑制）
    patchPairMemoAlertOnce();

    // レイアウト安定待ち
    for (let i = 0; i < 5; i++) await sleep(150);
    ensurePanel();
    const t = qs("#n8n_temp"),
      tv = qs("#n8n_temp_val");
    if (t && tv) tv.textContent = (+t.value).toFixed(1);

    // [2025-11-29] 自由メモが空のときはテンプレートを挿入
    ensurePairMemoTemplate();

    // [2025-11-29j] 自由メモ変更監視＆送信ボタンフック
    watchPairMemoChanges();
    hookSendButtonAutoSave();

    mountAuto();
    log("ready.");
  })();
})();
