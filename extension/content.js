(function initContent() {
  const PROCESSED_KEY = "spamGuardSeen";
  const pendingBridgeRequests = new Map();
  const blockedHandles = new Set();
  const scanStats = {
    scanned: 0,
    extracted: 0,
    localRuleHits: 0,
    lowScoreSkipped: 0,
    lastRuleScore: 0
  };
  let scanStatsTimer = null;

  function flushScanStatsSoon() {
    if (scanStatsTimer) return;
    scanStatsTimer = setTimeout(() => {
      scanStatsTimer = null;
      const payload = { ...scanStats };
      scanStats.scanned = 0;
      scanStats.extracted = 0;
      scanStats.localRuleHits = 0;
      scanStats.lowScoreSkipped = 0;
      chrome.runtime.sendMessage({ type: "SCAN_STATS", ...payload }).catch(() => {});
    }, 800);
  }

  function ensureStyles() {
    if (document.getElementById("spam-guard-style")) return;
    const style = document.createElement("style");
    style.id = "spam-guard-style";
    style.textContent = `
      article[data-spam-guard-hidden="1"] {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureBridgeInjected() {
    if (document.getElementById("spam-guard-bridge-script")) return;
    const script = document.createElement("script");
    script.id = "spam-guard-bridge-script";
    script.src = chrome.runtime.getURL("page-bridge.js");
    script.async = false;
    document.documentElement.appendChild(script);
  }

  function parseHandleFromHref(href) {
    if (!href) return "";
    try {
      const url = new URL(href, location.origin);
      const path = url.pathname || "";
      if (!/^\/[A-Za-z0-9_]{1,15}$/.test(path)) return "";
      return path.slice(1).toLowerCase();
    } catch {
      return "";
    }
  }

  function extractCandidate(article) {
    const userNameNode = article.querySelector('div[data-testid="User-Name"]');
    if (!userNameNode) return null;

    const links = Array.from(userNameNode.querySelectorAll('a[href^="/"]'));
    const handleLink = links.find((link) => parseHandleFromHref(link.getAttribute("href")));
    if (!handleLink) return null;

    const screenName = parseHandleFromHref(handleLink.getAttribute("href"));
    if (!screenName) return null;

    const displayName = (userNameNode.querySelector("span")?.innerText || "").trim();
    const commentText = (article.querySelector('div[data-testid="tweetText"]')?.innerText || "").trim();
    if (!commentText && !displayName) return null;

    const candidate = {
      userId: null,
      screenName,
      displayName,
      profileBio: "",
      commentText,
      sourceUrl: location.href
    };

    const rule = SpamRules.scoreCandidate(candidate);
    return { candidate, rule };
  }

  function hideByHandle(screenName) {
    const key = String(screenName || "").toLowerCase();
    if (!key) return;
    blockedHandles.add(key);

    const articles = document.querySelectorAll("article");
    for (const article of articles) {
      const info = extractCandidate(article);
      if (!info) continue;
      if (info.candidate.screenName.toLowerCase() === key) {
        article.setAttribute("data-spam-guard-hidden", "1");
      }
    }
  }

  async function bridgeBlock(screenName, taskId) {
    const requestId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const payload = {
      source: "spam-guard-extension",
      type: "SPAM_GUARD_BLOCK",
      requestId,
      taskId: taskId || "",
      screenName
    };

    const resultPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingBridgeRequests.delete(requestId);
        resolve({ ok: false, error: "bridge_timeout" });
      }, 20000);
      pendingBridgeRequests.set(requestId, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });

    window.postMessage(payload, "*");
    return await resultPromise;
  }

  async function blockAndReport(message) {
    const screenName = String(message.screenName || "").toLowerCase();
    if (!screenName) return;

    const result = await bridgeBlock(screenName, message.taskId || "");
    if (result.ok) {
      hideByHandle(screenName);
    }

    chrome.runtime.sendMessage({
      type: "BLOCK_RESULT",
      taskId: message.taskId || result.taskId || "",
      screenName,
      reason: message.reason || "",
      confidence: Number(message.confidence || 0),
      ok: Boolean(result.ok),
      status: result.status || 0,
      error: result.error || ""
    });
  }

  function processArticle(article) {
    if (!(article instanceof HTMLElement)) return;
    if (article.dataset[PROCESSED_KEY] === "1") return;
    article.dataset[PROCESSED_KEY] = "1";
    scanStats.scanned += 1;

    const info = extractCandidate(article);
    if (!info) {
      flushScanStatsSoon();
      return;
    }
    scanStats.extracted += 1;
    scanStats.lastRuleScore = Number(info.rule.score || 0);

    const handle = info.candidate.screenName;
    if (blockedHandles.has(handle)) {
      article.setAttribute("data-spam-guard-hidden", "1");
      flushScanStatsSoon();
      return;
    }

    if (info.rule.score >= 2) {
      scanStats.localRuleHits += 1;
      chrome.runtime.sendMessage({
        type: "CANDIDATE_DETECTED",
        candidate: {
          ...info.candidate,
          ruleScore: info.rule.score,
          matchedRules: info.rule.matchedRules
        }
      }).catch(() => {});
    } else {
      scanStats.lowScoreSkipped += 1;
    }
    flushScanStatsSoon();
  }

  function scanExistingArticles() {
    const articles = document.querySelectorAll("article");
    for (const article of articles) {
      processArticle(article);
    }
  }

  function observeDom() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.tagName === "ARTICLE") {
            processArticle(node);
            continue;
          }
          const nested = node.querySelectorAll ? node.querySelectorAll("article") : [];
          for (const article of nested) {
            processArticle(article);
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.source !== "spam-guard-page") return;
    if (data.type !== "SPAM_GUARD_BLOCK_RESULT") return;
    const resolver = pendingBridgeRequests.get(data.requestId);
    if (!resolver) return;
    pendingBridgeRequests.delete(data.requestId);
    resolver(data);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) return;
    if (message.type === "HIDE_USER") {
      hideByHandle(message.screenName);
      return;
    }
    if (message.type === "BLACKLIST_SYNCED") {
      for (const handle of [...(message.handles || []), ...(message.suspected || [])]) {
        hideByHandle(handle);
      }
      return;
    }
    if (message.type === "BLOCK_USER") {
      blockAndReport(message);
    }
  });

  ensureStyles();
  ensureBridgeInjected();
  scanExistingArticles();
  observeDom();
})();
