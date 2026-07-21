// ==UserScript==
// @name         B站关注 → 抖音半自动同步
// @namespace    https://github.com/askofcc/bili-to-douyin-sync
// @version      0.5.4
// @description  从 B 站导出关注列表，在抖音网页端半自动搜索同名 UP 并关注；精确匹配 + 双重核验 + 关注后冷却
// @author       askofcc
// @homepageURL  https://github.com/askofcc/bili-to-douyin-sync
// @supportURL   https://github.com/askofcc/bili-to-douyin-sync/issues
// @downloadURL  https://raw.githubusercontent.com/askofcc/bili-to-douyin-sync/main/bili-to-douyin-sync.user.js
// @updateURL    https://raw.githubusercontent.com/askofcc/bili-to-douyin-sync/main/bili-to-douyin-sync.user.js
// @match        *://space.bilibili.com/*
// @match        *://www.bilibili.com/*
// @match        *://t.bilibili.com/*
// @match        *://www.douyin.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const K_LIST = "bili_followings_v1";
  const K_STATE = "douyin_sync_state_v1";
  const K_CFG = "bili_douyin_cfg_v1";
  const K_BOOT = "bili_douyin_boot_v1";
  const K_NAV = "bili_douyin_nav_v1";

  const host = location.hostname;
  const isBili = host.includes("bilibili.com");
  const isDouyin = host.includes("douyin.com");

  const defaultCfg = {
    mode: "auto", // auto | manual
    matchMode: "exact", // exact | loose
    betweenMs: 12000,
    settleMs: 4500,
    maxWaitMs: 20000,
    // 成功点关注后，再等这么久才跳下一个（随机区间，防验证码）
    afterFollowMinMs: 10000,
    afterFollowMaxMs: 15000,
    autoOpenDouyin: true,
  };

  // ---------- storage ----------
  function loadCfg() {
    const c = Object.assign({}, defaultCfg, GM_getValue(K_CFG, {}) || {});
    if (!c.betweenMs || c.betweenMs < 8000) c.betweenMs = 12000;
    if (!c.settleMs || c.settleMs < 2000) c.settleMs = 4500;
    if (!c.afterFollowMinMs || c.afterFollowMinMs < 8000) c.afterFollowMinMs = 10000;
    if (!c.afterFollowMaxMs || c.afterFollowMaxMs < c.afterFollowMinMs) {
      c.afterFollowMaxMs = Math.max(c.afterFollowMinMs + 5000, 15000);
    }
    return c;
  }
  function saveCfg(c) {
    GM_setValue(K_CFG, c);
  }
  function loadList() {
    return GM_getValue(K_LIST, null);
  }
  function saveList(v) {
    GM_setValue(K_LIST, v);
  }
  function loadState() {
    return (
      GM_getValue(K_STATE, null) || {
        index: 0,
        done: {},
        updatedAt: 0,
      }
    );
  }
  function saveState(s) {
    s.updatedAt = Date.now();
    GM_setValue(K_STATE, s);
  }
  function loadNav() {
    return GM_getValue(K_NAV, null) || { lastAt: 0, count: 0, windowStart: Date.now() };
  }
  function saveNav(n) {
    GM_setValue(K_NAV, n);
  }

  // ---------- utils ----------
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function randInt(min, max) {
    min = Math.floor(min);
    max = Math.floor(max);
    if (max < min) {
      const t = min;
      min = max;
      max = t;
    }
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  /** 成功关注后的冷却：默认 10–15 秒随机，避免连点触发验证码 */
  async function waitAfterFollow(log, setStatus) {
    const c = loadCfg();
    const min = c.afterFollowMinMs || 10000;
    const max = c.afterFollowMaxMs || 15000;
    const ms = randInt(min, max);
    const sec = (ms / 1000).toFixed(1);
    if (log) log("关注成功，冷却 " + sec + " 秒再跳下一个（防验证码）…");
    if (setStatus) setStatus("关注后冷却 " + sec + " 秒…");
    // 分段 sleep，方便状态刷新
    const step = 1000;
    let left = ms;
    while (left > 0) {
      const chunk = Math.min(step, left);
      await sleep(chunk);
      left -= chunk;
      if (setStatus && left > 0) {
        setStatus("关注后冷却，还剩约 " + Math.ceil(left / 1000) + " 秒…");
      }
    }
    // 把导航计时锚到冷却结束，避免紧接着又被 betweenMs 叠一层或反而过短
    try {
      const nav = loadNav();
      nav.lastAt = Date.now();
      saveNav(nav);
    } catch (_) {}
  }
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function txt(n) {
    return ((n && (n.innerText || n.textContent)) || "").replace(/\s+/g, " ").trim();
  }
  function el(tag, attrs, kids) {
    const n = document.createElement(tag);
    attrs = attrs || {};
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (k === "className") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "html") n.innerHTML = v;
      else if (k === "checked") n.checked = !!v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
      else n.setAttribute(k, v);
    }
    (kids || []).forEach((c) => {
      if (c == null) return;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }

  function normalize(s, mode) {
    let t = String(s || "").trim();
    if (mode === "loose") {
      t = t
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/[·・.。_\-—–|｜/\\[\]()（）【】「」『』<>《》"'“”‘’]/g, "");
    }
    return t;
  }
  function namesMatch(a, b, mode) {
    // exact：trim 后完全相等才算（禁止包含/模糊）
    // loose：仅在用户显式选择宽松模式时启用
    const rawA = String(a == null ? "" : a).trim();
    const rawB = String(b == null ? "" : b).trim();
    if (!rawA || !rawB) return false;
    if (mode !== "loose") {
      return rawA === rawB;
    }
    const x = normalize(rawA, "loose");
    const y = normalize(rawB, "loose");
    if (!x || !y) return false;
    if (x === y) return true;
    const ratio = Math.min(x.length, y.length) / Math.max(x.length, y.length);
    if ((x.includes(y) || y.includes(x)) && ratio >= 0.9 && Math.min(x.length, y.length) >= 2) {
      return true;
    }
    return false;
  }

  function isValidName(name) {
    return String(name == null ? "" : name).trim().length > 0;
  }

  function itemKey(it, index) {
    if (!it) return "empty_" + (index == null ? "x" : index);
    if (it.mid) return String(it.mid);
    const n = String(it.name || "").trim();
    if (n) return n;
    return "empty_" + (index == null ? "x" : index);
  }
  function getStatus(state, it) {
    return state.done[it.mid] || state.done[it.name] || "pending";
  }
  function isProblem(s) {
    return [
      "skipped",
      "not_found",
      "name_mismatch",
      "no_result",
      "need_click",
      "auto_failed",
      "problem",
    ].includes(s);
  }
  function isSuccess(s) {
    return s === "followed" || s === "auto_followed" || s === "already_followed";
  }
  function statusLabel(s) {
    return (
      {
        followed: "手动已关注",
        auto_followed: "自动已关注",
        already_followed: "原本已关注",
        skipped: "跳过",
        not_found: "未找到",
        name_mismatch: "昵称不匹配",
        no_result: "无结果",
        need_click: "无关注按钮",
        auto_failed: "点击未确认",
        pending: "未处理",
      }[s] || s
    );
  }
  function currentItem(list, state) {
    if (!list || !list.length) return null;
    let i = state.index || 0;
    while (i < list.length) {
      const it = list[i];
      const key = itemKey(it, i);
      const done =
        state.done[key] ||
        (it.mid && state.done[it.mid]) ||
        (it.name && state.done[it.name]) ||
        state.done["empty_" + i];
      if (!done) {
        return { item: it, index: i };
      }
      i += 1;
    }
    return null;
  }

  /** 把名单里空昵称直接标成 skipped，避免卡死 */
  function skipEmptyNames(payload, state) {
    if (!payload || !payload.list) return 0;
    let n = 0;
    payload.list.forEach((it, i) => {
      if (isValidName(it && it.name)) return;
      const key = itemKey(it, i);
      if (!state.done[key] && !(it.mid && state.done[it.mid])) {
        state.done[key] = "skipped";
        if (it.mid) state.done[it.mid] = "skipped";
        state.done["empty_" + i] = "skipped";
        n += 1;
      }
    });
    return n;
  }
  function listProblems(payload, state) {
    const out = [];
    ((payload && payload.list) || []).forEach((it, index) => {
      const st = getStatus(state, it);
      if (isProblem(st)) out.push({ item: it, index, status: st });
    });
    return out;
  }

  async function waitNavCooldown(log) {
    const cfg = loadCfg();
    const gap = Math.max(8000, cfg.betweenMs || 12000);
    const nav = loadNav();
    const now = Date.now();
    // 10 分钟窗口计数，超限只冷却 45 秒，不再锁死 5 分钟
    if (now - (nav.windowStart || 0) > 10 * 60 * 1000) {
      nav.windowStart = now;
      nav.count = 0;
      saveNav(nav);
    }
    if ((nav.count || 0) >= 25) {
      if (log) log("跳转偏多，冷却 45 秒（不再锁 5 分钟）…");
      await sleep(45000);
      nav.count = 8;
      nav.windowStart = Date.now();
      nav.lastAt = Date.now();
      saveNav(nav);
    }
    const wait = gap - (now - (nav.lastAt || 0));
    if (wait > 0) {
      if (log) log("限速等待 " + Math.ceil(wait / 1000) + " 秒…");
      await sleep(wait);
    }
  }
  function markNav() {
    const nav = loadNav();
    const now = Date.now();
    if (now - (nav.windowStart || 0) > 5 * 60 * 1000) {
      nav.windowStart = now;
      nav.count = 0;
    }
    nav.lastAt = now;
    nav.count = (nav.count || 0) + 1;
    saveNav(nav);
  }

  function hasCaptcha() {
    const t = document.body ? txt(document.body).slice(0, 3500) : "";
    return /请完成验证|访问过于频繁|操作过于频繁|异常流量|安全验证/.test(t);
  }

  function injectStyles() {
    if ($("#bds-style")) return;
    const s = document.createElement("style");
    s.id = "bds-style";
    s.textContent = `
      #bds-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:360px;max-height:78vh;overflow:auto;background:#111827;color:#f9fafb;border:1px solid #374151;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.35);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      #bds-panel *{box-sizing:border-box}
      #bds-panel .hd{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #374151;position:sticky;top:0;background:#111827;cursor:move}
      #bds-panel .bd{padding:12px;display:grid;gap:8px}
      #bds-panel .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
      #bds-panel button{appearance:none;border:0;border-radius:8px;padding:7px 10px;background:#2563eb;color:#fff;font-weight:700;cursor:pointer;font-size:12px}
      #bds-panel button.sec{background:#374151}
      #bds-panel button.ok{background:#059669}
      #bds-panel button.warn{background:#d97706}
      #bds-panel button.danger{background:#b91c1c}
      #bds-panel button:disabled{opacity:.45;cursor:not-allowed}
      #bds-panel .muted{color:#9ca3af;font-size:12px}
      #bds-panel .mini{font-size:11px;color:#9ca3af}
      #bds-panel .name{font-size:16px;font-weight:800;word-break:break-all;padding:8px 10px;background:#1f2937;border-radius:8px}
      #bds-panel .bar{height:8px;background:#1f2937;border-radius:99px;overflow:hidden}
      #bds-panel .bar>i{display:block;height:100%;width:0;background:#34d399}
      #bds-panel .stats{display:grid;grid-template-columns:1fr 1fr;gap:6px}
      #bds-panel .stat{background:#1f2937;border-radius:8px;padding:6px 8px}
      #bds-panel .stat b{display:block;font-size:16px}
      #bds-panel .log{max-height:130px;overflow:auto;background:#0b1220;border-radius:8px;padding:6px 8px;font:11px/1.4 ui-monospace,monospace;color:#d1d5db}
      #bds-panel .mode{display:grid;grid-template-columns:1fr 1fr;gap:6px;background:#0b1220;padding:4px;border-radius:10px;border:1px solid #374151}
      #bds-panel .mode button{background:transparent;color:#9ca3af}
      #bds-panel .mode button.on{background:#2563eb;color:#fff}
      #bds-panel .mode button.on.m{background:#d97706}
      #bds-panel textarea{width:100%;min-height:60px;border-radius:8px;border:1px solid #374151;background:#0b1220;color:#e5e7eb;padding:8px;font:12px ui-monospace,monospace}
      #bds-panel .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:800;background:#374151}
      #bds-panel .badge.run{background:#065f46;color:#a7f3d0}
      #bds-panel .badge.wait{background:#92400e;color:#fde68a}
      #bds-panel .badge.err{background:#7f1d1d;color:#fecaca}
      #bds-modal-mask{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center}
      #bds-modal{width:min(420px,92vw);max-height:80vh;overflow:auto;background:#111827;color:#f9fafb;border:1px solid #374151;border-radius:12px;padding:14px;display:grid;gap:10px;font:13px/1.45 -apple-system,sans-serif}
      #bds-modal .list{max-height:220px;overflow:auto;background:#0b1220;border-radius:8px;padding:8px;font-size:12px}
      #bds-modal button{appearance:none;border:0;border-radius:8px;padding:8px 12px;background:#2563eb;color:#fff;font-weight:700;cursor:pointer;margin-right:6px}
      #bds-modal button.sec{background:#374151}
      #bds-modal button.ok{background:#d97706}
      .bds-hl{outline:3px solid #22c55e !important;outline-offset:2px !important}
    `;
    document.documentElement.appendChild(s);
  }

  function makeDraggable(panel, handle) {
    let d = false, sx = 0, sy = 0, ox = 0, oy = 0;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      d = true;
      sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect();
      ox = r.left; oy = r.top;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = ox + "px";
      panel.style.top = oy + "px";
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!d) return;
      panel.style.left = ox + e.clientX - sx + "px";
      panel.style.top = oy + e.clientY - sy + "px";
    });
    window.addEventListener("mouseup", () => { d = false; });
  }

  // ---------- Bilibili ----------
  function getBiliUid() {
    const m = document.cookie.match(/(?:^|;\s*)DedeUserID=(\d+)/);
    if (m) return m[1];
    const um = location.pathname.match(/^\/(\d+)/);
    return um ? um[1] : null;
  }

  async function fetchFollowings(uid, onProgress) {
    const list = [];
    const seen = new Set();
    let pn = 1;
    let total = Infinity;
    while (list.length < total) {
      const url =
        "https://api.bilibili.com/x/relation/followings?vmid=" +
        uid +
        "&pn=" +
        pn +
        "&ps=50&order=desc&order_type=attention";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      if (json.code !== 0) throw new Error(json.message || "B站接口错误 " + json.code);
      total = Number((json.data && json.data.total) || 0);
      const batch = (json.data && json.data.list) || [];
      if (!batch.length) break;
      for (const item of batch) {
        const mid = String(item.mid);
        if (seen.has(mid)) continue;
        seen.add(mid);
        const uname = String(item.uname || item.name || "").trim();
        list.push({
          mid,
          name: uname, // 允许空，运行时自动 skipped，避免中断
          sign: item.sign || "",
          face: item.face || "",
        });
      }
      if (onProgress) onProgress(list.length, total, pn);
      pn += 1;
      await sleep(220 + Math.random() * 180);
      if (pn > 200) break;
    }
    return { uid: String(uid), total: list.length, exportedAt: new Date().toISOString(), list };
  }

  function buildUserSearchUrl(name) {
    return (
      "https://www.douyin.com/search/" +
      encodeURIComponent(String(name || "").trim()) +
      "?type=user&source=switch_tab&search_channel=aweme_user_web"
    );
  }

  function openDouyinStart() {
    const last = Number(sessionStorage.getItem("bds_open_at") || 0);
    if (Date.now() - last < 8000) return;
    sessionStorage.setItem("bds_open_at", String(Date.now()));
    GM_setValue(K_BOOT, { start: true, at: Date.now() });

    let url = "https://www.douyin.com/?bds_sync=1";
    const payload = loadList();
    const state = loadState();
    const cur = currentItem((payload && payload.list) || [], state);
    if (cur) {
      url = buildUserSearchUrl(cur.item.name) + "&bds_sync=1";
      sessionStorage.setItem("bds_auto_continue", "1");
      sessionStorage.setItem("bds_expect_name", cur.item.name);
    }
    if (location.hostname.includes("douyin.com")) {
      location.assign(url);
    } else {
      window.open(url, "bds_douyin_sync");
    }
  }

  // ---------- Douyin matching: 以「关注」按钮为锚点 ----------
  const JUNK = new Set([
    "我的", "首页", "推荐", "关注", "朋友", "消息", "通知", "直播", "商城", "搜索",
    "更多", "设置", "登录", "综合", "视频", "用户", "音乐", "图文", "下载", "投稿",
    "创作者中心", "开播", "分享", "帮助", "反馈",
  ]);

  function isJunkName(name) {
    const t = String(name || "").trim();
    if (!t || t.length > 40) return true;
    if (JUNK.has(t)) return true;
    if (/粉丝|获赞|作品|抖音号|已关注|互相关注|回关/.test(t)) return true;
    return false;
  }

  function isFollowText(t) {
    t = String(t || "").trim();
    return t === "关注" || t === "+关注" || t === "+ 关注" || t === "回关" || t === "关注TA";
  }
  function isFollowedText(t) {
    t = String(t || "").trim();
    return t === "已关注" || t === "互相关注" || t === "取消关注";
  }

  function isMainContent(node) {
    const r = node.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.top < 110) return false; // 顶栏
    if (r.left < 70 && r.width < 160) return false; // 左侧导航
    if (r.top > innerHeight * 2.5) return false;
    return true;
  }

  function clickHuman(node) {
    if (!node) return false;
    try {
      node.scrollIntoView({ block: "center", behavior: "instant" });
    } catch (_) {}
    const r = node.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 2, 36);
    const y = r.top + r.height / 2;
    const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    try {
      node.dispatchEvent(new MouseEvent("mouseover", base));
      node.dispatchEvent(new MouseEvent("mousedown", base));
      node.dispatchEvent(new MouseEvent("mouseup", base));
      node.dispatchEvent(new MouseEvent("click", base));
    } catch (_) {}
    try { node.click(); } catch (_) {}
    return true;
  }

  function findUserTabNode() {
    const nodes = Array.from(document.querySelectorAll("span, div, a, button, li, p"));
    const cands = [];
    for (const n of nodes) {
      if (txt(n) !== "用户") continue;
      const r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.top > 320 || r.top < 40) continue;
      let score = 300 - r.top;
      let p = n.parentElement;
      for (let i = 0; i < 4 && p; i++) {
        const pt = txt(p).slice(0, 60);
        if (pt.includes("综合") && pt.includes("用户")) score += 400;
        if (/视频|直播|音乐/.test(pt)) score += 80;
        p = p.parentElement;
      }
      cands.push({ n, score });
    }
    cands.sort((a, b) => b.score - a.score);
    return cands[0] ? cands[0].n : null;
  }

  async function ensureUserTab(log) {
    for (let i = 0; i < 6; i++) {
      const tab = findUserTabNode();
      if (tab) {
        clickHuman(tab);
        if (log) log("点击「用户」Tab");
        await sleep(500);
        return true;
      }
      await sleep(300);
    }
    if (log) log("未找到「用户」Tab，请手动点一下");
    return false;
  }

  function findFollowIn(root) {
    if (!root) return { followBtn: null, followedBtn: null };
    const nodes = Array.from(
      root.querySelectorAll("button, div[role='button'], span[role='button'], div, span, a")
    );
    let followBtn = null;
    let followedBtn = null;
    for (const n of nodes) {
      const t = txt(n);
      if (!t || t.length > 8) continue;
      const r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.width > 180 || r.height > 72) continue;
      if (n.children && n.children.length > 4) continue;
      if (isFollowedText(t)) {
        if (!followedBtn) followedBtn = n;
      } else if (isFollowText(t)) {
        if (!followBtn) followBtn = n;
      }
    }
    return { followBtn, followedBtn };
  }

  function extractNameNear(btn) {
    let root = btn;
    for (let i = 0; i < 8 && root; i++) {
      const r = root.getBoundingClientRect();
      if (r.width > 260 && r.height > 48 && r.height < 320) break;
      root = root.parentElement;
    }
    root = root || btn.parentElement || btn;

    const links = Array.from(root.querySelectorAll('a[href*="/user/"]'));
    for (const a of links) {
      if (!isMainContent(a) && a.getBoundingClientRect().top < 100) continue;
      const parts = Array.from(a.querySelectorAll("span, p, div, h1, h2, h3"));
      for (const p of parts) {
        const t = txt(p);
        if (t && !isJunkName(t) && t.length <= 40 && p.children.length <= 2) {
          return { name: t, root, link: a };
        }
      }
      const t = txt(a);
      if (t && !isJunkName(t) && t.length <= 40) return { name: t, root, link: a };
    }

    const nodes = Array.from(root.querySelectorAll("span, p, div, a"));
    const btnTop = btn.getBoundingClientRect().top;
    const scored = [];
    for (const n of nodes) {
      const t = txt(n);
      if (!t || isJunkName(t) || t.length > 40) continue;
      if (n.contains(btn)) continue;
      const r = n.getBoundingClientRect();
      if (Math.abs(r.top - btnTop) > 90) continue;
      if (r.left >= btn.getBoundingClientRect().left - 8) continue;
      if (n.children.length > 3) continue;
      // 跳过抖音号字段上的同名文本
      if (isDouyinIdContext(n, t)) continue;
      scored.push({
        t,
        dist: Math.abs(r.top - btnTop) + (btn.getBoundingClientRect().left - r.right) * 0.2,
        nick: isLikelyDisplayNameContext(n, t) ? 1 : 0,
      });
    }
    scored.sort((a, b) => (b.nick - a.nick) || (a.dist - b.dist));
    if (scored[0]) return { name: scored[0].t, root, link: null };

    const lines = txt(root).split("\n").map((s) => s.trim()).filter(Boolean);
    for (const line of lines) {
      if (!isJunkName(line) && line.length <= 40 && line !== "关注" && line !== "已关注") {
        return { name: line, root, link: null };
      }
    }
    return { name: "", root, link: null };
  }

  /**
   * 旧方案：关注按钮锚点 → 反推昵称（仅作兜底候选列表）
   */
  function findUserResults() {
    const nodes = Array.from(
      document.querySelectorAll("button, div[role='button'], span[role='button'], div, span, a")
    );
    const btns = [];
    for (const n of nodes) {
      const t = txt(n);
      if (!isFollowText(t) && !isFollowedText(t)) continue;
      if (t.length > 6) continue;
      const r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.width > 160 || r.height > 64) continue;
      if (!isMainContent(n)) continue;
      if (n.children && n.children.length > 4) continue;
      btns.push(n);
    }
    btns.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const uniq = [];
    for (const b of btns) {
      const r = b.getBoundingClientRect();
      const dup = uniq.some((u) => {
        const ur = u.getBoundingClientRect();
        return Math.abs(ur.top - r.top) < 8 && Math.abs(ur.left - r.left) < 8;
      });
      if (!dup) uniq.push(b);
    }
    const results = [];
    const seenName = new Set();
    for (const b of uniq) {
      const meta = extractNameNear(b);
      if (!meta.name || isJunkName(meta.name)) continue;
      if (seenName.has(meta.name)) continue;
      seenName.add(meta.name);
      results.push({
        name: meta.name,
        followBtn: isFollowText(txt(b)) ? b : null,
        followedBtn: isFollowedText(txt(b)) ? b : null,
        root: meta.root,
        top: b.getBoundingClientRect().top,
        via: "btn_anchor",
      });
    }
    results.sort((a, b) => a.top - b.top);
    return results;
  }

  /**
   * 新主方案（你说的开发者工具搜名字）：
   * 在 DOM 文本节点里找「完全等于目标 UP 名」的节点，再向上找卡片里的关注按钮。
   * 不要求必须在第一名。
   */

  /**
   * 判断这个「精确命中目标名」的节点，是不是抖音号字段，而不是展示昵称。
   * 用户反馈：同名时会误优先关注「抖音号=目标」的账号，应优先「昵称=目标」。
   */
  function isDouyinIdContext(el, target) {
    if (!el) return false;
    const targetStr = String(target || "").trim();
    let p = el;
    for (let i = 0; i < 6 && p; i++) {
      const t = txt(p);
      if (!t || t.length > 200) {
        p = p.parentElement;
        continue;
      }
      // 典型：抖音号：xxx / 抖音号 xxx / 抖音号xxx
      if (/抖音号\s*[:：]?\s*/.test(t) && t.includes(targetStr)) {
        const m = t.match(/抖音号\s*[:：]?\s*([^\s|/]+)/);
        if (m && (m[1] === targetStr || normalize(m[1], "exact") === normalize(targetStr, "exact"))) {
          return true;
        }
        // 目标紧跟在「抖音号」后面
        const idx = t.indexOf("抖音号");
        const tIdx = t.indexOf(targetStr);
        if (idx >= 0 && tIdx > idx && tIdx - idx <= 12) return true;
      }
      p = p.parentElement;
    }
    // 前一个兄弟节点是「抖音号」标签
    let sib = el.previousElementSibling;
    for (let i = 0; i < 3 && sib; i++) {
      if (/^抖音号$/.test(txt(sib)) || /^抖音号[:：]?$/.test(txt(sib))) return true;
      sib = sib.previousElementSibling;
    }
    const parent = el.parentElement;
    if (parent) {
      const children = Array.from(parent.childNodes);
      for (let i = 0; i < children.length; i++) {
        const c = children[i];
        if (c === el || (c.nodeType === 1 && c.contains(el))) {
          // look at previous siblings' text
          for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
            const pt = (children[j].textContent || "").replace(/\s+/g, " ").trim();
            if (/抖音号/.test(pt)) return true;
          }
          break;
        }
      }
    }
    return false;
  }

  function isLikelyDisplayNameContext(el, target) {
    if (!el) return false;
    if (isDouyinIdContext(el, target)) return false;
    // 用户主页链接里的文字，几乎一定是展示昵称
    if (el.closest && el.closest('a[href*="/user/"]')) return true;
    // 字号/位置启发式：卡片上半部、偏左
    const r = el.getBoundingClientRect();
    if (r.top > 110 && r.left > 90 && r.height >= 14 && r.height <= 40) {
      // 祖先里没有「抖音号」紧邻
      let p = el.parentElement;
      for (let i = 0; i < 3 && p; i++) {
        const t = txt(p);
        if (/^抖音号/.test(t) || t.startsWith("抖音号")) return false;
        p = p.parentElement;
      }
      return true;
    }
    return !isDouyinIdContext(el, target);
  }


  /** 从用户卡提取展示昵称：优先 /user/ 链接文案，排除抖音号行 */
  function extractCardDisplayName(root, target) {
    if (!root) return "";
    const targetStr = String(target || "").trim();
    const cands = [];

    const links = Array.from(root.querySelectorAll('a[href*="/user/"]'));
    for (const a of links) {
      const parts = Array.from(a.querySelectorAll("span, p, div, h1, h2, h3"));
      const tryPush = (node, t) => {
        t = String(t || "").trim();
        if (!t || isJunkName(t) || t.length > 40) return;
        if (isDouyinIdContext(node, t)) return;
        cands.push({ t, nick: isLikelyDisplayNameContext(node, t) ? 1 : 0, inLink: 1 });
      };
      for (const p of parts) {
        if (p.children.length > 2) continue;
        tryPush(p, txt(p));
      }
      tryPush(a, txt(a));
    }

    // 精确目标：仅当目标文本节点在卡内且像昵称
    if (targetStr) {
      const exact = findExactTextElements(targetStr).filter((el) => root.contains(el));
      for (const el of exact) {
        if (isDouyinIdContext(el, targetStr)) continue;
        if (isLikelyDisplayNameContext(el, targetStr) || (el.closest && el.closest('a[href*="/user/"]'))) {
          return targetStr;
        }
      }
    }

    cands.sort((a, b) => b.nick - a.nick || b.inLink - a.inLink);
    if (cands[0]) return cands[0].t;
    return "";
  }

  function findExactTextElements(targetName) {
    const target = String(targetName || "").trim();
    if (!target) return [];
    const hits = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const raw = node.textContent || "";
      // 完全相等（trim 后），类似 Elements 搜索命中后的精确文本
      if (raw.trim() !== target) continue;
      const el = node.parentElement;
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      // 过滤明显页脚/不可见
      if (r.top > innerHeight * 3) continue;
      hits.push(el);
    }
    return hits;
  }

  function scoreNameHit(el, target) {
    const r = el.getBoundingClientRect();
    let score = 0;
    // 主内容区加分
    if (isMainContent(el)) score += 100;
    // 越靠上略加分，但不强制第一
    if (r.top > 110 && r.top < innerHeight) score += 30;
    // 展示昵称（用户链接内）大幅加分
    if (el.closest && el.closest('a[href*="/user/"]')) score += 160;
    if (isLikelyDisplayNameContext(el, target)) score += 180;
    // 抖音号字段命中：强烈降权（这是你反馈的问题）
    if (isDouyinIdContext(el, target)) score -= 400;
    // 祖先有关注按钮
    let p = el;
    for (let i = 0; i < 6 && p; i++) {
      const pr = p.getBoundingClientRect();
      const controls = findFollowIn(p);
      if (controls.followBtn || controls.followedBtn) {
        score += 200;
        if (pr.height < 360 && pr.width > 200) score += 40;
        break;
      }
      p = p.parentElement;
    }
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") score -= 150;
    if (el.closest && el.closest("input, textarea, [contenteditable='true']")) score -= 120;
    if (r.left < 80) score -= 60;
    return score;
  }

  function locateCardFromNameEl(nameEl, targetName, strictExact) {
    // 只沿祖先向上找「最小卡片」：必须同时包含 nameEl + 关注按钮
    // 精确模式禁止横向抓邻卡按钮（那是误关主因之一）
    const target = String(targetName || "").trim();
    let el = nameEl;
    for (let i = 0; i < 12 && el; i++) {
      if (!el.contains(nameEl)) break;
      const controls = findFollowIn(el);
      const r = el.getBoundingClientRect();
      if (!(controls.followBtn || controls.followedBtn)) {
        el = el.parentElement;
        continue;
      }
      if (r.height <= 36 || r.height > 380) {
        el = el.parentElement;
        continue;
      }
      // 卡片展示昵称必须可读且（精确模式下）完全等于目标
      const shown = extractCardDisplayName(el, target);
      if (strictExact) {
        if (!shown || shown !== target) {
          el = el.parentElement;
          continue;
        }
        // 拒绝抖音号字段冒充昵称
        if (nameEl && isDouyinIdContext(nameEl, target) && !isLikelyDisplayNameContext(nameEl, target)) {
          el = el.parentElement;
          continue;
        }
      } else if (shown && shown !== target && !namesMatch(shown, target, "loose")) {
        el = el.parentElement;
        continue;
      }
      return {
        name: target,
        displayName: shown || target,
        followBtn: controls.followBtn,
        followedBtn: controls.followedBtn,
        root: el,
        nameEl: nameEl,
        top: r.top,
        via: "dom_text_exact_tight",
      };
    }
    return null;
  }

  /**
   * 双通道定位目标 UP：
   * A) DOM 精确文本 = 目标名（可在任意名次）
   * B) 关注按钮反推昵称后再 namesMatch
   * 只有匹配到目标才返回 best；绝不因“第一名”误点
   */
  function findTargetUser(targetName, matchMode) {
    const target = String(targetName || "").trim();
    // 强制归一：只有显式 loose 才模糊，其它一律 exact
    const mode = matchMode === "loose" ? "loose" : "exact";
    const strictExact = mode === "exact";
    const debug = { exactHits: 0, cardHits: 0, btnCandidates: 0, preferNick: 0, idHits: 0, mode: mode };

    if (!target) {
      return { best: null, reason: "empty_target", debug, allExact: 0 };
    }

    // ---- 通道 A：DOM 文本节点 === 目标（完全相等）----
    const exactEls = findExactTextElements(target);
    debug.exactHits = exactEls.length;
    const scored = exactEls
      .map((el) => {
        const idHit = isDouyinIdContext(el, target);
        const nickHit = isLikelyDisplayNameContext(el, target);
        if (idHit) debug.idHits += 1;
        if (nickHit) debug.preferNick += 1;
        return { el, score: scoreNameHit(el, target), idHit, nickHit };
      })
      .sort((a, b) => {
        if (a.nickHit !== b.nickHit) return a.nickHit ? -1 : 1;
        if (a.idHit !== b.idHit) return a.idHit ? 1 : -1;
        return b.score - a.score;
      });

    // A1 仅展示昵称
    const nickCards = [];
    for (const item of scored) {
      if (item.idHit && !item.nickHit) continue;
      if (strictExact && !item.nickHit) continue; // 精确模式：必须像昵称
      const card = locateCardFromNameEl(item.el, target, strictExact);
      if (!card || !(card.followBtn || card.followedBtn)) continue;
      if (strictExact) {
        if (!card.displayName || card.displayName !== target) continue;
      }
      debug.cardHits += 1;
      card.matchKind = "nickname";
      nickCards.push(card);
    }
    if (nickCards.length) {
      nickCards.sort((a, b) => a.top - b.top);
      return {
        best: nickCards[0],
        reason: "dom_exact_nickname",
        debug,
        allExact: exactEls.length,
        candidates: nickCards.length,
      };
    }

    // A2 抖音号：仅宽松模式允许；精确模式直接禁用（避免“像模糊/错人”）
    if (!strictExact) {
      const idCards = [];
      for (const item of scored) {
        if (!item.idHit) continue;
        const card = locateCardFromNameEl(item.el, target, false);
        if (!card || !(card.followBtn || card.followedBtn)) continue;
        card.matchKind = "douyin_id";
        idCards.push(card);
      }
      if (idCards.length) {
        idCards.sort((a, b) => a.top - b.top);
        return {
          best: idCards[0],
          reason: "dom_exact_douyin_id_fallback",
          debug,
          allExact: exactEls.length,
        };
      }
    }

    // ---- 通道 B：按钮反推昵称，必须完全相等 ----
    const results = findUserResults();
    debug.btnCandidates = results.length;
    const exactBtn = [];
    for (const r of results) {
      const n = String(r.name || "").trim();
      if (strictExact) {
        if (n !== target) continue;
      } else if (!namesMatch(n, target, mode)) {
        continue;
      }
      r.matchKind = "nickname";
      r.displayName = n;
      exactBtn.push(r);
    }
    if (exactBtn.length) {
      exactBtn.sort((a, b) => a.top - b.top);
      return {
        best: exactBtn[0],
        reason: "btn_name_exact",
        debug,
        allExact: exactEls.length,
        candidates: exactBtn.length,
      };
    }

    if (exactEls.length) {
      return {
        best: null,
        reason: strictExact ? "exact_text_but_no_nickname_card" : "name_found_no_button",
        debug,
        allExact: exactEls.length,
      };
    }

    return {
      best: null,
      reason: "no_result",
      debug,
      allExact: 0,
      sample: results.slice(0, 5).map((r) => r.name),
    };
  }

  function verifyFollowed(targetName, matchMode) {
    const again = findTargetUser(targetName, matchMode);
    if (again.best && again.best.followedBtn && !again.best.followBtn) {
      return { ok: true, how: "target_followed_btn" };
    }
    if (again.best && again.best.followedBtn) {
      return { ok: true, how: "target_has_followed_btn" };
    }
    // 精确文本旁是否已关注
    const exactEls = findExactTextElements(targetName);
    for (const el of exactEls) {
      const card = locateCardFromNameEl(el, targetName);
      if (card && card.followedBtn) return { ok: true, how: "exact_text_followed" };
    }
    // 按钮列表里同名
    const list = findUserResults();
    for (const r of list) {
      if (namesMatch(r.name, targetName, matchMode) && r.followedBtn) {
        return { ok: true, how: "list_followed" };
      }
    }
    return { ok: false, how: "not_confirmed", againReason: again.reason };
  }

  async function openUserSearch(name, log) {
    name = String(name || "").trim();
    if (!name) throw new Error("空昵称");
    if (hasCaptcha()) throw new Error("检测到验证码/频控，请先手动完成验证");

    await waitNavCooldown(log);

    sessionStorage.setItem("bds_auto_continue", "1");
    sessionStorage.setItem("bds_expect_name", name);

    const path = decodeURIComponent(location.pathname || "");
    const same =
      path.includes("/search/") &&
      (path.includes(encodeURIComponent(name)) || path.includes(name));

    if (same) {
      if (log) log("已在搜索页，切换用户 Tab：" + name);
      await ensureUserTab(log);
      return "same";
    }

    markNav();
    if (log) log("跳转用户搜索：" + name);
    location.assign(buildUserSearchUrl(name));
    return "hard";
  }

  // ---------- UI: Bilibili ----------
  function mountBili() {
    injectStyles();
    const cfg = loadCfg();
    const panel = el("div", { id: "bds-panel" });
    const hd = el("div", { className: "hd" }, [
      el("strong", { text: "B站 → 抖音 · 抓取关注" }),
      el("button", { className: "sec", text: "−", onClick: () => {
        const b = $(".bd", panel); b.style.display = b.style.display === "none" ? "grid" : "none";
      }}),
    ]);
    const status = el("div", { className: "muted", text: "登录 B站后点「抓取并开始」。" });
    const bar = el("div", { className: "bar" }, [el("i")]);
    const log = el("div", { className: "log" });
    const put = (m) => { const d = document.createElement("div"); d.textContent = m; log.prepend(d); };

    const chkOpen = el("input", { type: "checkbox", checked: cfg.autoOpenDouyin !== false });

    const btnFetch = el("button", {
      text: "抓取并开始",
      onClick: async () => {
        const uid = getBiliUid();
        if (!uid) { status.textContent = "未登录/无 UID"; return; }
        btnFetch.disabled = true;
        try {
          const payload = await fetchFollowings(uid, (n, total, pn) => {
            const pct = total ? Math.min(100, Math.round((n / total) * 100)) : 0;
            bar.firstChild.style.width = pct + "%";
            status.textContent = "已抓 " + n + "/" + (total || "?") + " 第" + pn + "页";
          });
          saveList(payload);
          saveState({ index: 0, done: {}, updatedAt: Date.now() });
          bar.firstChild.style.width = "100%";
          status.textContent = "完成 " + payload.list.length + " 人";
          put(payload.exportedAt + " 导出 " + payload.list.length);
          const c = loadCfg();
          c.autoOpenDouyin = chkOpen.checked;
          saveCfg(c);
          if (chkOpen.checked) {
            openDouyinStart();
            put("已打开抖音（固定单标签）");
          }
        } catch (e) {
          status.textContent = "失败：" + (e.message || e);
          put(status.textContent);
        } finally {
          btnFetch.disabled = false;
        }
      },
    });

    const btnOnly = el("button", {
      className: "sec",
      text: "仅抓取",
      onClick: async () => {
        const uid = getBiliUid();
        if (!uid) return;
        btnOnly.disabled = true;
        try {
          const payload = await fetchFollowings(uid, (n, total) => {
            status.textContent = "已抓 " + n + "/" + (total || "?");
          });
          saveList(payload);
          saveState({ index: 0, done: {}, updatedAt: Date.now() });
          status.textContent = "完成 " + payload.list.length + " 人（未开抖音）";
        } catch (e) {
          status.textContent = String(e.message || e);
        } finally {
          btnOnly.disabled = false;
        }
      },
    });

    const btnOpen = el("button", {
      className: "ok",
      text: "打开抖音",
      onClick: () => {
        if (!loadList() || !loadList().list) { status.textContent = "先抓取"; return; }
        openDouyinStart();
      },
    });

    const btnJson = el("button", {
      className: "sec",
      text: "下载 JSON",
      onClick: () => {
        const p = loadList();
        if (!p) return;
        const blob = new Blob([JSON.stringify(p, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "bili-followings.json";
        a.click();
      },
    });

    const existing = loadList();
    if (existing && existing.list) status.textContent = "本地已有 " + existing.list.length + " 人";

    const bd = el("div", { className: "bd" }, [
      status, bar,
      el("label", { className: "mini" }, [chkOpen, document.createTextNode(" 抓完自动打开抖音")]),
      el("div", { className: "row" }, [btnFetch, btnOnly, btnOpen, btnJson]),
      el("div", { className: "mini", text: "抖音侧：搜用户 → 页面文本精确匹配 UP 名 → 定位卡片关注按钮 → 双重核验" }),
      log,
    ]);
    panel.append(hd, bd);
    document.documentElement.appendChild(panel);
    makeDraggable(panel, hd);
  }

  // ---------- UI: Douyin ----------
  function mountDouyin() {
    injectStyles();
    let cfg = loadCfg();
    let running = false;
    let busy = false;

    const panel = el("div", { id: "bds-panel" });
    const badge = el("span", { className: "badge", text: "待命" });
    const hd = el("div", { className: "hd" }, [
      el("div", { className: "row" }, [el("strong", { text: "抖音 · 同步关注" }), badge]),
      el("button", { className: "sec", text: "−", onClick: () => {
        const b = $(".bd", panel); b.style.display = b.style.display === "none" ? "grid" : "none";
      }}),
    ]);

    const nameBox = el("div", { className: "name", text: "—" });
    const meta = el("div", { className: "muted", text: "" });
    const status = el("div", { className: "muted", text: "" });
    const bar = el("div", { className: "bar" }, [el("i")]);
    const stats = el("div", { className: "stats" });
    const logBox = el("div", { className: "log" });
    const importArea = el("textarea", { placeholder: "可选：粘贴 B站 JSON 后导入" });

    const matchSel = el("select", {}, [
      el("option", { value: "exact", text: "完全精确（字符全等）" }),
      el("option", { value: "loose", text: "宽松（不推荐）" }),
    ]);
    matchSel.value = cfg.matchMode || "exact";
    const gapInput = el("input", {
      type: "number", min: "8000", step: "1000", value: String(cfg.betweenMs || 12000),
      style: "width:90px;background:#0b1220;color:#e5e7eb;border:1px solid #374151;border-radius:6px;padding:4px 6px",
    });

    const btnAuto = el("button", { text: "自动" });
    const btnManual = el("button", { text: "手动" });
    const modeBox = el("div", { className: "mode" }, [btnAuto, btnManual]);

    function log(msg) {
      const d = document.createElement("div");
      d.textContent = "[" + new Date().toLocaleTimeString() + "] " + msg;
      logBox.prepend(d);
    }
    function setBadge(kind, t) {
      badge.className = "badge " + (kind || "");
      badge.textContent = t;
    }
    function mode() {
      return (loadCfg().mode || "auto") === "manual" ? "manual" : "auto";
    }
    function refreshMode() {
      const m = mode();
      btnAuto.className = m === "auto" ? "on" : "";
      btnManual.className = m === "manual" ? "on m" : "";
    }
    function persist() {
      cfg = loadCfg();
      cfg.matchMode = matchSel.value === "loose" ? "loose" : "exact";
      cfg.betweenMs = Math.max(8000, Number(gapInput.value) || 12000);
      saveCfg(cfg);
    }
    matchSel.onchange = persist;
    gapInput.onchange = persist;

    function setMode(m) {
      cfg = loadCfg();
      cfg.mode = m;
      saveCfg(cfg);
      refreshMode();
      log("切换为" + (m === "auto" ? "自动" : "手动"));
      if (m === "manual") {
        running = false;
        setBadge("wait", "手动");
      }
    }
    btnAuto.onclick = () => setMode("auto");
    btnManual.onclick = () => setMode("manual");

    function refresh() {
      const payload = loadList();
      const state = loadState();
      const list = (payload && payload.list) || [];
      let done = 0, ok = 0, bad = 0;
      list.forEach((it) => {
        const st = getStatus(state, it);
        if (st !== "pending") done += 1;
        if (isSuccess(st)) ok += 1;
        if (isProblem(st)) bad += 1;
      });
      bar.firstChild.style.width = list.length ? Math.round((done / list.length) * 100) + "%" : "0%";
      stats.innerHTML = "";
      [
        ["总数", list.length],
        ["已处理", done],
        ["成功关注", ok],
        ["问题项", bad],
      ].forEach((p) => {
        stats.appendChild(el("div", { className: "stat" }, [
          el("b", { text: String(p[1]) }),
          el("span", { className: "mini", text: p[0] }),
        ]));
      });
      const cur = currentItem(list, state);
      if (!list.length) {
        nameBox.textContent = "暂无名单";
        meta.textContent = "请先在 B站抓取或导入 JSON";
        return null;
      }
      if (!cur) {
        nameBox.textContent = "队列已空";
        meta.textContent = "成功 " + ok + " · 问题 " + bad;
        return null;
      }
      nameBox.textContent = cur.item.name;
      meta.textContent = "#" + (cur.index + 1) + "/" + list.length + " · mid " + cur.item.mid;
      return cur;
    }

    function mark(statusKey) {
      const payload = loadList();
      const state = loadState();
      skipEmptyNames(payload, state);
      const cur = currentItem((payload && payload.list) || [], state);
      if (!cur) {
        saveState(state);
        return null;
      }
      const key = itemKey(cur.item, cur.index);
      state.done[key] = statusKey;
      if (cur.item.mid) state.done[cur.item.mid] = statusKey;
      if (isValidName(cur.item.name)) state.done[String(cur.item.name).trim()] = statusKey;
      state.index = cur.index + 1;
      saveState(state);
      // 连续跳过后续空昵称
      let st2 = loadState();
      skipEmptyNames(payload, st2);
      // 若 index 指到空名，继续推进 done
      let guard = 0;
      while (guard++ < 50) {
        const c2 = currentItem(payload.list, st2);
        if (!c2) break;
        if (isValidName(c2.item.name)) break;
        const k2 = itemKey(c2.item, c2.index);
        st2.done[k2] = "skipped";
        if (c2.item.mid) st2.done[c2.item.mid] = "skipped";
        st2.done["empty_" + c2.index] = "skipped";
        st2.index = c2.index + 1;
      }
      saveState(st2);
      return currentItem(payload.list, loadState());
    }

    function showProblems(problems) {
      const old = $("#bds-modal-mask");
      if (old) old.remove();
      if (!problems.length) {
        status.textContent = "没有问题项";
        return;
      }
      const mask = el("div", { id: "bds-modal-mask" });
      const modal = el("div", { id: "bds-modal" });
      const list = el("div", { className: "list" });
      problems.slice(0, 50).forEach((p, i) => {
        list.appendChild(el("div", { text: i + 1 + ". " + p.item.name + " · " + statusLabel(p.status) }));
      });
      const btnRerun = el("button", {
        className: "ok",
        text: "手动重跑这些问题",
        onClick: () => {
          mask.remove();
          const payload = loadList();
          const state = loadState();
          let first = Infinity;
          problems.forEach((p) => {
            delete state.done[itemKey(p.item)];
            delete state.done[p.item.mid];
            delete state.done[p.item.name];
            if (p.index < first) first = p.index;
          });
          state.index = first === Infinity ? 0 : first;
          saveState(state);
          setMode("manual");
          refresh();
          start(true);
        },
      });
      const btnClose = el("button", { className: "sec", text: "稍后", onClick: () => mask.remove() });
      modal.append(
        el("h3", { text: "有 " + problems.length + " 个需要处理" }),
        el("div", { className: "muted", text: "可一键进入手动重跑" }),
        list,
        el("div", {}, [btnRerun, btnClose])
      );
      mask.appendChild(modal);
      mask.addEventListener("click", (e) => { if (e.target === mask) mask.remove(); });
      document.documentElement.appendChild(mask);
    }

    function finishIfEmpty() {
      const payload = loadList();
      const state = loadState();
      const cur = currentItem((payload && payload.list) || [], state);
      if (cur) return;
      running = false;
      const problems = listProblems(payload, state);
      if (problems.length) {
        setBadge("wait", "有问题");
        status.textContent = "跑完了，有 " + problems.length + " 个问题项";
        log("结束：问题 " + problems.length);
        showProblems(problems);
      } else {
        setBadge("", "完成");
        status.textContent = "全部完成";
        log("全部完成");
      }
    }

    async function goNext(statusKey) {
      document.querySelectorAll(".bds-hl").forEach((n) => n.classList.remove("bds-hl"));
      let next = mark(statusKey);
      refresh();
      log("记为 " + statusLabel(statusKey) + (next ? "，下一个：" + (next.item.name || "(空)") : "，队列空"));

      // 空昵称：自动跳过，绝不中断整条流水线
      let guard = 0;
      while (next && !isValidName(next.item.name) && guard++ < 100) {
        log("空昵称，自动跳过 mid=" + (next.item.mid || "") + " #" + (next.index + 1));
        next = mark("skipped");
        refresh();
      }

      if (!next) {
        finishIfEmpty();
        return;
      }
      if (!running) {
        status.textContent = "已暂停/待命。点开始继续。";
        return;
      }
      try {
        const name = String(next.item.name || "").trim();
        if (!name) {
          log("仍遇空昵称，继续跳过");
          await goNext("skipped");
          return;
        }
        const nav = await openUserSearch(name, log);
        if (nav === "same") await processOne();
        // hard: 新页 boot 续跑
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        // 空昵称类错误：跳过而不是整停
        if (/空昵称/.test(msg)) {
          log("捕获空昵称错误，自动跳过继续");
          await goNext("skipped");
          return;
        }
        running = false;
        setBadge("err", "停");
        status.textContent = msg;
        log(status.textContent);
      }
    }

    async function waitResults(target) {
      const cfg = loadCfg();
      const startAt = Date.now();
      let tabbed = false;
      while (Date.now() - startAt < (cfg.maxWaitMs || 16000)) {
        if (hasCaptcha()) return { captcha: true, results: [] };
        if (!tabbed && Date.now() - startAt > 600) {
          await ensureUserTab(log);
          tabbed = true;
        }
        const results = findUserResults();
        if (results.length) return { results, captcha: false };
        await sleep(400);
      }
      return { results: findUserResults(), captcha: false };
    }

    async function processOne() {
      if (busy) {
        log("忽略重入");
        return;
      }
      const payload = loadList();
      const state = loadState();
      skipEmptyNames(payload, state);
      saveState(state);
      const cur = currentItem((payload && payload.list) || [], loadState());
      if (!cur) {
        refresh();
        finishIfEmpty();
        return;
      }
      if (!isValidName(cur.item.name)) {
        log("当前项空昵称，自动跳过 #" + (cur.index + 1));
        busy = false;
        setTimeout(() => goNext("skipped"), 30);
        return;
      }
      if (hasCaptcha()) {
        running = false;
        setBadge("err", "验证码");
        status.textContent = "请先完成验证，再点开始";
        return;
      }

      busy = true;
      const m = mode();
      setBadge(m === "auto" ? "run" : "wait", m === "auto" ? "自动中" : "手动中");
      status.textContent = "等待用户搜索结果…";
      try {
        await sleep(loadCfg().settleMs || 3500);
        await ensureUserTab(log);
        await sleep(600);

        if (hasCaptcha()) {
          running = false;
          setBadge("err", "验证码");
          status.textContent = "验证码，已停止";
          return;
        }

        // 等结果渲染：多次尝试按「页面文本精确搜名字」
        const cfgNow = loadCfg();
        // 以面板下拉为准，防止配置被旧值干扰
        try {
          const sel = panel.querySelector("select");
          if (sel && (sel.value === "exact" || sel.value === "loose")) {
            cfgNow.matchMode = sel.value;
            const c = loadCfg();
            c.matchMode = sel.value;
            saveCfg(c);
          }
        } catch (_) {}
        if (cfgNow.matchMode !== "loose") cfgNow.matchMode = "exact";
        log("当前匹配模式=" + cfgNow.matchMode + "（非 loose 一律按完全精确）");
        let pick = null;
        const tryUntil = Date.now() + (cfgNow.maxWaitMs || 20000);
        let attempt = 0;
        while (Date.now() < tryUntil) {
          attempt += 1;
          if (attempt === 1 || attempt === 3) await ensureUserTab(log);
          pick = findTargetUser(cur.item.name, cfgNow.matchMode || "exact");
          log(
            "核验#" + attempt +
            " 精确文本命中=" + (pick.allExact || 0) +
            " 原因=" + pick.reason +
            (pick.best ? (" 按钮=" + (pick.best.followBtn ? "关注" : pick.best.followedBtn ? "已关注" : "无")) : "")
          );
          if (pick.best && (pick.best.followBtn || pick.best.followedBtn)) break;
          if (pick.reason === "name_found_no_button" && attempt >= 3) break;
          await sleep(700);
        }

        if (!pick || !pick.best) {
          const sample = (pick && pick.sample) ? pick.sample.join(" | ") : "";
          log("未定位到目标「" + cur.item.name + "」 exact=" + ((pick && pick.allExact) || 0) + (sample ? (" 其它候选:" + sample) : ""));
          if (m === "manual") {
            status.textContent = "页面里没定位到该 UP。可手动搜后 F/S/X";
            return;
          }
          const st = pick && pick.reason === "name_found_no_button" ? "need_click" : "no_result";
          busy = false;
          setTimeout(() => goNext(st), 50);
          return;
        }

        const best = pick.best;
        if (best.root) best.root.classList.add("bds-hl");
        if (best.nameEl) best.nameEl.classList.add("bds-hl");
        if (best.followBtn) best.followBtn.classList.add("bds-hl");
        if (best.followedBtn) best.followedBtn.classList.add("bds-hl");

        log(
          "锁定「" + best.name + "」 via=" + (best.via || pick.reason) +
          " 原因=" + pick.reason +
          " 类型=" + (best.matchKind || (pick.reason.indexOf("douyin_id") >= 0 ? "douyin_id" : "nickname/unknown")) +
          " 按钮=" + (best.followBtn ? "关注" : best.followedBtn ? "已关注" : "无") +
          (pick.debug ? (" 昵称命中~" + (pick.debug.preferNick || 0) + "/号命中~" + (pick.debug.idHits || 0)) : "")
        );
        status.textContent = "锁定「" + best.name + "」(" + pick.reason + ")";

        if (m === "manual") {
          status.textContent += "。请确认后点关注，再按 F；不对则 S/X";
          return;
        }

        // 已关注
        if (best.followedBtn && !best.followBtn) {
          log("已是关注状态，跳过点击");
          busy = false;
          // 已关注也算一次关系操作，同样拉长间隔
          (async () => {
            await waitAfterFollow(log, (t) => { status.textContent = t; });
            await goNext("already_followed");
          })();
          return;
        }

        if (!best.followBtn) {
          log("找到名字但无关注按钮");
          busy = false;
          setTimeout(() => goNext("need_click"), 50);
          return;
        }

        // 点击前强制闸门：精确模式下展示昵称必须与目标字符级完全一致
        const targetName = String(cur.item.name || "").trim();
        const modeNow = (cfgNow.matchMode || "exact") === "loose" ? "loose" : "exact";
        const shown = String(
          best.displayName || extractCardDisplayName(best.root, targetName) || ""
        ).trim();
        log("匹配模式=" + modeNow + " 原因=" + pick.reason + " 展示名「" + shown + "」目标「" + targetName + "」");
        if (modeNow === "exact") {
          if (!shown || shown !== targetName) {
            log("拒绝点击：精确模式要求展示名完全相等（当前「" + shown + "」）");
            busy = false;
            setTimeout(() => goNext("name_mismatch"), 50);
            return;
          }
          if (pick.reason === "dom_exact_douyin_id_fallback" || best.matchKind === "douyin_id") {
            log("拒绝点击：精确模式禁止仅按抖音号匹配");
            busy = false;
            setTimeout(() => goNext("name_mismatch"), 50);
            return;
          }
          if (best.nameEl && isDouyinIdContext(best.nameEl, targetName) && !isLikelyDisplayNameContext(best.nameEl, targetName)) {
            log("拒绝点击：命中节点像抖音号字段，不是展示昵称");
            busy = false;
            setTimeout(() => goNext("name_mismatch"), 50);
            return;
          }
        } else {
          if (!namesMatch(shown || best.name, targetName, "loose")) {
            log("拒绝点击：宽松模式仍未通过校验");
            busy = false;
            setTimeout(() => goNext("name_mismatch"), 50);
            return;
          }
        }
        const preExact = findExactTextElements(targetName).length;
        log("点击前复核通过：展示名完全匹配，精确文本命中 " + preExact + " 处");

        status.textContent = "点击关注：「" + best.name + "」";
        setBadge("run", "点关注");
        log("点击关注：" + best.name);
        clickHuman(best.followBtn);
        await sleep(1800);

        // 双重核验（最多 5 轮，必要时再点一次）
        let verified = null;
        for (let i = 0; i < 5; i++) {
          verified = verifyFollowed(cur.item.name, cfgNow.matchMode || "exact");
          log("核验点击后#" + (i + 1) + " ok=" + verified.ok + " how=" + verified.how);
          if (verified.ok) break;
          if (i === 1) {
            log("再次点击关注按钮");
            clickHuman(best.followBtn);
          }
          await sleep(700);
        }

        const nextStatus = verified && verified.ok ? "auto_followed" : "auto_failed";
        log((verified && verified.ok ? "关注成功：" : "点击后未确认成功：") + cur.item.name);
        busy = false;
        (async () => {
          // 只有真正点了关注（成功或未确认）都拉长间隔；失败未点的 no_result 不加这段
          if (nextStatus === "auto_followed" || nextStatus === "auto_failed") {
            await waitAfterFollow(log, (t) => { status.textContent = t; });
          }
          await goNext(nextStatus);
        })();
        return;
      } catch (e) {
        running = false;
        setBadge("err", "错");
        status.textContent = e.message || String(e);
        log(status.textContent);
      } finally {
        busy = false;
        refresh();
      }
    }

    async function start(force) {
      running = true;
      persist();
      refreshMode();
      let cur = refresh();
      const payload0 = loadList();
      const st0 = loadState();
      if (payload0) {
        const n = skipEmptyNames(payload0, st0);
        if (n) {
          saveState(st0);
          log("启动时跳过空昵称 " + n + " 个");
          cur = refresh();
        }
      }
      // 若当前仍是空名，推进
      while (cur && !isValidName(cur.item.name)) {
        log("启动跳过空昵称 #" + (cur.index + 1));
        mark("skipped");
        cur = refresh();
      }
      if (!cur) {
        finishIfEmpty();
        return;
      }
      setBadge(mode() === "auto" ? "run" : "wait", mode() === "auto" ? "自动中" : "手动中");
      try {
        const path = decodeURIComponent(location.pathname || "");
        const name = String(cur.item.name || "").trim();
        const on =
          path.includes("/search/") &&
          (path.includes(encodeURIComponent(name)) || path.includes(name));
        if (force || !on) {
          const nav = await openUserSearch(name, log);
          if (nav === "same") await processOne();
          return;
        }
        await processOne();
      } catch (e) {
        running = false;
        setBadge("err", "停");
        status.textContent = e.message || String(e);
        log(status.textContent);
      }
    }

    const btnStart = el("button", { className: "ok", text: "开始 / 继续", onClick: () => start(true) });
    const btnPause = el("button", {
      className: "warn", text: "暂停", onClick: () => {
        running = false; setBadge("", "已暂停"); status.textContent = "已暂停"; log("暂停");
      },
    });
    const btnF = el("button", {
      className: "ok", text: "已关注→下个(F)", onClick: async () => { running = true; await goNext("followed"); },
    });
    const btnS = el("button", {
      className: "sec", text: "跳过(S)", onClick: async () => { running = true; await goNext("skipped"); },
    });
    const btnX = el("button", {
      className: "danger", text: "未找到(X)", onClick: async () => { running = true; await goNext("not_found"); },
    });
    const btnProb = el("button", {
      className: "warn", text: "查看问题项", onClick: () => showProblems(listProblems(loadList(), loadState())),
    });
    const btnReset = el("button", {
      className: "sec", text: "重置进度", onClick: () => {
        if (!confirm("重置进度？")) return;
        saveState({ index: 0, done: {}, updatedAt: Date.now() });
        refresh();
      },
    });
    const btnImport = el("button", {
      className: "sec", text: "导入 JSON", onClick: () => {
        try {
          const data = JSON.parse(importArea.value.trim());
          if (!data.list) throw new Error("缺 list");
          saveList(data);
          saveState({ index: 0, done: {}, updatedAt: Date.now() });
          status.textContent = "导入 " + data.list.length;
          refresh();
        } catch (e) {
          status.textContent = "导入失败 " + e.message;
        }
      },
    });

    window.addEventListener("keydown", (e) => {
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "f") { e.preventDefault(); btnF.click(); }
      else if (k === "s") { e.preventDefault(); btnS.click(); }
      else if (k === "x") { e.preventDefault(); btnX.click(); }
      else if (k === "p") { e.preventDefault(); btnPause.click(); }
    });

    const bd = el("div", { className: "bd" }, [
      nameBox, meta, bar, stats,
      el("div", { className: "mini", text: "运行模式" }),
      modeBox,
      el("div", { className: "row" }, [
        el("span", { className: "mini", text: "匹配" }), matchSel,
        el("span", { className: "mini", text: "间隔ms" }), gapInput,
      ]),
      el("div", { className: "row" }, [btnStart, btnPause, btnProb]),
      el("div", { className: "row" }, [btnF, btnS, btnX, btnReset]),
      el("div", { className: "mini", text: "自动：匹配后点关注；成功后随机再等 10–15 秒才跳下一个（防验证码）。没找到仍按原逻辑等待。" }),
      status, logBox, importArea,
      el("div", { className: "row" }, [btnImport]),
    ]);
    panel.append(hd, bd);
    document.documentElement.appendChild(panel);
    makeDraggable(panel, hd);
    refreshMode();
    refresh();

    const boot = GM_getValue(K_BOOT, null);
    const params = new URLSearchParams(location.search);
    const fromBili = (boot && boot.start) || params.get("bds_sync") === "1";
    const cont = sessionStorage.getItem("bds_auto_continue") === "1";

    if (fromBili) {
      GM_setValue(K_BOOT, null);
      log("从 B站启动");
      setTimeout(() => start(true), 900);
    } else if (cont && location.pathname.includes("/search/")) {
      sessionStorage.setItem("bds_auto_continue", "0");
      log("续跑搜索页");
      setTimeout(() => { running = true; processOne(); }, 1000);
    } else if (loadList() && loadList().list) {
      status.textContent = "名单已就绪。选自动/手动后点开始。间隔默认 12 秒。";
    }
  }

  // boot
  if (isBili) {
    GM_registerMenuCommand("打开 B站面板", () => { if (!$("#bds-panel")) mountBili(); });
    mountBili();
  } else if (isDouyin) {
    GM_registerMenuCommand("打开抖音面板", () => { if (!$("#bds-panel")) mountDouyin(); });
    mountDouyin();
  }
})();
