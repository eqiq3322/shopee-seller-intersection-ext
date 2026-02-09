const keywordsInput = document.getElementById("keywordsInput");
const progressEl = document.getElementById("progress");
const resultCountEl = document.getElementById("resultCount");
const resultListEl = document.getElementById("resultList");
const statusEl = document.getElementById("status");
const btnClear = document.getElementById("btnClear");
const timerEl = document.getElementById("timer");
const openAllEl = document.getElementById("openAll");

const STORAGE_LISTS = "lists";
const STORAGE_EXPECTED = "expectedKeywords";
const STORAGE_LAST_ORIGIN = "lastOrigin";
const STORAGE_SHOP_NAMES = "shopNames";
const STORAGE_STATUS = "statusText";
const STORAGE_STATUS_TONE = "statusTone";
const STORAGE_RUNNING = "running";
const STORAGE_START = "startTimeMs";
const STORAGE_END = "endTimeMs";

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

function getIntersection(expected, lists) {
  if (expected.length < 2) return [];
  const arrays = expected.map(k => lists[k]?.sellers || []);
  const allCollected = arrays.every(a => a.length > 0);
  if (!allCollected) return [];
  return intersectSets(arrays);
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

function renderResult(expected, lists, origin) {
  resultListEl.innerHTML = "";
  if (expected.length < 2) {
    resultCountEl.textContent = "交集數量：0 家";
    return;
  }

  const inter = getIntersection(expected, lists);
  if (!inter.length) {
    resultCountEl.textContent = "交集數量：0 家";
    return;
  }
  resultCountEl.textContent = `交集數量：${inter.length} 家`;

  const frag = document.createDocumentFragment();
  for (const seller of inter) {
    const li = document.createElement("li");
    const { text, href } = sellerToLink(origin, seller);
    if (href) {
      const a = document.createElement("a");
      a.href = href;
      a.textContent = text;
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
  hydrateShopNames(inter, origin);
}

async function collectFromPage() {
  const expected = parseKeywords(keywordsInput.value);
  if (!expected.length) {
    setStatus("請輸入關鍵字（空白或逗號分隔）", "warn");
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

  await chrome.runtime.sendMessage({
    type: "START_COLLECT",
    expected,
    origin
  });
  setStatus("已送出開始指令（可關閉視窗）", "ok");
}

document.getElementById("btnStart").addEventListener("click", collectFromPage);

openAllEl.addEventListener("click", async (e) => {
  e.preventDefault();
  const data = await chrome.storage.local.get([STORAGE_LISTS, STORAGE_EXPECTED, STORAGE_LAST_ORIGIN]);
  const lists = data[STORAGE_LISTS] || {};
  const expected = data[STORAGE_EXPECTED] || [];
  const origin = data[STORAGE_LAST_ORIGIN] || "";
  const inter = getIntersection(expected, lists);
  if (!inter.length) return;
  for (const seller of inter) {
    const { href } = sellerToLink(origin, seller);
    if (href) {
      await chrome.tabs.create({ url: href, active: false });
    }
  }
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
    STORAGE_STATUS,
    STORAGE_STATUS_TONE,
    STORAGE_RUNNING,
    STORAGE_START,
    STORAGE_END
  ]);
  let lists = data[STORAGE_LISTS] || {};
  let expected = data[STORAGE_EXPECTED] || [];
  let origin = data[STORAGE_LAST_ORIGIN] || "";
  const statusText = data[STORAGE_STATUS] || "";
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

  renderProgress(expected, lists);
  renderResult(expected, lists, origin);

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
  const data = await chrome.storage.local.get([STORAGE_SHOP_NAMES]);
  return data[STORAGE_SHOP_NAMES] || {};
}

async function saveShopNamesCache(cache) {
  await chrome.storage.local.set({ [STORAGE_SHOP_NAMES]: cache });
}

async function resolveShopName(origin, shopId) {
  try {
    const url = `${origin}/shop/${shopId}`;
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) return "";
    const html = await resp.text();
    // Prefer og:title if present, fallback to <title>
    let title = "";
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (og) title = og[1].trim();
    if (!title) {
      const m = html.match(/<title>([^<]+)<\/title>/i);
      if (m) title = m[1].trim();
    }
    if (!title) return "";
    title = title.replace(/\s*\|\s*蝦皮購物.*$/i, "").trim();
    title = title.replace(/\s*-\s*Shopee.*$/i, "").trim();
    return title;
  } catch {
    return "";
  }
}

async function hydrateShopNames(inter, origin) {
  if (!origin) return;
  const cache = await getShopNamesCache();
  const ids = inter
    .filter(s => s.startsWith("SHOP_ID:"))
    .map(s => s.replace("SHOP_ID:", ""));

  const pending = ids.filter(id => !cache[id]);
  for (const id of pending) {
    const name = await resolveShopName(origin, id);
    if (name) {
      cache[id] = name;
      const link = resultListEl.querySelector(`a[data-shop-id="${id}"]`);
      if (link) link.textContent = name;
    }
  }
  if (pending.length) await saveShopNamesCache(cache);
}
