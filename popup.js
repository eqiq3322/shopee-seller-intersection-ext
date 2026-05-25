const keywordsInput = document.getElementById("keywordsInput");
const progressEl = document.getElementById("progress");
const resultCountEl = document.getElementById("resultCount");
const resultListEl = document.getElementById("resultList");
const statusEl = document.getElementById("status");
const btnClear = document.getElementById("btnClear");
const btnStop = document.getElementById("btnStop");
const timerEl = document.getElementById("timer");
const openAllEl = document.getElementById("openAll");
const strengthInput = document.getElementById("searchStrength");
const strengthValueEl = document.getElementById("searchStrengthValue");
const percentFillEl = document.getElementById("percentFill");
const percentTextEl = document.getElementById("percentText");
const intersectionVizEl = document.getElementById("intersectionViz");
const vennSvgEl = document.getElementById("vennSvg");
const vennCountEl = document.getElementById("vennCount");
const vennSetEls = ["A", "B", "C", "D"].map(k => document.getElementById(`set${k}`));
const vennCircleEls = ["A", "B", "C", "D"].map(k => document.getElementById(`circle${k}`));
const vennLabelEls = ["A", "B", "C", "D"].map(k => document.getElementById(`label${k}`));
const feedbackFormEl = document.getElementById("feedbackForm");
const feedbackInputEl = document.getElementById("feedbackInput");
const feedbackSendEl = document.getElementById("feedbackSend");
const feedbackStatusEl = document.getElementById("feedbackStatus");

// Fill this with your own Google Apps Script / Formspree / custom API endpoint.
// Leave empty to fall back to opening the user's email app with a pre-filled message.
const FEEDBACK_ENDPOINT = "https://script.google.com/macros/s/AKfycbxa77XOFkrgsydgWHskdD1N_IjUP-O7OAKs2G2DfYPunfekORgSVN7FuVRbF8K_id1ZEw/exec";
const FEEDBACK_EMAIL = "aaanappleaday@gmail.com";
let hasUserEditedKeywords = false;

const STORAGE_LISTS = "lists";
const STORAGE_EXPECTED = "expectedKeywords";
const STORAGE_LAST_ORIGIN = "lastOrigin";
const STORAGE_SHOP_NAMES = "shopNames";
const STORAGE_SHOP_NAMES_TRIED = "shopNamesTried";
const STORAGE_STATUS = "statusText";
const STORAGE_STATUS_TONE = "statusTone";
const STORAGE_RUNNING = "running";
const STORAGE_START = "startTimeMs";
const STORAGE_END = "endTimeMs";
const STORAGE_OPEN_ALL = "openAllInProgress";
const STORAGE_SEARCH_STRENGTH = "searchStrength";
const STORAGE_PROGRESS_META = "progressMeta";

let nameHydrationInProgress = false;
let transientStatusUntil = 0;
let transientStatusTimer = null;
let feedbackStatusUntil = 0;
let feedbackStatusTimer = null;

function t(key, substitutions) {
  try {
    return chrome.i18n.getMessage(key, substitutions) || key;
  } catch {
    return key;
  }
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    if (!key) return;
    el.textContent = t(key);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (!key) return;
    el.setAttribute("placeholder", t(key));
  });
  document.querySelectorAll("[data-i18n-title]").forEach(el => {
    const key = el.getAttribute("data-i18n-title");
    if (!key) return;
    const text = t(key);
    el.setAttribute("title", text);
    el.setAttribute("aria-label", text);
  });
  document.querySelectorAll("title[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    if (!key) return;
    el.textContent = t(key);
  });
}

applyI18n();

const defaultKeywordPlaceholder = keywordsInput?.getAttribute("placeholder") || "";
keywordsInput?.addEventListener("focus", () => {
  keywordsInput.setAttribute("placeholder", "");
  // Previous searches are kept for reference, but once the user edits this field,
  // storage sync should not keep writing the old keywords back into the input.
  if (!hasUserEditedKeywords && keywordsInput.value.trim()) {
    keywordsInput.select();
  }
});
keywordsInput?.addEventListener("input", () => {
  hasUserEditedKeywords = true;
});
keywordsInput?.addEventListener("blur", () => {
  if (!keywordsInput.value.trim()) {
    keywordsInput.setAttribute("placeholder", defaultKeywordPlaceholder);
  }
});

function setStatus(text, tone) {
  statusEl.textContent = text || "";
  statusEl.className = "muted";
  if (tone === "ok") statusEl.className = "muted ok";
  if (tone === "warn") statusEl.className = "muted warn";
}

function setTransientStatus(text, tone, ms = 3000) {
  transientStatusUntil = Date.now() + ms;
  setStatus(text, tone);
  if (transientStatusTimer) clearTimeout(transientStatusTimer);
  transientStatusTimer = setTimeout(() => {
    if (Date.now() >= transientStatusUntil) {
      transientStatusUntil = 0;
      setStatus("", "muted");
      syncFromStorage().catch(() => null);
    }
  }, ms);
}

function setFeedbackStatus(text, tone) {
  if (!feedbackStatusEl) return;
  feedbackStatusEl.textContent = text || "";
  feedbackStatusEl.className = "muted feedback-status";
  if (tone === "ok") feedbackStatusEl.className = "muted feedback-status ok";
  if (tone === "warn") feedbackStatusEl.className = "muted feedback-status warn";
}

function setTransientFeedbackStatus(text, tone, ms = 3000) {
  feedbackStatusUntil = Date.now() + ms;
  setFeedbackStatus(text, tone);
  if (feedbackStatusTimer) clearTimeout(feedbackStatusTimer);
  feedbackStatusTimer = setTimeout(() => {
    if (Date.now() >= feedbackStatusUntil) {
      feedbackStatusUntil = 0;
      setFeedbackStatus("", "muted");
    }
  }, ms);
}

function setTimerText(text) {
  if (timerEl) timerEl.textContent = text || t("timerZero");
}

function getFeedbackEndpointUrl() {
  const raw = String(FEEDBACK_ENDPOINT || "").trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid feedback endpoint URL");
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("Feedback endpoint must use http or https");
  }
  return url;
}

async function openFeedbackMailto(payload) {
  const subject = encodeURIComponent("Shopee extension feedback");
  const body = encodeURIComponent(`${payload.feedback}

---
Version: ${payload.version}
Locale: ${payload.locale}
Shop Domain: ${payload.shopDomain || "unknown"}
Page Type: ${payload.pageType || "other"}`);
  await chrome.tabs.create({
    url: `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${body}`,
    active: true
  });
}

async function sendFeedbackToEndpoint(url, payload) {
  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "follow"
  });

  if (!resp.ok) {
    throw new Error(`Feedback endpoint HTTP ${resp.status}`);
  }

  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    const preview = text ? text.slice(0, 120).replace(/\s+/g, " ") : "(empty response)";
    throw new Error(`Feedback endpoint returned non-JSON: ${preview}`);
  }

  if (!data || data.ok !== true) {
    throw new Error(`Feedback endpoint rejected request: ${text || "(empty response)"}`);
  }
}

function clampPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function renderPercentProgress(meta, running, expected, lists) {
  let percent = 0;
  if (meta && Number.isFinite(Number(meta.percent))) {
    percent = clampPercent(meta.percent);
  } else if (expected.length) {
    const done = expected.filter(k => (lists[k]?.sellers || []).length > 0).length;
    percent = clampPercent((done / expected.length) * 100);
  }
  if (!running && expected.length && expected.every(k => (lists[k]?.sellers || []).length > 0)) {
    percent = Math.max(percent, 100);
  }
  if (percentFillEl) percentFillEl.style.width = `${percent}%`;
  if (percentTextEl) percentTextEl.textContent = `${percent}%`;
}

function compactLabel(text) {
  const s = String(text || "").trim();
  if (!s) return "?";
  return s.length > 6 ? `${s.slice(0, 6)}…` : s;
}

function getVennLayout(count, compactFour = false) {
  const fill = [
    "rgba(255, 217, 202, 0.72)",
    "rgba(183, 234, 216, 0.72)",
    "rgba(255, 233, 167, 0.72)",
    "rgba(162, 221, 255, 0.72)"
  ];

  if (count === 2) {
    return {
      center: { x: 160, y: 82 },
      sets: [
        { cx: 124, cy: 78, r: 46, lx: 98, ly: 78, fill: fill[0] },
        { cx: 196, cy: 78, r: 46, lx: 222, ly: 78, fill: fill[1] }
      ]
    };
  }

  if (count === 3) {
    return {
      center: { x: 160, y: 82 },
      sets: [
        { cx: 122, cy: 62, r: 40, lx: 110, ly: 44, fill: fill[0] },
        { cx: 198, cy: 62, r: 40, lx: 210, ly: 44, fill: fill[1] },
        { cx: 160, cy: 102, r: 40, lx: 160, ly: 122, fill: fill[2] }
      ]
    };
  }

  if (count === 4) {
    // During search, keep the circles slightly spread out so users can see all sets.
    // After search finishes, compactFour pulls the four circles inward so the center
    // point is inside all four circles and the count is placed in the true A∩B∩C∩D area.
    if (!compactFour) {
      return {
        center: { x: 160, y: 82 },
        sets: [
          { cx: 160, cy: 42, r: 40, lx: 160, ly: 18, fill: "rgba(71, 95, 177, 0.78)" },
          { cx: 108, cy: 82, r: 40, lx: 72, ly: 82, fill: "rgba(255, 107, 107, 0.74)" },
          { cx: 160, cy: 122, r: 40, lx: 160, ly: 146, fill: "rgba(255, 205, 86, 0.74)" },
          { cx: 212, cy: 82, r: 40, lx: 248, ly: 82, fill: "rgba(88, 214, 255, 0.74)" }
        ]
      };
    }

    return {
      center: { x: 160, y: 84 },
      sets: [
        { cx: 160, cy: 60, r: 56, lx: 160, ly: 22, fill: "rgba(71, 95, 177, 0.78)" },
        { cx: 132, cy: 84, r: 56, lx: 82, ly: 84, fill: "rgba(255, 107, 107, 0.74)" },
        { cx: 160, cy: 108, r: 56, lx: 160, ly: 146, fill: "rgba(255, 205, 86, 0.74)" },
        { cx: 188, cy: 84, r: 56, lx: 238, ly: 84, fill: "rgba(88, 214, 255, 0.74)" }
      ]
    };
  }

  return null;
}

function hideIntersectionViz() {
  if (!intersectionVizEl) return;
  intersectionVizEl.classList.add("hidden");
  intersectionVizEl.classList.remove("running");
}

function showIntersectionViz() {
  if (!intersectionVizEl) return;
  intersectionVizEl.classList.remove("hidden");
}

function renderIntersectionViz(expected, lists, running) {
  if (!intersectionVizEl || !vennSvgEl || !vennCountEl) return;

  const count = expected.length;
  if (count < 2 || count > 4) {
    hideIntersectionViz();
    return;
  }

  const compactFour = count === 4 && !running;
  const layout = getVennLayout(count, compactFour);
  if (!layout) {
    hideIntersectionViz();
    return;
  }

  showIntersectionViz();
  intersectionVizEl.classList.toggle("running", !!running);
  intersectionVizEl.classList.toggle("settled", compactFour);

  vennCountEl.setAttribute("x", String(layout.center.x));
  vennCountEl.setAttribute("y", String(layout.center.y));

  const inter = getIntersection(expected, lists);
  vennCountEl.textContent = String(inter.length);

  vennSetEls.forEach((setEl, idx) => {
    const cfg = layout.sets[idx];
    const circleEl = vennCircleEls[idx];
    const labelEl = vennLabelEls[idx];

    if (!setEl || !circleEl || !labelEl) return;

    if (!cfg) {
      setEl.style.display = "none";
      return;
    }

    setEl.style.display = "";
    circleEl.setAttribute("cx", String(cfg.cx));
    circleEl.setAttribute("cy", String(cfg.cy));
    circleEl.setAttribute("r", String(cfg.r));
    circleEl.setAttribute("fill", cfg.fill);

    labelEl.setAttribute("x", String(cfg.lx));
    labelEl.setAttribute("y", String(cfg.ly));
    labelEl.textContent = compactLabel(expected[idx] || String.fromCharCode(65 + idx));
  });
}

function normalizeKeyword(k) {
  return (k || "").trim();
}

function parseKeywords(input) {
  const raw = (input || "");
  const hasComma = /,/.test(raw);
  const parts = raw
    .split(hasComma ? /,+/ : /\s+/)
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

async function getFeedbackContext() {
  try {
    const tab = await getActiveTab();
    const currentPage = typeof tab?.url === "string" ? tab.url : "";
    let shopDomain = "";
    let pageType = "other";

    if (currentPage) {
      try {
        const url = new URL(currentPage);
        shopDomain = url.hostname || "";
        const path = url.pathname || "";
        if (/\/search(?:\/|$)/.test(path)) pageType = "search";
        else if (/\/shop(?:\/|$)/.test(path)) pageType = "shop";
        else if (/\/product(?:\/|$)/.test(path) || /-i\.\d+\.\d+/.test(path)) pageType = "product";
      } catch {
        shopDomain = "";
        pageType = "other";
      }
    }

    if (!shopDomain) {
      const data = await chrome.storage.local.get([STORAGE_LAST_ORIGIN]);
      const lastOrigin = String(data[STORAGE_LAST_ORIGIN] || "");
      if (lastOrigin) {
        try {
          shopDomain = new URL(lastOrigin).hostname || "";
        } catch {
          shopDomain = "";
        }
      }
    }

    return { shopDomain, pageType };
  } catch {
    try {
      const data = await chrome.storage.local.get([STORAGE_LAST_ORIGIN]);
      const lastOrigin = String(data[STORAGE_LAST_ORIGIN] || "");
      const shopDomain = lastOrigin ? new URL(lastOrigin).hostname || "" : "";
      return { shopDomain, pageType: "other" };
    } catch {
      return { shopDomain: "", pageType: "other" };
    }
  }
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
    progressEl.textContent = t("progressIdle");
    return;
  }

  progressEl.textContent = "";
  const frag = document.createDocumentFragment();
  expected.forEach(k => {
    const count = (lists[k]?.sellers || []).length;
    const row = document.createElement("div");
    if (count > 0) {
      row.className = "progress-item ok";
      row.textContent = t("progressItem", [k, String(count)]);
      frag.appendChild(row);
      return;
    }
    row.className = "progress-item warn";
    row.textContent = t("progressItemEmpty", [k]);
    frag.appendChild(row);
  });
  progressEl.appendChild(frag);
}

function renderResult(expected, lists, origin) {
  resultListEl.innerHTML = "";
  if (expected.length < 2) {
    resultCountEl.textContent = t("resultCountZero");
    return;
  }

  const inter = getIntersection(expected, lists);
  if (!inter.length) {
    resultCountEl.textContent = t("resultCountZero");
    return;
  }
  resultCountEl.textContent = t("resultCount", [String(inter.length)]);

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
    setStatus(t("statusNeedKeywords"), "warn");
    return;
  }

  setTimerText(t("timerRunning"));

  const tab = await getActiveTab();
  if (!tab?.id) {
    setStatus(t("statusNoTab"), "warn");
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
    setTransientStatus(t("statusNotShopee"), "warn", 3000);
    return;
  }

  const strength = clampStrength(strengthInput?.value);
  setStrengthUI(strength);
  await saveStrength(strength);

  await chrome.runtime.sendMessage({
    type: "START_COLLECT",
    expected,
    origin,
    tabId: tab.id,
    pagesToScan: strength
  });
  hasUserEditedKeywords = false;
  setStatus(t("statusStarted"), "ok");
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
  // Keep navigation stable: open the shop page URL directly.
  e.preventDefault();
  window.open(link.href, "_blank", "noreferrer");
});

openAllEl.addEventListener("click", async (e) => {
  e.preventDefault();
  if (openAllEl.disabled) return;
  openAllEl.disabled = true;
  openAllEl.textContent = "已開啟";
  const data = await chrome.storage.local.get([
    STORAGE_LISTS,
    STORAGE_EXPECTED,
    STORAGE_LAST_ORIGIN
  ]);
  const lists = data[STORAGE_LISTS] || {};
  const expected = data[STORAGE_EXPECTED] || [];
  const origin = data[STORAGE_LAST_ORIGIN] || "";
  const inter = getIntersection(expected, lists);
  if (!inter.length) {
    return;
  }
  const urls = inter
    .map(seller => sellerToLink(origin, seller).href)
    .filter(Boolean);
  if (!urls.length) return;
  await chrome.runtime.sendMessage({ type: "OPEN_ALL_TABS", urls }).catch(() => null);
});

btnStop?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_COLLECT" }).catch(() => null);
  await chrome.storage.local.set({
    [STORAGE_RUNNING]: false,
    [STORAGE_END]: Date.now(),
    [STORAGE_STATUS]: t("statusStoppedByUser"),
    [STORAGE_STATUS_TONE]: "warn"
  }).catch(() => null);
  hasUserEditedKeywords = true;
  setStatus(t("statusStoppedByUser"), "warn");
  setTimerText(t("timerZero"));
  keywordsInput?.focus();
});

btnClear?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_COLLECT" }).catch(() => null);
  await chrome.storage.local.clear();
  keywordsInput.value = "";
  hasUserEditedKeywords = false;
  renderProgress([], {});
  renderResult([], {}, "");
  renderPercentProgress(null, false, [], {});
  renderIntersectionViz([], {}, false);
  setStatus(t("statusCleared"), "ok");
  setTimerText(t("timerZero"));
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
    STORAGE_SEARCH_STRENGTH,
    STORAGE_PROGRESS_META
  ]);
  let lists = data[STORAGE_LISTS] || {};
  let expected = data[STORAGE_EXPECTED] || [];
  let origin = data[STORAGE_LAST_ORIGIN] || "";
  const storedStrength = clampStrength(data[STORAGE_SEARCH_STRENGTH] || 6);
  const progressMeta = data[STORAGE_PROGRESS_META] || null;
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
    setStatus(t("statusEncodingIssue"), "warn");
  } else if (statusText && Date.now() >= transientStatusUntil) {
    setStatus(statusText, statusTone);
  }

  if (expected.length && !hasUserEditedKeywords && document.activeElement !== keywordsInput) {
    keywordsInput.value = expected.join(" ");
  }

  setStrengthUI(storedStrength);

  renderProgress(expected, lists);
  renderResult(expected, lists, origin);
  renderPercentProgress(progressMeta, running, expected, lists);
  renderIntersectionViz(expected, lists, running);
  const inter = getIntersection(expected, lists);
  if (!running && inter.length) {
    hydrateShopNames(inter, origin);
  }


  if (running && startMs) {
    const elapsedSec = (Date.now() - startMs) / 1000;
    setTimerText(t("timerElapsed", [elapsedSec.toFixed(1)]));
  } else if (startMs && endMs) {
    const elapsedSec = (endMs - startMs) / 1000;
    setTimerText(t("timerElapsed", [elapsedSec.toFixed(1)]));
  } else {
    setTimerText(t("timerZero"));
  }
}

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") syncFromStorage();
});

setInterval(syncFromStorage, 1500);
syncFromStorage();

feedbackFormEl?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = (feedbackInputEl?.value || "").trim();
  if (!text) {
    setStatus(t("feedbackEmpty"), "warn");
    return;
  }
  const previousLabel = feedbackSendEl?.textContent || t("feedbackSend");
  if (feedbackSendEl) {
    feedbackSendEl.disabled = true;
    feedbackSendEl.textContent = t("feedbackSending");
  }
  const feedbackContext = await getFeedbackContext();
  const payload = {
    feedback: text,
    version: chrome.runtime?.getManifest?.().version || "",
    locale: chrome.i18n?.getUILanguage?.() || "",
    shopDomain: feedbackContext.shopDomain,
    pageType: feedbackContext.pageType
  };
  try {
    const endpointUrl = getFeedbackEndpointUrl();
    if (endpointUrl) {
      await sendFeedbackToEndpoint(endpointUrl, payload);
      feedbackInputEl.value = "";
      setTransientFeedbackStatus(t("feedbackSent"), "ok", 8000);
    } else {
      await openFeedbackMailto(payload);
      feedbackInputEl.value = "";
      setTransientFeedbackStatus(t("feedbackMailto"), "ok", 8000);
    }
  } catch (err) {
    console.error("Feedback submit failed", err);
    const message = err && err.message ? err.message : "Unknown error";
    setTransientFeedbackStatus(`${t("feedbackFailed")}: ${message}`, "warn", 12000);
  } finally {
    if (feedbackSendEl) {
      feedbackSendEl.disabled = false;
      feedbackSendEl.textContent = previousLabel;
    }
  }
});

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
      }
      await new Promise(r => setTimeout(r, 120));
    }

    await saveShopNamesCache(names, tried);
  } finally {
    nameHydrationInProgress = false;
  }
}
