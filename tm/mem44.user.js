// ==UserScript==
// @name         MEM44 Auto-Reply AI Assistant
// @namespace    tamper-datingops
// @version      2.7
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

console.log("MEM44 Auto-Reply AI Assistant v2.7");

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
  const PANEL_ID = "datingops-ai-panel";
  const AUTO_SEND_ON_LOAD = true;
  const AUTO_SEND_ON_NEW_MALE = false;
  const LOAD_DELAY_MS = 600;
  const RETRY_READ_CHAT = 3;
  const RETRY_READ_GAP = 250;
  const DUP_WINDOW_MS = 10_000;

  // 自由メモ dirty フラグ（送信時自動保存用）
  let pairMemoDirty = false;
  let pairMemoInitialValue = null;
  let panelUserDragged = false;

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
  function forceAiPanelLayout(panel) {
    const el = panel || qs("#" + PANEL_ID) || qs(".datingops-ai-panel");
    if (!el) return;
    if (panelUserDragged) return;

    const isPersonalBox = location.pathname.includes("/staff/personalbox");
    el.classList.add("datingops-ai-panel");
    el.style.setProperty("position", "fixed", "important");
    el.style.setProperty("box-sizing", "border-box", "important");
    el.style.setProperty("z-index", "999999", "important");

    if (isPersonalBox) {
      el.style.setProperty("left", "8px", "important");
      el.style.removeProperty("right");
      el.style.setProperty("bottom", "16px", "important");
      el.style.setProperty("width", "260px", "important");
      el.style.setProperty("min-width", "260px", "important");
      el.style.setProperty("max-width", "260px", "important");
    } else {
      el.style.setProperty("right", "16px", "important");
      el.style.removeProperty("left");
      el.style.setProperty("bottom", "16px", "important");
      el.style.setProperty("width", "320px", "important");
      el.style.setProperty("min-width", "320px", "important");
      el.style.setProperty("max-width", "320px", "important");
    }
  }

  function ensurePanel() {
    if (qs("#" + PANEL_ID)) return;
    const wrap = document.createElement("div");
    wrap.id = PANEL_ID;
    wrap.classList.add("datingops-ai-panel");
    wrap.style.cssText = `
      position:fixed; z-index:999999;
      background:#111; color:#eee; border-radius:12px;
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
    forceAiPanelLayout(wrap);

    let layoutTimer = null;
    const scheduleLayout = () => {
      if (panelUserDragged) return;
      if (layoutTimer) clearTimeout(layoutTimer);
      layoutTimer = setTimeout(() => forceAiPanelLayout(wrap), 120);
    };
    window.addEventListener("resize", scheduleLayout);
    window.addEventListener("scroll", scheduleLayout);

    // Drag
    (function dragify(box, handle) {
      let sx = 0,
        sy = 0,
        ox = 0,
        oy = 0,
        dragging = false;
      const onDown = (e) => {
        dragging = true;
        panelUserDragged = true;
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

    // 1. クラス名による最優先判定（mmsg_char / mmsg_member）
    //    ※ classList.contains を使って正確にマッチ
    if (el.classList && el.classList.contains("mmsg_char")) {
      return { speaker: "female", method: "class mmsg_char" };
    }
    if (el.classList && el.classList.contains("mmsg_member")) {
      return { speaker: "male", method: "class mmsg_member" };
    }

    // 2. フォールバック: className 文字列での判定（旧形式互換）
    const classNames = (el.className || "") + " " +
      Array.from(el.classList || []).join(" ");
    const classLower = classNames.toLowerCase();

    if (classLower.includes("mmsg_char") || classLower.includes("mb_l")) {
      return { speaker: "female", method: "class mmsg_char/mb_L (string)" };
    }
    if (classLower.includes("mmsg_member") || classLower.includes("mb_m")) {
      return { speaker: "male", method: "class mmsg_member/mb_M (string)" };
    }

    // 3. MEM44 固有のクラス（mbR / mbL など）
    if (classLower.includes("mbr") || classLower.includes("msg_r") || classLower.includes("right")) {
      return { speaker: "male", method: "class mbR/msg_r/right" };
    }
    if (classLower.includes("mbl") || classLower.includes("msg_l") || classLower.includes("left")) {
      return { speaker: "female", method: "class mbL/msg_l/left" };
    }

    // 4. 親要素の td の align / text-align で左右判定
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

    // 5. 親要素の tr/table の背景色で判定（MEM44特有）
    const tr = el.closest("tr");
    if (tr) {
      const bgColor = (tr.getAttribute("bgcolor") || tr.style?.backgroundColor || "").toLowerCase();
      if (bgColor.includes("e6f") || bgColor.includes("fce") || bgColor.includes("pink")) {
        return { speaker: "female", method: "tr bgcolor pink/fce" };
      }
      if (bgColor.includes("e6e") || bgColor.includes("eef") || bgColor.includes("blue")) {
        return { speaker: "male", method: "tr bgcolor blue/eef" };
      }
    }

    // 6. 座標 fallback（chatMidX より右なら男性）
    if (chatMidX !== undefined) {
      const rect = el.getBoundingClientRect?.() || { left: 0, width: 0 };
      const centerX = rect.left + rect.width / 2;
      if (centerX > chatMidX) {
        return { speaker: "male", method: `position centerX=${Math.round(centerX)} > midX=${Math.round(chatMidX)}` };
      } else {
        return { speaker: "female", method: `position centerX=${Math.round(centerX)} <= midX=${Math.round(chatMidX)}` };
      }
    }

    // 7. 最終 fallback
    return { speaker: "male", method: "default fallback" };
  }

  /**
   * ===== 会話抽出（MEM44 専用: シンプル版） =====
   * mmsg_char / mmsg_member クラスだけで男女判定
   * 返り値: { all, last6, last20 }
   */
  function scrapeConversationStructured(rootOverride) {
    const root = rootOverride || getChatRoot() || document;

    // mmsg_char（キャラ=女性）と mmsg_member（メンバー=男性）を取得
    const selectors = "div.mmsg_char, div.mmsg_member";
    const nodes = Array.from(root.querySelectorAll(selectors));

    log("[MEM44] scrapeConversationStructured: found", nodes.length, "nodes");

    // 各ノードから { speaker, text } を抽出
    const all = [];
    for (const el of nodes) {
      // クラス名だけで speaker を決定（100% 確実）
      let speaker = "unknown";
      if (el.classList.contains("mmsg_char")) {
        speaker = "female";
      } else if (el.classList.contains("mmsg_member")) {
        speaker = "male";
      }

      // テキスト取得（空白正規化）
      const text = (el.innerText || "").replace(/\s+/g, " ").trim();

      // 空テキストは除外
      if (!text) continue;

      // 管理テキスト類を除外
      const isAdminMeta =
        /(管理者メモ|自己紹介文|使用絵文字・顔文字|残り\s*\d+\s*pt|入金|本登録|最終アクセス|累計送信数|返信文グループ|自由メモ|ジャンル|エロ・セフレ募集系|ポイント残高|ふたりメモ|キャラ情報|ユーザー情報)/.test(text);
      if (isAdminMeta) continue;

      // プロフィールヘッダー除外
      if (/^\d{6}\s/.test(text)) continue;

      // 「開封済み」削除
      const cleanText = text.replace(/開封済み/g, "").trim();
      if (!cleanText) continue;

      all.push({ speaker, text: cleanText });
    }

    const last20 = all.slice(-20);
    const last6 = all.slice(-6);

    // デバッグログ
    const maleCount = all.filter((m) => m.speaker === "male").length;
    const femaleCount = all.filter((m) => m.speaker === "female").length;
    console.log("[MEM44 v2.5] scrapeConversationStructured:", {
      total: all.length,
      male: maleCount,
      female: femaleCount,
    });
    console.log(
      "[MEM44] sample (last 6):",
      last6.map((m, i) => ({ idx: i, speaker: m.speaker, text: m.text.slice(0, 40) }))
    );

    return { all, last6, last20 };
  }

  // DEBUG helper (keep as comment for manual console testing):
  // [...document.querySelectorAll('div.mmsg_char, div.mmsg_member')]
  //   .slice(-10)
  //   .map((el, i) => ({
  //     idx: i,
  //     role: el.classList.contains('mmsg_char') ? 'female(char)' : 'male(member)',
  //     text: (el.innerText || '').trim().slice(0, 50),
  //   }));

  /**
   * ===== 青ログステージ算出 =====
   * 直近 male より後に female が連続何通送っているかをカウント
   * - 0 = 未返信（直近 male 以降に female なし）
   * - 1 = 青1（female 1通）
   * - 2 = 青2（female 2通）
   * - 3 = 青3（female 3通）
   * - 4 = 青4（female 4通以上）
   */
  function computeBlueStageFromEntries(entries) {
    if (!entries || !entries.length) return 0;

    const len = entries.length;

    // 末尾から直近 male を探す
    let lastMaleIndex = -1;
    for (let i = len - 1; i >= 0; i--) {
      const role = entries[i]?.role || entries[i]?.speaker;
      if (role === "male") {
        lastMaleIndex = i;
        break;
      }
    }

    // 直近 male が見つからない場合 → 全て female 連投とみなし、青1を返す
    if (lastMaleIndex === -1) {
      return 1;
    }

    // 直近 male より後ろの female 連続数をカウント
    let consecutiveFemale = 0;
    for (let i = lastMaleIndex + 1; i < len; i++) {
      const role = entries[i]?.role || entries[i]?.speaker;
      if (role === "female") {
        consecutiveFemale++;
      } else if (role === "male") {
        // 再度 male が来たらカウント終了
        break;
      } else {
        // unknown 等は連続性を切る扱いで break
        break;
      }
    }

    if (consecutiveFemale <= 0) return 0; // 未返信
    if (consecutiveFemale === 1) return 1;
    if (consecutiveFemale === 2) return 2;
    if (consecutiveFemale === 3) return 3;
    return 4; // 4通以上は青4固定
  }

  // 旧 scrapeConversationRaw / getConversation20 は削除済み
  // 新ロジックでは scrapeConversationStructured() のみを使用

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
    const { all } = scrapeConversationStructured();
    const last = all[all.length - 1] || { speaker: "", text: "" };
    const who = last.speaker === "male" ? "M" : last.speaker === "female" ? "F" : "";
    return { who, text: last.text, fp: hash(last.text) };
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
    // 新しい構造化会話取得（クラス名だけで男女判定）
    const conv = scrapeConversationStructured();

    const profileText = getSideInfoText() || "";

    // speaker -> role に変換して payload 用配列を作成
    const conv6 = conv.last6.map(m => ({ role: m.speaker, text: m.text }));
    const conv20 = conv.last20.map(m => ({ role: m.speaker, text: m.text }));

    // 青ログステージを会話から自動算出
    const blueStage = computeBlueStageFromEntries(conv20);

    // デバッグ用ログ
    console.log("[MEM44 v2.5] buildWebhookPayload:", {
      blueStage,
      conv6Count: conv6.length,
      conv20Count: conv20.length,
      male: conv.all.filter(m => m.speaker === "male").length,
      female: conv.all.filter(m => m.speaker === "female").length,
    });
    console.debug("[MEM44 v2.5] conversation sample (last 6):",
      conv6.map((m, idx) => ({ idx, role: m.role, text: m.text.slice(0, 50) }))
    );

    return {
      site: getSiteId(),
      threadId: getThreadId(),
      tone: getToneSetting(),
      blueStage,
      conversation: conv6,
      conversation_long20: conv20,
      profileText,
    };
  }

  async function sendManual() {
    setStatus("送信中…", "#ffa94d");
    try {
      const payload = await buildWebhookPayload();
      console.log("[MEM44 v2.5] sending payload to n8n:", payload);
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
      // 新しい構造化会話取得
      const conv = scrapeConversationStructured();
      const conversation_long20 = conv.last20.map(m => ({ role: m.speaker, text: m.text }));

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
        console.log("[MEM44 v2.5] sending payload to n8n (auto-on-load):", payload);
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

