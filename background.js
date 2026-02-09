const STORAGE_LISTS = "lists";
const STORAGE_EXPECTED = "expectedKeywords";
const STORAGE_LAST_ORIGIN = "lastOrigin";
const STORAGE_STATUS = "statusText";
const STORAGE_STATUS_TONE = "statusTone";
const STORAGE_RUNNING = "running";
const STORAGE_START = "startTimeMs";
const STORAGE_END = "endTimeMs";

// Speed + coverage tuning
const PAGES_TO_SCAN = 5;            // scan first 5 pages per keyword
const TAB_TIMEOUT_MS = 15000;       // wait for page load
const POLL_MAX_ATTEMPTS = 5;        // collect attempts per page
const POLL_INTERVAL_MS = 1500;      // interval between attempts
const POLL_MIN_COUNT = 30;          // accept early if sellers >= this

let currentRunId = 0;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function autoCollectInTabs(expected, origin, runId) {
  const lists = await getLists();
  const queue = expected.slice();

  for (const keyword of queue) {
    if (runId !== currentRunId) break;

    const sellersSet = new Set();
    const url = `${origin}/search?keyword=${encodeURIComponent(keyword)}&page=0`;
    const tab = await chrome.tabs.create({ url, active: false });
    await waitForTabComplete(tab.id, TAB_TIMEOUT_MS);

    for (let page = 0; page < PAGES_TO_SCAN; page++) {
      if (runId !== currentRunId) break;

      await setStatus(`收集中：${keyword}，第 ${page + 1}/${PAGES_TO_SCAN} 頁`, "ok");
      if (page > 0) {
        const pageUrl = `${origin}/search?keyword=${encodeURIComponent(keyword)}&page=${page}`;
        await chrome.tabs.update(tab.id, { url: pageUrl });
        await waitForTabComplete(tab.id, TAB_TIMEOUT_MS);
      }

      const sellers = await pollCollect(tab.id, {
        maxAttempts: POLL_MAX_ATTEMPTS,
        intervalMs: POLL_INTERVAL_MS,
        minCount: POLL_MIN_COUNT
      });
      for (const s of sellers) sellersSet.add(s);
      await delay(250);
    }

    if (tab?.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        // ignore
      }
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
      await setStatus(`已完成：${keyword}`, "ok");
    } else {
      await setStatus(`收集失敗：${keyword}，未取得賣場`, "warn");
    }
  }
}

async function startCollect(expected, origin) {
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
  await setStatus("開始收集…", "ok");

  await autoCollectInTabs(expected, origin, runId);

  if (runId === currentRunId) {
    await chrome.storage.local.set({
      [STORAGE_RUNNING]: false,
      [STORAGE_END]: Date.now()
    });
    await setStatus("收集完成", "ok");
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
    const { expected, origin } = msg;
    startCollect(expected, origin)
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
  return false;
});
