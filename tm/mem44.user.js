// ==UserScript==
// @name         MEM44 Auto-Reply AI Assistant
// @namespace    tamper-datingops
// @version      2.3
// @description  mem44 個別送信用のAIパネル（元のDatingOps Panelと同等機能）
// @author       coogee2033
// @match        https://mem44.com/*
// @downloadURL  https://raw.githubusercontent.com/coogee2033-blip/datingops-userscripts/main/tm/mem44.user.js
// @updateURL    https://raw.githubusercontent.com/coogee2033-blip/datingops-userscripts/main/tm/mem44.user.js
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @connect      127.0.0.1
// @connect      192.168.*.*
// @run-at       document-idle
// ==/UserScript==

/*
  === mem44 専用 Tampermonkey スクリプト ===
  元の DatingOps Panel（n8n-chat-ops/datingops.user.js）から分離。
  今後は datingops-userscripts/tm/ で管理する。
  OLV 用は別ファイル（tm/olv29.user.js）で管理。
*/

console.log("MEM44 Auto-Reply AI Assistant v2.3");

(() => {
  "use strict";

  // iframe 内では動かさない
  if (window.top !== window.self) {
    console.debug("[DatingOps] skip: in iframe");
    return;
  }

  // 二重実行ガード（IIFE レベル）
  const g = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  if (g.__datingOpsInitDone) {
    console.log("[DatingOps] already initialized, skip duplicate load");
    return;
  }
  g.__datingOpsInitDone = true;

  /** ===== 設定 ===== */
  const WEBHOOKS = [
    "http://localhost:5678/webhook/chat-v2",
    "http://127.0.0.1:5678/webhook/chat-v2",
  ];
  // メモ更新専用 Webhook （ホストは WEBHOOKS を流用、パスだけ差し替え）
  const MEMO_WEBHOOKS = WEBHOOKS.map((u) =>
    u.replace(/\/chat-v2$/, "/memo-update")
  );
  const PANEL_ID = "n8n-ai-panel";
  const AUTO_SEND_ON_LOAD = true;
  const AUTO_SEND_ON_NEW_MALE = false;
  const LOAD_DELAY_MS = 600;
  const RETRY_READ_CHAT = 3;
  const RETRY_READ_GAP = 250;
  const DUP_WINDOW_MS = 10_000;

  // 自由メモ dirty フラグ（送信時自動保存用）
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
      position:fixed; left:16px; bottom:16px; z-index:999999;
      width:320px; background:#111; color:#eee; border-radius:12px;
      box-shadow:0 12px 30px rgba(0,0,0,.35); font-family:system-ui,-apple-system,Segoe UI,sans-serif;
    `;
    wrap.innerHTML = `
      <div id="n8n_drag_handle" style="cursor:move;padding:10px 12px; display:flex; align-items:center; gap:8px; border-bottom:1px solid #333;">
        <div style="font-weight:700;">MEM44 自動返信</div>
        <button id="n8n_close_btn" style="margin-left:auto; background:transparent; border:none; color:#888; font-size:14px; cursor:pointer; padding:0 4px;">✕</button>
        <div id="n8n_status" style="font-size:12px; color:#9aa; margin-left:4px;">起動</div>
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
          <div style="display:flex;justify-content:flex-end;gap:6px;">
            <button id="n8n_copy_memo" style="background:#334155;border:1px solid #475569;color:#e5e7eb;border-radius:8px;padding:4px 8px;font-size:11px;cursor:pointer;">メモにコピー</button>
            <button id="n8n_memo_update" style="background:#7c3aed;border:1px solid #a855f7;color:#f9fafb;border-radius:8px;padding:4px 8px;font-size:11px;cursor:pointer;">メモ更新</button>
          </div>
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

    // ✕ ボタンでパネルを閉じる
    const closeBtn = qs("#n8n_close_btn", wrap);
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        wrap.style.display = "none";
      });
    }

    qs("#n8n_temp", wrap).addEventListener("input", () => {
      qs("#n8n_temp_val", wrap).textContent = (+qs("#n8n_temp", wrap)
        .value).toFixed(1);
    });
    qs("#n8n_copy", wrap).addEventListener("click", async () => {
      const convo20 = await getConversation20();
      const clip = `PROMPT:\n${(
        qs("#n8n_prompt")?.value || ""
      ).trim()}\n\nCONVO20:\n${convo20}\n\nPROFILE:\n${getSideInfoText()}`;
      await navigator.clipboard.writeText(clip);
      setStatus("コピーOK", "#4ade80");
    });
    qs("#n8n_send", wrap).addEventListener("click", sendManual);

    // メモコピーボタン
    qs("#n8n_copy_memo", wrap)?.addEventListener("click", async () => {
      const ta = qs("#n8n_memo_candidate", wrap);
      const text = (ta?.value || "").trim();
      if (!text) {
        setStatus("メモ候補なし", "#f59e0b");
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        console.warn("[DatingOps] clipboard error:", e);
      }
      const memoTa = getPairMemoTextarea();
      if (memoTa) {
        const cur = memoTa.value.trim();
        memoTa.value = cur ? cur + "\n" + text : text;
        ["input", "change", "keyup"].forEach((ev) =>
          memoTa.dispatchEvent(new Event(ev, { bubbles: true }))
        );
        savePairMemo("copy-memo");
        setStatus("メモ追記OK", "#4ade80");
      } else {
        setStatus("メモ欄見つからず", "#f59e0b");
      }
    });

    // メモ更新ボタン
    qs("#n8n_memo_update", wrap)?.addEventListener("click", () => {
      sendMemoUpdate();
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
  function updateMemoCandidateBox(memoCandidateRaw) {
    const box = qs("#n8n_memo_candidate");
    if (!box) {
      log("updateMemoCandidateBox: box not found");
      return;
    }
    const text = (memoCandidateRaw ?? "").trim();
    console.log("[datingops] memo_candidate from n8n:", memoCandidateRaw, "=>", text);
    box.value = text;
  }

  /** ===== 会話ルート推定（mem44専用） ===== */
  function getChatRoot() {
    // mem44 専用: 中央の会話カラムを強制的に root とする
    const direct =
      qs("#mm1.inbox.inbox_chat") ||
      qs(".inbox.inbox_chat");
    if (direct) {
      console.debug("[DatingOps] getChatRoot: mem44 direct inbox", direct);
      return direct;
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

  /** ===== MEM44 speaker 判定ヘルパー ===== */
  function detectSpeaker(el, chatMidX) {
    if (!el) return { speaker: "male", method: "no element" };

    const classNames = (el.className || "") + " " +
      Array.from(el.classList || []).join(" ");
    const classLower = classNames.toLowerCase();

    // 1. MEM44 / OLV 共通クラス判定（最優先）
    if (classLower.includes("mmmsg_char") || classLower.includes("mb_l")) {
      return { speaker: "female", method: "class mmmsg_char/mb_L" };
    }
    if (classLower.includes("mmmsg_member") || classLower.includes("mb_m")) {
      return { speaker: "male", method: "class mmmsg_member/mb_M" };
    }

    // 2. MEM44 固有のクラス（mbR / mbL など）
    if (classLower.includes("mbr") || classLower.includes("msg_r") || classLower.includes("right")) {
      return { speaker: "male", method: "class mbR/msg_r/right" };
    }
    if (classLower.includes("mbl") || classLower.includes("msg_l") || classLower.includes("left")) {
      return { speaker: "female", method: "class mbL/msg_l/left" };
    }

    // 3. 親要素の td の align / text-align で左右判定
    const td = el.closest("td");
    if (td) {
      const align = (td.getAttribute("align") || "").toLowerCase();
      const textAlign = (td.style?.textAlign || "").toLowerCase();
      if (align === "right" || textAlign === "right") {
        return { speaker: "male", method: "td align=right" };
      }
      if (align === "left" || textAlign === "left") {
        return { speaker: "female", method: "td align=left" };
      }
    }

    // 4. 親要素の tr/table の背景色で判定（MEM44特有）
    const tr = el.closest("tr");
    if (tr) {
      const bgColor = (tr.getAttribute("bgcolor") || tr.style?.backgroundColor || "").toLowerCase();
      // 客側（男性）は右側で薄い色、キャラ側（女性）は左側で別色のことが多い
      if (bgColor.includes("e6f") || bgColor.includes("fce") || bgColor.includes("pink")) {
        return { speaker: "female", method: "tr bgcolor pink/fce" };
      }
      if (bgColor.includes("e6e") || bgColor.includes("eef") || bgColor.includes("blue")) {
        return { speaker: "male", method: "tr bgcolor blue/eef" };
      }
    }

    // 5. 座標 fallback（chatMidX より右なら男性）
    if (chatMidX !== undefined) {
      const rect = el.getBoundingClientRect?.() || { left: 0, width: 0 };
      const centerX = rect.left + rect.width / 2;
      if (centerX > chatMidX) {
        return { speaker: "male", method: `position centerX=${Math.round(centerX)} > midX=${Math.round(chatMidX)}` };
      } else {
        return { speaker: "female", method: `position centerX=${Math.round(centerX)} <= midX=${Math.round(chatMidX)}` };
      }
    }

    // 6. 最終 fallback
    return { speaker: "male", method: "default fallback" };
  }

  /** ===== 会話抽出（mem44専用: OLV29と同一構造） ===== */
  function scrapeConversationStructured() {
    const root = getChatRoot();

    // 左右サイドカラムを除外対象として取得
    const sideBlocks = [
      qs(".left_col") || qs(".キャラ情報") || qs(".char_info"),
      qs(".right_col") || qs(".ユーザー情報") || qs(".user_info"),
    ].filter(Boolean);

    // mem44専用: 吹き出しクラスのみを取得対象に
    let nodes = qsa(".mmmsg_char, .mmmsg_member, .mb_M, .mb_L", root);
    nodes = nodes.filter((el) => (el.innerText || "").trim());

    log("会話ノード数:", nodes.length, "root:", root?.className || root?.id || "body");

    // 会話カラムの中央X座標を計算（座標fallback用）
    const chatRect = root.getBoundingClientRect?.() || {
      left: 0,
      right: window.innerWidth,
    };
    const chatMidX = (chatRect.left + chatRect.right) / 2;
    log("chatMidX:", chatMidX, "chatRect:", chatRect.left, "-", chatRect.right);

    // 各メッセージ要素から情報を取得
    const rawMessages = [];
    for (const el of nodes) {
      // サイドカラムに属する要素は会話から除外
      if (sideBlocks.some((b) => b.contains(el))) {
        log("サイドカラム除外:", el.innerText?.slice(0, 30));
        continue;
      }

      const raw = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (!raw) continue;

      // プロフィールヘッダーを除外
      if (/^\d{6}\s/.test(raw)) {
        log("プロフィールヘッダー除外:", raw.slice(0, 40));
        continue;
      }

      // 自由メモ欄のテキストを除外
      if (/^自分\s*:/.test(raw)) {
        log("自由メモ除外:", raw.slice(0, 40));
        continue;
      }

      // 管理テキスト類は conversation から除外する
      const isAdminMeta =
        /(管理者メモ|自己紹介文|使用絵文字・顔文字|残り\s*\d+\s*pt|入金|本登録|最終アクセス|累計送信数|返信文グループ|自由メモ|ジャンル|エロ・セフレ募集系|ポイント残高|ふたりメモ|キャラ情報|ユーザー情報)/.test(raw);
      if (isAdminMeta) {
        log("管理テキスト除外:", raw.slice(0, 30));
        continue;
      }

      const rect = el.getBoundingClientRect?.() || { left: 0, width: 0, top: 0, height: 0 };
      const centerX = rect.left + rect.width / 2;
      const top = rect.top;

      // 日付っぽい "12/03 15:06" を抜き出して epoch に
      let ts = null;
      const m = raw.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
      if (m) {
        const year = new Date().getFullYear();
        const month = Number(m[1]) - 1;
        const day = Number(m[2]);
        const hour = Number(m[3]);
        const minute = Number(m[4]);
        ts = new Date(year, month, day, hour, minute).getTime();
      }

      rawMessages.push({ el, raw, rect, centerX, top, ts });
    }

    log("有効メッセージ数:", rawMessages.length);

    if (rawMessages.length === 0) {
      console.warn("[MEM44] scrapeConversationStructured: no messages found");
      return [];
    }

    // 画面上の縦位置 top でソート
    rawMessages.sort((a, b) => a.top - b.top);

    // 時系列を古い→新しいに揃える（上が古いか新しいかを自動判定）
    let chronological = rawMessages.slice();
    const withTs = chronological.filter((m) => m.ts !== null);
    if (withTs.length >= 2) {
      const firstTs = withTs[0].ts;
      const lastTs = withTs[withTs.length - 1].ts;
      if (firstTs > lastTs) {
        // 画面上部の方が新しい場合は反転
        chronological.reverse();
        console.debug("[MEM44] chronological: reversed by timestamp (top is newer)");
      } else {
        console.debug("[MEM44] chronological: top is oldest");
      }
    } else {
      console.debug("[MEM44] chronological: not enough timestamps, keep visual order (top=oldest)");
    }

    // 構造化配列を作成
    const structured = chronological.map((msg) => {
      // detectSpeaker ヘルパーで speaker を判定
      const { speaker, method } = detectSpeaker(msg.el, chatMidX);

      console.debug(`[MEM44] speaker: ${speaker} [${method}] cls="${msg.el.className || ''}" text="${msg.raw.slice(0, 20)}..."`);

      // 「開封済み」のみ削除
      const text = msg.raw.replace(/開封済み/g, "").trim();

      return {
        speaker,
        text,
        timestamp: null,
      };
    }).filter((entry) => entry.text);

    // デバッグログ
    log("抽出結果:", structured.length, "件");
    const counts = structured.reduce((acc, m) => {
      acc[m.speaker] = (acc[m.speaker] || 0) + 1;
      return acc;
    }, {});
    console.log("[MEM44 DEBUG] speaker breakdown:", counts);
    console.debug("[MEM44] scrapeConversationStructured sample (last 6):", structured.slice(-6));

    return structured;
  }

  /** ===== 旧互換: テキスト形式で会話取得 ===== */
  function scrapeConversationRaw() {
    const structured = scrapeConversationStructured();
    return structured.map((entry) => {
      const who = entry.speaker === "male" ? "♂" : "♀";
      return `${who} ${entry.text}`;
    });
  }

  async function getConversation20Structured() {
    for (let i = 0; i < RETRY_READ_CHAT; i++) {
      const arr = scrapeConversationStructured();
      if (arr.length) return arr.slice(-20);
      await sleep(RETRY_READ_GAP);
    }
    return scrapeConversationStructured().slice(-20);
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
    const arr = scrapeConversationRaw();
    const last = arr[arr.length - 1] || "";
    const who = last.startsWith("♂") ? "M" : last.startsWith("♀") ? "F" : "";
    const text = last.replace(/^.[\s]*/, "");
    return { who, text, fp: hash(last) };
  }

  /** ===== ふたりメモ alert パッチ ===== */
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
            return;
          }
        } catch (e) {
          console.warn("[DatingOps] patchedAlert error", e);
        }
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
    let cell = textarea.closest("td");
    if (cell) {
      const btnInCell = cell.querySelector('input[type="button"][value="更新"], input[type="submit"][value="更新"]');
      if (btnInCell) return btnInCell;
    }
    let col = textarea.closest("td.freemmobg_gray, td.freememobg_gray, td.freememo_bg_gray, td.freememo_bg_gray_pd0");
    if (col) {
      const btnInCol = col.querySelector('input[type="button"][value="更新"], input[type="submit"][value="更新"]');
      if (btnInCol) return btnInCol;
    }
    const allButtons = document.querySelectorAll('input[type="button"][value="更新"], input[type="submit"][value="更新"]');
    if (!allButtons.length) return null;
    let best = null;
    let bestScore = -Infinity;
    for (const btn of allButtons) {
      let score = 0;
      const parentTd = btn.closest("td");
      if (parentTd) {
        const txt = parentTd.textContent || "";
        if (txt.indexOf("ふたりメモ") !== -1 || txt.indexOf("ユーザー通算数") !== -1) score += 3;
        if (parentTd.className && parentTd.className.indexOf("freememo") !== -1) score += 5;
      }
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
      pairMemoInitialValue = textarea.value;
      pairMemoDirty = false;
      if (onDone) {
        setTimeout(onDone, 100);
      }
    } catch (e) {
      console.warn("[DatingOps] savePairMemo error", e);
      onDone && onDone();
    }
  }

  /** ===== 自由メモ変更監視 ===== */
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
  function hookSendButtonAutoSave() {
    const sendBtn = getSendAndCloseButton();
    if (!sendBtn) {
      console.log('[DatingOps] hookSendButtonAutoSave: send button not found');
      return;
    }
    if (sendBtn.dataset.n8nMemoHooked === '1') return;
    sendBtn.dataset.n8nMemoHooked = '1';

    sendBtn.addEventListener('click', (ev) => {
      if (!pairMemoDirty) return;

      console.log('[DatingOps] hookSendButtonAutoSave: memo dirty, auto-saving before send');

      ev.preventDefault();
      ev.stopPropagation();

      savePairMemo('before-send', () => {
        console.log('[DatingOps] hookSendButtonAutoSave: memo saved, now send');
        pairMemoDirty = false;
        sendBtn.click();
      });
    }, true);

    console.log('[DatingOps] hookSendButtonAutoSave: hooked send button');
  }

  /** ===== ふたりメモ欄を探す（mem44専用） ===== */
  function getPairMemoTextarea() {
    const direct = document.querySelector(
      'td.freememo_bg_gray textarea[name="memo_free_memo1"]'
    );
    if (direct) {
      console.log('[DatingOps] getPairMemoTextarea: found via freememo_bg_gray/name=memo_free_memo1');
      return direct;
    }

    const byName = document.querySelector('textarea[name="memo_free_memo1"]');
    if (byName) {
      console.log('[DatingOps] getPairMemoTextarea: found via name=memo_free_memo1');
      return byName;
    }

    const candidates = Array.from(
      document.querySelectorAll('textarea[name*="memo"], textarea[id*="memo"], textarea[name*="free"], textarea[id*="free"]')
    );
    if (candidates.length > 0) {
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
  function ensurePairMemoTemplate() {
    try {
      const ta = getPairMemoTextarea();
      if (!ta) {
        console.warn('[DatingOps] ensurePairMemoTemplate: textarea not found, skip');
        return;
      }
      const current = (ta.value || '').trim();
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
      ['input', 'change'].forEach(ev =>
        ta.dispatchEvent(new Event(ev, { bubbles: true }))
      );
      console.log('[DatingOps] inserted default pair memo template');
      savePairMemo("auto-template");
    } catch (e) {
      console.error('[DatingOps] ensurePairMemoTemplate error', e);
    }
  }

  /** ===== サイド情報（mem44専用: 右カラム「ユーザー情報」のみ） ===== */
  function getSideInfoText() {
    let userInfoContent = "";

    const allElements = qsa("td, th, div, span, h2, h3, b, strong");
    for (const el of allElements) {
      const labelText = (el.textContent || "").trim();
      if (labelText === "ユーザー情報" || labelText === "会員情報") {
        log("ユーザー情報ラベル発見:", el.tagName, labelText);

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

        if (!userInfoContent) {
          const parentBlock = el.closest("td") || el.closest("div");
          if (parentBlock) {
            const fullText = (parentBlock.innerText || "").trim();
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

    if (!userInfoContent) {
      const userInfoBlock = qs(".right_col") || qs(".user_info");
      if (userInfoBlock) {
        userInfoContent = (userInfoBlock.innerText || "").trim();
        log("クラス名からプロフィール取得:", userInfoContent.slice(0, 50));
      }
    }

    if (!userInfoContent) {
      const tables = qsa("table");
      for (const table of tables) {
        const rows = qsa("tr", table);
        for (const row of rows) {
          const cells = qsa("td", row);
          if (cells.length >= 3) {
            const rightCell = cells[cells.length - 1];
            const txt = (rightCell.innerText || "").trim();
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
            console.log("[DatingOps] n8n response:", url, res.status, res.responseText);
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

  // メモ更新用：/memo-update に POST（Featherless memo-flow）
  function postMemoJSONWithFallback(payload) {
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
            console.log("[DatingOps] memo n8n response:", url, res.status, res.responseText);
            if (res.status >= 200 && res.status < 300) {
              try {
                resolve(JSON.parse(res.responseText || "{}"));
              } catch {
                resolve({ ok: true, raw: res.responseText });
              }
            } else {
              reject(
                new Error("HTTP " + res.status + " " + (res.responseText || ""))
              );
            }
          },
          onerror: (err) => {
            console.error("[DatingOps] memo n8n request error:", url, err);
            reject(new Error("GM_xhr onerror"));
          },
          ontimeout: () => {
            console.error("[DatingOps] memo n8n request timeout:", url);
            reject(new Error("GM_xhr timeout"));
          },
        });
      });
    let p = Promise.reject(new Error("init"));
    MEMO_WEBHOOKS.forEach((u) => {
      p = p.catch(() => tryOne(u));
    });
    return p;
  }

  async function buildWebhookPayload() {
    // OLV29と同じ構造: getConversation20Structured() を直接使用
    const structured20 = await getConversation20Structured();

    const short6 = structured20.slice(-6);

    const profileText = getSideInfoText() || "";

    // デバッグ用ログ（speaker 判定の確認用）
    console.log("[MEM44 DEBUG] conversation_long20 sample:", structured20.slice(-3));
    const speakerCounts = structured20.reduce((acc, m) => {
      acc[m.speaker] = (acc[m.speaker] || 0) + 1;
      return acc;
    }, {});
    console.log("[MEM44 DEBUG] speaker breakdown:", speakerCounts);
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
        res?.reply ||
        res?.text ||
        res?.message ||
        res?.choices?.[0]?.message?.content ||
        "";
      if (reply) {
        const ok = insertReply(reply);
        setStatus(ok ? "挿入OK" : "挿入NG", ok ? "#4ade80" : "#f87171");
      } else {
        setStatus("応答空", "#f59e0b");
      }

      updateMemoCandidateBox(res?.memo_candidate);
    } catch (e) {
      setStatus("送信失敗", "#f87171");
      console.warn("[DatingOps] send error:", e);
      alert("n8n送信エラー：" + (e?.message || e));
    }
  }

  // ===== メモ更新ボタン処理（/memo-updateを叩く） =====
  async function sendMemoUpdate() {
    setStatus("メモ更新中…", "#a855f7");
    try {
      // OLV29と同じ構造: getConversation20Structured() を直接使用
      const conversation_long20 = await getConversation20Structured();

      // プロフィール
      const profileText = getSideInfoText() || "";

      // 既存ふたりメモ
      const memoTa = getPairMemoTextarea();
      const existingPairMemo = memoTa ? memoTa.value || "" : "";

      const payload = {
        profileText,
        conversation_long20,
        existingPairMemo,
      };

      console.log("[DatingOps] sending memo payload to n8n:", payload);
      const res = await postMemoJSONWithFallback(payload);
      const memoText = (res && res.memo_candidate) ? String(res.memo_candidate).trim() : "";

      if (memoText) {
        if (memoTa) {
          // ふたりメモ欄に直接反映
          memoTa.value = memoText;
          ["input", "change", "keyup"].forEach((ev) =>
            memoTa.dispatchEvent(new Event(ev, { bubbles: true }))
          );
          // 自動保存フラグと連携
          pairMemoDirty = true;
          savePairMemo("memo-update");
          setStatus("メモ更新OK", "#4ade80");
        } else {
          // メモ欄が取れない場合は、候補欄にだけ反映
          updateMemoCandidateBox(memoText);
          setStatus("メモ候補更新OK", "#4ade80");
        }
      } else {
        setStatus("メモ候補空", "#f59e0b");
      }
    } catch (e) {
      console.warn("[DatingOps] memo update error:", e);
      setStatus("メモ更新失敗", "#f97316");
      alert("メモ更新エラー：" + (e?.message || e));
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

        updateMemoCandidateBox(res?.memo_candidate);
      } catch (e) {
        setStatus("自動送信失敗", "#f87171");
        console.warn("[DatingOps] auto-send error:", e);
      }
    })();
  }

  /** ===== Main ===== */
  (async function init() {
    if (!isPersonalSendPage()) {
      log("skip: not personalbox");
      return;
    }

    // 同一ページでの二重初期化防止
    if (window.__datingOpsInitialized) {
      console.debug("[DatingOps] skip: already initialized in init()");
      return;
    }
    window.__datingOpsInitialized = true;

    // ふたりメモ更新アラートをパッチ
    patchPairMemoAlertOnce();

    // レイアウト安定待ち
    for (let i = 0; i < 5; i++) await sleep(150);
    ensurePanel();
    const t = qs("#n8n_temp"),
      tv = qs("#n8n_temp_val");
    if (t && tv) tv.textContent = (+t.value).toFixed(1);

    // 自由メモが空のときはテンプレートを挿入
    ensurePairMemoTemplate();

    // 自由メモ変更監視＆送信ボタンフック
    watchPairMemoChanges();
    hookSendButtonAutoSave();

    mountAuto();
    log("ready.");
  })();
})();

