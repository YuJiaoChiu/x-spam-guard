const config = window.SPAM_GUARD_CONFIG || {};
const dataUrl = config.dataUrl || "data/public-export.json";
const reportEndpoint = config.reportEndpoint || "";

let currentBlacklist = [];

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTime(value) {
  if (!value) return "等待更新";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function metric(label, value) {
  return `<article class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? 0)}</strong></article>`;
}

function renderMetrics(data) {
  const totals = data.analysis?.totals || {};
  const stats = data.stats || {};
  $("metricCards").innerHTML = [
    metric("确认黑名单", totals.confirmedBlacklist || stats.blacklistConfirmed || 0),
    metric("Spam 样本", totals.spamSamples || 0),
    metric("已审核上报", totals.approvedReports || 0),
    metric("待审核上报", totals.pendingReports || stats.contributionPending || 0)
  ].join("");
}

function renderBars(data) {
  const rules = data.analysis?.topRules || [];
  const max = Math.max(1, ...rules.map((item) => Number(item.count || 0)));
  $("ruleBars").innerHTML = rules.length
    ? rules.slice(0, 12).map((item) => {
        const pct = Math.max(4, Math.round((Number(item.count || 0) / max) * 100));
        return `
          <div class="bar-row">
            <strong>${escapeHtml(item.value)}</strong>
            <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
            <span>${escapeHtml(item.count)}</span>
          </div>
        `;
      }).join("")
    : '<p class="muted">暂无规则统计，等待下一次数据更新。</p>';
}

function renderPatterns(data) {
  const patterns = data.analysis?.topPatterns || [];
  $("patternCloud").innerHTML = patterns.length
    ? patterns.slice(0, 36).map((item) => `<span>${escapeHtml(item.value)} · ${escapeHtml(item.count)}</span>`).join("")
    : '<p class="muted">暂无样本模式，等待用户上报和管理员审核。</p>';
}

function reasonText(item) {
  const details = item.reasonDetails || {};
  const reasons = Array.isArray(details.ruleHumanReasons) ? details.ruleHumanReasons : [];
  if (reasons.length) return reasons.slice(0, 3).join(" | ");
  return item.reason || "spam";
}

function fieldText(item) {
  const matches = item.reasonDetails?.ruleMatchDetails || [];
  const fields = [];
  for (const match of matches) {
    const rule = match.rule || "";
    for (const hit of match.hits || []) {
      fields.push(`${hit.field || "field"}:${hit.term || rule}`);
    }
  }
  return fields.slice(0, 6).join("；") || "规则/AI 命中";
}

function renderBlacklist(items) {
  const query = $("blacklistSearch").value.trim().toLowerCase();
  const filtered = items.filter((item) => {
    if (!query) return true;
    const haystack = `${item.screenName} ${item.displayName} ${item.reason} ${(item.tags || []).join(" ")} ${reasonText(item)}`.toLowerCase();
    return haystack.includes(query);
  });

  $("blacklistRows").innerHTML = filtered.length
    ? filtered.map((item) => `
      <tr>
        <td>
          <div class="handle">@${escapeHtml(item.screenName)}</div>
          <div class="muted">${escapeHtml(item.displayName || "")}</div>
          <div class="tags">${escapeHtml((item.tags || []).slice(0, 5).join(", "))}</div>
        </td>
        <td>${escapeHtml(reasonText(item))}</td>
        <td>${escapeHtml(Number(item.confidence || 0).toFixed(2))}</td>
        <td>${escapeHtml(fieldText(item))}</td>
        <td>${escapeHtml(formatTime(item.updatedAt))}</td>
      </tr>
    `).join("")
    : '<tr><td colspan="5" class="muted">没有匹配结果。</td></tr>';
}

function updateReportEndpointStatus() {
  const status = $("reportStatus");
  if (!reportEndpoint) {
    status.textContent = "未配置提交接口";
    return;
  }
  if (location.protocol === "https:" && reportEndpoint.startsWith("http://")) {
    status.textContent = "当前后端是 HTTP，GitHub Pages 上提交会被浏览器拦截；请配置 HTTPS 域名";
    return;
  }
  status.textContent = "提交后进入管理员待审";
}

async function loadData() {
  const response = await fetch(`${dataUrl}?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`data_${response.status}`);
  const data = await response.json();
  currentBlacklist = Array.isArray(data.blacklist) ? data.blacklist : [];
  $("generatedAt").textContent = formatTime(data.generatedAt);
  $("sourceStatus").textContent = `已加载 ${currentBlacklist.length} 条公开黑名单`;
  renderMetrics(data);
  renderBars(data);
  renderPatterns(data);
  renderBlacklist(currentBlacklist);
}

async function submitReport(event) {
  event.preventDefault();
  const status = $("reportStatus");
  if (!reportEndpoint) {
    status.textContent = "未配置提交接口";
    return;
  }
  if (location.protocol === "https:" && reportEndpoint.startsWith("http://")) {
    status.textContent = "提交失败：GitHub Pages 是 HTTPS，不能请求 HTTP 后端。请先给后端配置 HTTPS。";
    return;
  }

  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  status.textContent = "提交中...";
  try {
    const response = await fetch(reportEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `submit_${response.status}`);
    status.textContent = `已提交待审：${result.id || ""}`;
    form.reset();
  } catch (error) {
    status.textContent = `提交失败：${error.message}`;
  }
}

$("blacklistSearch").addEventListener("input", () => renderBlacklist(currentBlacklist));
$("reportForm").addEventListener("submit", submitReport);
updateReportEndpointStatus();
loadData().catch((error) => {
  $("generatedAt").textContent = "加载失败";
  $("sourceStatus").textContent = error.message;
  renderBlacklist([]);
});
