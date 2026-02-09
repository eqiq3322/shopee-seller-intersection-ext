const keywordsInput = document.getElementById("keywordsInput");
const progressEl = document.getElementById("progress");
const resultCountEl = document.getElementById("resultCount");
const resultListEl = document.getElementById("resultList");
const statusEl = document.getElementById("status");
const btnClear = document.getElementById("btnClear");
const timerEl = document.getElementById("timer");
const openAllEl = document.getElementById("openAll");
const strengthInput = document.getElementById("searchStrength");
const strengthValueEl = document.getElementById("searchStrengthValue");

const STORAGE_LISTS = "lists";
const STORAGE_EXPECTED = "expectedKeywords";
const STORAGE_LAST_ORIGIN = "lastOrigin";
const STORAGE_SHOP_NAMES = "shopNames";
const STORAGE_STATUS = "statusText";
const STORAGE_STATUS_TONE = "statusTone";
const STORAGE_RUNNING = "running";
const STORAGE_START = "startTimeMs";
const STORAGE_END = "endTimeMs";
const STORAGE_SHOP_NAMES_TRIED = "shopNamesTried";
const STORAGE_OPEN_ALL = "openAllInProgress";
const STORAGE_SEARCH_STRENGTH = "searchStrength";
const STORAGE_BLOCKED_SHOPS = "blockedShops";

let nameHydrationInProgress = false;

function setStatus(text, tone) {
  statusEl.textContent = text || "";
  statusEl.className = "muted";
  if (tone === "ok") statusEl.className = "muted ok";
  if (tone === "warn") statusEl.className = "muted warn";
}

function setTimerText(text) {
  if (timerEl) timerEl.textContent = text || "計時：0 秒";
}

function normalizeKeyword(k) {
  return (k || "").trim();
}

function parseKeywords(input) {
  const parts = (input || "")
    .split(/[\s,，、]+/)
    .map(normalizeKeyword)
    .filter(Boolean);
  return Array.from(new Set(parts));
}

function clampStrength(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 6;
  const even = Math.round(n / 2) * 2;
  return Math.min(20, Math.max(2, even));
}

async function saveStrength(v) {
  await chrome.storage.local.set({ [STORAGE_SEARCH_STRENGTH]: v });
}

function setStrengthUI(v) {
  if (strengthInput) strengthInput.value = String(v);
  if (strengthValueEl) strengthValueEl.textContent = String(v);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function intersectSets(arrays) {
  if (arrays.length === 0) return [];
  arrays.sort((a, b) => a.length - b.length);
  const base = new Set(arrays[0]);
  for (let i = 1; i < arrays.length; i++) {
    const s = new Set(arrays[i]);
    for (const v of Array.from(base)) {
      if (!s.has(v)) base.delete(v);
    }
  }
  return Array.from(base);
}

function getIntersection(expected, lists, blockedSet) {
  if (expected.length < 2) return [];
  const arrays = expected.map(k => lists[k]?.sellers || []);
  const allCollected = arrays.every(a => a.length > 0);
  if (!allCollected) return [];
  const inter = intersectSets(arrays);
  if (!blockedSet || blockedSet.size === 0) return inter;
  return inter.filter(s => {
    if (!s.startsWith("SHOP_ID:")) return true;
    const id = s.replace("SHOP_ID:", "");
    return !blockedSet.has(id);
  });
}

function toAbsoluteLink(origin, href) {
  try {
    return new URL(href, origin).toString();
  } catch {
    return href;
  }
}

function sellerToLink(origin, seller) {
  if (seller.startsWith("SHOP_ID:")) {
    const id = seller.replace("SHOP_ID:", "");
    return { text: "shop " + id, href: origin ? (origin + "/shop/" + id) : ("/shop/" + id) };
  }
  if (seller.startsWith("SHOP_LINK:")) {
    const path = seller.replace("SHOP_LINK:", "");
    return { text: path, href: toAbsoluteLink(origin, path) };
  }
  if (seller.startsWith("STORE_LINK:")) {
    const path = seller.replace("STORE_LINK:", "");
    return { text: path, href: toAbsoluteLink(origin, path) };
  }
  if (origin) {
    const q = encodeURIComponent(seller);
    return { text: seller, href: `${origin}/search?keyword=${q}` };
  }
  return { text: seller, href: "" };
}

function renderProgress(expected, lists) {
  if (!expected.length) {
    progressEl.textContent = "(尚未開始)";
    return;
  }

  const rows = expected.map(k => {
    const count = (lists[k]?.sellers || []).length;
    if (count > 0) {
      return `<div class="progress-item ok">${k}：已收集 ${count} 家</div>`;
    }
    return `<div class="progress-item warn">${k}：尚未收集</div>`;
  });
  progressEl.innerHTML = rows.join("");
}

function renderResult(expected, lists, origin, blockedSet) {
  resultListEl.innerHTML = "";
  if (expected.length < 2) {
    resultCountEl.textContent = "交集數量：0 家";
    return;
  }

  const inter = getIntersection(expected, lists, blockedSet);
  if (!inter.length) {
    resultCountEl.textContent = "交集數量：0 家";
    return;
  }
  resultCountEl.textContent = `交集數量：${inter.length} 家`;

  const frag = document.createDocumentFragment();
  const nameMap = (window.__shopNameMap || {});
  for (const seller of inter) {
    const li = document.createElement("li");
    const { text, href } = sellerToLink(origin, seller);
    if (href) {
      const a = document.createElement("a");
      a.href = href;
      if (seller.startsWith("SHOP_ID:")) {
        const id = seller.replace("SHOP_ID:", "");
        a.textContent = nameMap[id] || text;
      } else {
        a.textContent = text;
      }
      if (seller.startsWith("SHOP_ID:")) {
        a.dataset.shopId = seller.replace("SHOP_ID:", "");
      }
      a.target = "_blank";
      a.rel = "noreferrer";
      li.appendChild(a);
    } else {
      li.textContent = text;
    }
    frag.appendChild(li);
  }
  resultListEl.appendChild(frag);
}

async function collectFromPage() {
  const expected = parseKeywords(keywordsInput.value);
  if (!expected.length) {
    setStatus("請輸入關鍵字（空白鍵分隔）", "warn");
    return;
  }

  setTimerText("計時：進行中…");

  const tab = await getActiveTab();
  if (!tab?.id) {
    setStatus("無法取得目前分頁", "warn");
    return;
  }

  const origin = (() => {
    try {
      return new URL(tab.url).origin;
    } catch {
      return "";
    }
  })();

  if (!origin || !origin.includes("shopee")) {
    setStatus("請在蝦皮網站分頁執行", "warn");
    return;
  }

  const strength = clampStrength(strengthInput?.value);
  setStrengthUI(strength);
  await saveStrength(strength);

  await chrome.runtime.sendMessage({
    type: "START_COLLECT",
    expected,
    origin,
    pagesToScan: strength
  });
  setStatus("已送出開始指令（可關閉視窗）", "ok");
}

document.getElementById("btnStart").addEventListener("click", collectFromPage);

strengthInput?.addEventListener("input", () => {
  const v = clampStrength(strengthInput.value);
  setStrengthUI(v);
});

strengthInput?.addEventListener("change", () => {
  const v = clampStrength(strengthInput.value);
  setStrengthUI(v);
  saveStrength(v).catch(() => null);
});

resultListEl.addEventListener("click", async (e) => {
  const link = e.target?.closest?.("a[data-shop-id]");
  if (!link) return;
  e.preventDefault();

  const shopId = link.dataset.shopId;
  if (!shopId) return;

  const data = await chrome.storage.local.get([STORAGE_EXPECTED, STORAGE_LAST_ORIGIN]);
  const expected = data[STORAGE_EXPECTED] || [];
  const origin = data[STORAGE_LAST_ORIGIN] || "";

  if (!origin || !expected.length) {
    // Fallback to normal behavior if no keywords/origin
    window.open(link.href, "_blank", "noreferrer");
    return;
  }

  for (const keyword of expected) {
    const q = encodeURIComponent(keyword);
    const url = `${origin}/shop/${shopId}/search?keyword=${q}`;
    await chrome.tabs.create({ url, active: false });
  }
});

openAllEl.addEventListener("click", async (e) => {
  e.preventDefault();
  if (openAllEl.disabled) return;
  openAllEl.disabled = true;
  openAllEl.textContent = "已開啟";
  const data = await chrome.storage.local.get([
    STORAGE_LISTS,
    STORAGE_EXPECTED,
    STORAGE_LAST_ORIGIN,
    STORAGE_BLOCKED_SHOPS
  ]);
  const lists = data[STORAGE_LISTS] || {};
  const expected = data[STORAGE_EXPECTED] || [];
  const origin = data[STORAGE_LAST_ORIGIN] || "";
  const blocked = new Set(data[STORAGE_BLOCKED_SHOPS] || []);
  const inter = getIntersection(expected, lists, blocked);
  if (!inter.length) {
    return;
  }
  const urls = inter
    .map(seller => sellerToLink(origin, seller).href)
    .filter(Boolean);
  if (!urls.length) return;
  await chrome.runtime.sendMessage({ type: "OPEN_ALL_TABS", urls }).catch(() => null);
});

btnClear.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_COLLECT" }).catch(() => null);
  await chrome.storage.local.clear();
  keywordsInput.value = "";
  renderProgress([], {});
  renderResult([], {}, "");
  setStatus("已清除暫存", "ok");
  setTimerText("計時：0 秒");
});

async function syncFromStorage() {
  const data = await chrome.storage.local.get([
    STORAGE_LISTS,
    STORAGE_EXPECTED,
    STORAGE_LAST_ORIGIN,
    STORAGE_SHOP_NAMES,
    STORAGE_STATUS,
    STORAGE_STATUS_TONE,
    STORAGE_RUNNING,
    STORAGE_START,
    STORAGE_END,
    STORAGE_OPEN_ALL,
    STORAGE_BLOCKED_SHOPS,
    STORAGE_SEARCH_STRENGTH
  ]);
  let lists = data[STORAGE_LISTS] || {};
  let expected = data[STORAGE_EXPECTED] || [];
  let origin = data[STORAGE_LAST_ORIGIN] || "";
  const blocked = new Set(data[STORAGE_BLOCKED_SHOPS] || []);
  const storedStrength = clampStrength(data[STORAGE_SEARCH_STRENGTH] || 6);
  const statusText = data[STORAGE_STATUS] || "";
  window.__shopNameMap = data[STORAGE_SHOP_NAMES] || {};
  const statusTone = data[STORAGE_STATUS_TONE] || "muted";
  const running = !!data[STORAGE_RUNNING];
  const startMs = data[STORAGE_START] || 0;
  const endMs = data[STORAGE_END] || 0;
  if (expected.some(k => /\uFFFD/.test(k))) {
    await chrome.storage.local.clear();
    lists = {};
    expected = [];
    origin = "";
    setStatus("偵測到亂碼，已清除暫存，請重新收集", "warn");
  } else if (statusText) {
    setStatus(statusText, statusTone);
  }

  if (expected.length) {
    keywordsInput.value = expected.join(" ");
  }

  setStrengthUI(storedStrength);

  renderProgress(expected, lists);
  renderResult(expected, lists, origin, blocked);
  const inter = getIntersection(expected, lists, blocked);
  if (!running && inter.length) {
    hydrateBlockedShops(inter, origin);
    hydrateShopNames(inter, origin);
  }


  if (running && startMs) {
    const elapsedSec = (Date.now() - startMs) / 1000;
    setTimerText(`計時：${elapsedSec.toFixed(1)} 秒`);
  } else if (startMs && endMs) {
    const elapsedSec = (endMs - startMs) / 1000;
    setTimerText(`計時：${elapsedSec.toFixed(1)} 秒`);
  } else {
    setTimerText("計時：0 秒");
  }
}

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") syncFromStorage();
});

setInterval(syncFromStorage, 1500);
syncFromStorage();

async function getShopNamesCache() {
  const data = await chrome.storage.local.get([STORAGE_SHOP_NAMES, STORAGE_SHOP_NAMES_TRIED]);
  return {
    names: data[STORAGE_SHOP_NAMES] || {},
    tried: new Set(data[STORAGE_SHOP_NAMES_TRIED] || [])
  };
}

async function saveShopNamesCache(names, tried) {
  await chrome.storage.local.set({
    [STORAGE_SHOP_NAMES]: names,
    [STORAGE_SHOP_NAMES_TRIED]: Array.from(tried)
  });
}

async function fetchShopNameFromApi(origin, shopId) {
  try {
    const url = `${origin}/api/v4/shop/get_shop_detail?shopid=${encodeURIComponent(shopId)}`;
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) return "";
    const data = await resp.json();
    const name = data?.data?.name || data?.data?.shop_name || "";
    return String(name || "").trim();
  } catch {
    return "";
  }
}

async function getBlockedShopsCache() {
  const data = await chrome.storage.local.get([STORAGE_BLOCKED_SHOPS]);
  return new Set(data[STORAGE_BLOCKED_SHOPS] || []);
}

async function saveBlockedShopsCache(blockedSet) {
  await chrome.storage.local.set({
    [STORAGE_BLOCKED_SHOPS]: Array.from(blockedSet)
  });
}

function isBlockedShopHtml(html) {
  if (!html) return false;
  return /此賣場已被蝦皮封鎖或凍結/i.test(html);
}

async function checkShopBlocked(origin, shopId) {
  try {
    const url = `${origin}/shop/${shopId}`;
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) return false;
    const html = await resp.text();
    return isBlockedShopHtml(html);
  } catch {
    return false;
  }
}

// NOTE: name resolution uses API only (no DOM parsing)

async function hydrateShopNames(inter, origin) {
  if (!origin || nameHydrationInProgress) return;
  nameHydrationInProgress = true;
  try {
    const { names, tried } = await getShopNamesCache();
    const ids = inter
      .filter(s => s.startsWith("SHOP_ID:"))
      .map(s => s.replace("SHOP_ID:", ""));

    const pending = ids.filter(id => !names[id] && !tried.has(id));
    if (!pending.length) return;

    for (const id of pending) {
      tried.add(id);
      const name = await fetchShopNameFromApi(origin, id);
      if (name) {
        names[id] = name;
        const link = resultListEl.querySelector(`a[data-shop-id="${id}"]`);
        if (link) link.textContent = name;
      }
      await new Promise(r => setTimeout(r, 150));
    }

    await saveShopNamesCache(names, tried);
  } finally {
    nameHydrationInProgress = false;
  }
}

async function hydrateBlockedShops(inter, origin) {
  if (!origin) return;
  const blocked = await getBlockedShopsCache();
  const ids = inter
    .filter(s => s.startsWith("SHOP_ID:"))
    .map(s => s.replace("SHOP_ID:", ""));

  const pending = ids.filter(id => !blocked.has(id));
  if (!pending.length) return;

  for (const id of pending) {
    const isBlocked = await checkShopBlocked(origin, id);
    if (isBlocked) blocked.add(id);
    await new Promise(r => setTimeout(r, 150));
  }

  await saveBlockedShopsCache(blocked);
}
