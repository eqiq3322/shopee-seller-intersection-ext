const STORAGE_LISTS = "lists";
const STORAGE_EXPECTED = "expectedKeywords";
const STORAGE_LAST_ORIGIN = "lastOrigin";
const STORAGE_STATUS = "statusText";
const STORAGE_STATUS_TONE = "statusTone";
const STORAGE_RUNNING = "running";
const STORAGE_START = "startTimeMs";
const STORAGE_END = "endTimeMs";
const STORAGE_OPEN_ALL = "openAllInProgress";

// Speed + coverage tuning
const DEFAULT_PAGES_TO_SCAN = 6;   // default pages per keyword (slider min 2 max 20)
const TAB_TIMEOUT_MS = 15000;       // wait for page load
const POLL_MAX_ATTEMPTS = 5;        // collect attempts per page
const POLL_INTERVAL_MS = 1500;      // interval between attempts
const POLL_MIN_COUNT = 30;          // accept early if sellers >= this

let currentRunId = 0;
let openAllQueue = [];
let openAllTimer = null;
let openAllInProgress = false;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizePagesToScan(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_PAGES_TO_SCAN;
  const even = Math.round(n / 2) * 2;
  return Math.min(20, Math.max(2, even));
}

function t(key, substitutions) {
  try {
    return chrome.i18n.getMessage(key, substitutions) || key;
  } catch {
    return key;
  }
}

function setStatus(text, tone) {
  return chrome.storage.local.set({
    [STORAGE_STATUS]: text || "",
    [STORAGE_STATUS_TONE]: tone || "muted"
  });
}

async function saveLists(lists) {
  await chrome.storage.local.set({ [STORAGE_LISTS]: lists });
}

async function getLists() {
  const data = await chrome.storage.local.get([STORAGE_LISTS]);
  return data[STORAGE_LISTS] || {};
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }, timeoutMs);

    const listener = (id, info) => {
      if (id === tabId && info.status === "complete" && !done) {
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function pollCollect(tabId, { maxAttempts, intervalMs, minCount }) {
  let best = [];
  for (let i = 0; i < maxAttempts; i++) {
    await delay(intervalMs);
    const resp = await chrome.tabs.sendMessage(tabId, { type: "COLLECT_SELLERS" }).catch(() => null);
    if (resp && resp.ok) {
      const sellers = resp.sellers || [];
      if (sellers.length > best.length) best = sellers;
      if (sellers.length >= minCount) return sellers;
    }
  }
  return best;
}

async function autoCollectInTabs(expected, origin, runId, pagesToScan, tabId) {
  const lists = await getLists();
  const queue = expected.slice();
  const pageCount = normalizePagesToScan(pagesToScan);

  for (const keyword of queue) {
    if (runId !== currentRunId) break;
    if (!tabId) break;

    const sellersSet = new Set();
    const url = `${origin}/search?keyword=${encodeURIComponent(keyword)}&page=0`;
    try {
      await chrome.tabs.update(tabId, { url });
    } catch {
      await setStatus(t("statusAnalysisStopped"), "warn");
      break;
    }
    await waitForTabComplete(tabId, TAB_TIMEOUT_MS);

    for (let page = 0; page < pageCount; page++) {
      if (runId !== currentRunId) break;

      await setStatus(t("statusAnalyzing", [keyword, String(page + 1), String(pageCount)]), "ok");
      if (page > 0) {
        const pageUrl = `${origin}/search?keyword=${encodeURIComponent(keyword)}&page=${page}`;
        try {
          await chrome.tabs.update(tabId, { url: pageUrl });
        } catch {
          await setStatus(t("statusAnalysisStopped"), "warn");
          break;
        }
        await waitForTabComplete(tabId, TAB_TIMEOUT_MS);
      }

      const sellers = await pollCollect(tabId, {
        maxAttempts: POLL_MAX_ATTEMPTS,
        intervalMs: POLL_INTERVAL_MS,
        minCount: POLL_MIN_COUNT
      });
      for (const s of sellers) sellersSet.add(s);
      await delay(250);
    }

    if (runId !== currentRunId) break;

    const sellers = Array.from(sellersSet);
    if (sellers.length) {
      lists[keyword] = {
        updatedAt: new Date().toISOString(),
        page: `${origin}/search?keyword=${encodeURIComponent(keyword)}`,
        sellers
      };
      await saveLists(lists);
      await setStatus(t("statusDone", [keyword]), "ok");
    } else {
      await setStatus(t("statusFailed", [keyword]), "warn");
    }
  }
}

async function startCollect(expected, origin, pagesToScan, tabId) {
  currentRunId += 1;
  const runId = currentRunId;

  await chrome.storage.local.set({
    [STORAGE_EXPECTED]: expected,
    [STORAGE_LAST_ORIGIN]: origin,
    [STORAGE_RUNNING]: true,
    [STORAGE_START]: Date.now(),
    [STORAGE_END]: 0
  });
  await saveLists({});
  await setStatus(t("statusStarting"), "ok");

  await autoCollectInTabs(expected, origin, runId, pagesToScan, tabId);

  if (runId === currentRunId) {
    await chrome.storage.local.set({
      [STORAGE_RUNNING]: false,
      [STORAGE_END]: Date.now()
    });
    await setStatus(t("statusComplete"), "ok");
  }
}

function stopCollect() {
  currentRunId += 1;
  return chrome.storage.local.set({
    [STORAGE_RUNNING]: false,
    [STORAGE_END]: Date.now()
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "START_COLLECT") {
    const { expected, origin, pagesToScan, tabId } = msg;
    startCollect(expected, origin, pagesToScan, tabId)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === "STOP_COLLECT") {
    stopCollect()
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === "OPEN_ALL_TABS") {
    const urls = Array.isArray(msg.urls) ? msg.urls : [];
    enqueueOpenAll(urls)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  return false;
});

async function enqueueOpenAll(urls) {
  if (!urls.length) return;
  if (openAllInProgress) {
    // avoid stacking multiple runs
    openAllQueue = [];
  }
  const unique = Array.from(new Set(urls.filter(Boolean)));
  openAllQueue.push(...unique);
  openAllInProgress = true;
  await chrome.storage.local.set({ [STORAGE_OPEN_ALL]: true });
  if (!openAllTimer) {
    openAllTimer = setInterval(async () => {
      const next = openAllQueue.shift();
      if (!next) {
        clearInterval(openAllTimer);
        openAllTimer = null;
        openAllInProgress = false;
        await chrome.storage.local.set({ [STORAGE_OPEN_ALL]: false });
        return;
      }
      try {
        await chrome.tabs.create({ url: next, active: false });
      } catch {
        // ignore
      }
    }, 1500);
  }
}
