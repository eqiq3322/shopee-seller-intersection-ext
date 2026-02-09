function uniq(arr) {
  return Array.from(new Set(arr));
}

function extractShopIdFromHref(href) {
  if (!href) return null;
  // Common product URL format: /...-i.{shopid}.{itemid}
  let m = href.match(/-i\.(\d+)\.(\d+)/);
  if (m) return m[1];
  // Alternative format: /i.{shopid}.{itemid}
  m = href.match(/\/i\.(\d+)\.(\d+)/);
  if (m) return m[1];
  // Similar products links often contain shopid query param
  m = href.match(/[?&]shopid=(\d+)/);
  if (m) return m[1];
  return null;
}

function extractSellersFromDom() {
  const sellers = [];

  // 1) Collect shop IDs from product links
  document.querySelectorAll("a[href]").forEach(a => {
    const href = a.getAttribute("href") || "";
    const shopId = extractShopIdFromHref(href);
    if (shopId) sellers.push("SHOP_ID:" + shopId);
  });

  // 2) Collect explicit shop/store links if present
  const storeLinkSelectors = [
    'a[href*="/shop/"]',
    'a[href*="/shop/"] span',
    'a[href*="/shop/"] div',
    'a[href*="/store/"]',
    'a[href*="/store/"] span',
    'a[href*="/store/"] div'
  ];

  for (const sel of storeLinkSelectors) {
    document.querySelectorAll(sel).forEach(el => {
      const text = (el.textContent || "").trim();
      if (text && text.length <= 40) sellers.push(text);
      const a = el.closest("a");
      const href = a?.getAttribute("href");
      if (href && href.includes("/shop/")) sellers.push(`SHOP_LINK:${href.split("?")[0]}`);
      if (href && href.includes("/store/")) sellers.push(`STORE_LINK:${href.split("?")[0]}`);
    });
  }

  return uniq(sellers).slice(0, 500);
}


async function scrollAndCollect(options) {
  const maxScrolls = Number.isFinite(options?.maxScrolls) ? options.maxScrolls : 6;
  const delayMs = Number.isFinite(options?.delayMs) ? options.delayMs : 600;
  const sellersSet = new Set();

  for (let i = 0; i < maxScrolls; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(r => setTimeout(r, delayMs));
    const sellers = extractSellersFromDom();
    for (const s of sellers) sellersSet.add(s);
  }

  return Array.from(sellersSet);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "COLLECT_SELLERS") {
    try {
      const sellers = extractSellersFromDom();
      sendResponse({
        ok: true,
        sellers,
        meta: {
          url: location.href,
          title: document.title,
          sellerCount: sellers.length
        }
      });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  }
  if (msg?.type === "SCROLL_AND_COLLECT") {
    const { maxScrolls, delayMs } = msg || {};
    scrollAndCollect({ maxScrolls, delayMs })
      .then(sellers => {
        sendResponse({
          ok: true,
          sellers,
          meta: {
            url: location.href,
            title: document.title,
            sellerCount: sellers.length
          }
        });
      })
      .catch(e => {
        sendResponse({ ok: false, error: String(e) });
      });
    return true;
  }
  return true;
});