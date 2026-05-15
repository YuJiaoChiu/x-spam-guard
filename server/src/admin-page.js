export function renderAdminPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Spam Guard 管理台</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #172033;
      --muted: #667085;
      --line: #d9e2ee;
      --panel: rgba(255,255,255,.92);
      --panel-strong: #fff;
      --brand: #0f766e;
      --brand-dark: #134e4a;
      --danger: #b91c1c;
      --shadow: 0 18px 45px rgba(15, 23, 42, .1);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      font-family: "Microsoft YaHei UI", "PingFang SC", "Noto Sans SC", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 12% 8%, rgba(20,184,166,.22), transparent 28%),
        radial-gradient(circle at 88% 4%, rgba(245,158,11,.18), transparent 30%),
        linear-gradient(135deg, #f7fbf8 0%, #eef6f3 48%, #f6f1e8 100%);
    }
    .shell { width: min(1480px, calc(100vw - 36px)); margin: 0 auto; padding: 26px 0 48px; }
    .hero { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(340px, 560px); gap: 18px; margin-bottom: 18px; }
    .hero-main, .panel, .table-card {
      background: var(--panel);
      border: 1px solid rgba(255,255,255,.75);
      box-shadow: var(--shadow);
      backdrop-filter: blur(14px);
      border-radius: 22px;
    }
    .hero-main { padding: 24px; position: relative; overflow: hidden; }
    .hero-main::after {
      content: "";
      position: absolute;
      right: -80px;
      top: -90px;
      width: 240px;
      height: 240px;
      border-radius: 999px;
      background: rgba(15,118,110,.13);
    }
    h1 { margin: 10px 0 0; font-size: 30px; letter-spacing: -.04em; }
    h2 { margin: 0; font-size: 18px; letter-spacing: -.02em; }
    .subtitle { margin-top: 10px; color: var(--muted); line-height: 1.65; max-width: 780px; }
    .pill { display: inline-flex; border-radius: 999px; padding: 4px 10px; font-size: 11px; font-weight: 800; background: #e8f3f1; color: var(--brand-dark); }
    .panel { padding: 18px; margin-bottom: 16px; }
    .token-box { padding: 18px; }
    .section-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .section-title p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
    .toolbar { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; align-items: end; }
    .grid { display: grid; grid-template-columns: repeat(2,minmax(260px,1fr)); gap: 12px; }
    .inline { display: flex; gap: 10px; flex-wrap: wrap; align-items: end; margin: 10px 0 12px; }
    .inline label { min-width: 180px; }
    label { color: #344054; font-size: 12px; font-weight: 800; display: flex; flex-direction: column; gap: 7px; }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 12px;
      color: var(--ink);
      background: #fff;
      outline: none;
      font: inherit;
      font-size: 13px;
      transition: border-color .15s ease, box-shadow .15s ease;
    }
    input, select { height: 38px; padding: 7px 11px; }
    textarea { min-height: 118px; padding: 10px 12px; resize: vertical; line-height: 1.55; }
    input:focus, select:focus, textarea:focus { border-color: rgba(15,118,110,.65); box-shadow: 0 0 0 4px rgba(20,184,166,.14); }
    button {
      height: 38px;
      border: 0;
      border-radius: 12px;
      padding: 0 14px;
      background: var(--brand);
      color: #fff;
      font-weight: 800;
      cursor: pointer;
      box-shadow: 0 10px 22px rgba(15,118,110,.18);
      white-space: nowrap;
    }
    button.secondary { background: #e8f3f1; color: var(--brand-dark); box-shadow: none; border: 1px solid #b7d8d3; }
    button:hover { filter: brightness(.96); }
    .actions { margin-top: 12px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .cards { display: grid; grid-template-columns: repeat(6,minmax(132px,1fr)); gap: 12px; margin: 18px 0; }
    .card { background: var(--panel-strong); border: 1px solid var(--line); border-radius: 18px; padding: 14px; }
    .card .k { font-size: 12px; color: var(--muted); }
    .card .v { font-size: 26px; margin-top: 8px; font-weight: 900; letter-spacing: -.04em; }
    .table-card { padding: 14px; margin-bottom: 18px; overflow: hidden; }
    .table-scroll { overflow: auto; max-height: 520px; border-radius: 16px; border: 1px solid var(--line); background: #fff; }
    table { width: 100%; border-collapse: separate; border-spacing: 0; min-width: 980px; }
    th, td { border-bottom: 1px solid #edf1f6; padding: 10px 12px; font-size: 12px; vertical-align: top; }
    th { position: sticky; top: 0; z-index: 1; background: #f5f8fb; text-align: left; color: #475467; font-weight: 900; }
    tr:hover td { background: #fbfdfc; }
    .muted { font-size: 12px; color: var(--muted); }
    .status-line { display: inline-flex; align-items: center; min-height: 28px; padding: 4px 10px; border-radius: 999px; background: #eef6f3; color: var(--brand-dark); font-size: 12px; font-weight: 800; }
    .status-line.error { background: #fef2f2; color: var(--danger); }
    .mono { font-family: "Cascadia Mono", "SFMono-Regular", Menlo, Consolas, monospace; font-size: 11px; white-space: pre-wrap; word-break: break-word; }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 980px) {
      .shell { width: min(100vw - 20px, 1480px); padding-top: 12px; }
      .hero, .two-col, .grid { grid-template-columns: 1fr; }
      .toolbar { grid-template-columns: 1fr; }
      .cards { grid-template-columns: repeat(2,minmax(120px,1fr)); }
      table { min-width: 820px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div class="hero-main">
        <span class="pill">X Spam Guard</span>
        <h1>垃圾评论拦截管理台</h1>
        <div class="subtitle">查看黑名单来源、命中字段、AI 判定、用户上报样本和自动拉黑队列。公网部署已启用管理令牌，先保存 Admin Token 后再加载数据。</div>
      </div>
      <div class="token-box panel">
        <div class="section-title">
          <div>
            <h2>访问令牌</h2>
            <p>如果看到 401，就是这里没填 Admin Token 或填错了。</p>
          </div>
        </div>
        <div class="toolbar">
          <label>Admin Token
            <input id="adminToken" type="password" placeholder="粘贴 ADMIN_TOKEN" />
          </label>
          <button id="saveToken">保存令牌</button>
          <button id="refreshAll" class="secondary">刷新数据</button>
        </div>
        <div class="actions">
          <span id="status" class="status-line">等待令牌</span>
        </div>
      </div>
    </section>

    <div class="panel">
      <div class="section-title">
        <div>
          <h2>AI 判定配置</h2>
          <p>用于二次识别强规则命中的候选账号。默认 mock，接入便宜 API 后再切换。</p>
        </div>
      </div>
      <div class="grid">
        <label>AI 提供方
          <select id="aiProvider">
            <option value="auto">自动：外部接口 -> OpenAI -> mock</option>
            <option value="external">只用外部分流接口</option>
            <option value="openai">只用 OpenAI 兼容接口</option>
            <option value="mock">只用本地 mock</option>
          </select>
        </label>
        <label>模型名
          <input id="cheapAiModel" placeholder="gpt-4o-mini" />
        </label>
        <label>外部分流接口地址
          <input id="cheapAiUrl" placeholder="http://host/classify" />
        </label>
        <label>OpenAI 兼容 Base URL
          <input id="openaiBaseUrl" placeholder="https://api.openai.com/v1" />
        </label>
        <label>OpenAI API Key（留空表示不修改）
          <input id="openaiApiKey" type="password" placeholder="sk-..." />
        </label>
        <label>当前密钥状态
          <input id="openaiKeyStatus" disabled />
        </label>
      </div>
      <div class="actions">
        <button id="saveAiConfig">保存 AI 配置</button>
        <button id="testAiConfig" class="secondary">测试判定</button>
        <span id="aiStatus" class="muted"></span>
      </div>
    </div>

    <div class="panel">
      <div class="section-title">
        <div>
          <h2>上报样本</h2>
          <p>粘贴垃圾评论块，系统会抽取有效短语作为候选 pattern，纯 emoji 和太短片段会被过滤。</p>
        </div>
      </div>
      <div class="grid">
        <label>样本类型
          <select id="reportLabel">
            <option value="spam">垃圾样本</option>
            <option value="ham">正常样本</option>
          </select>
        </label>
        <label>用户名（可选）
          <input id="reportScreenName" placeholder="@user" />
        </label>
        <label>昵称（可选）
          <input id="reportDisplayName" placeholder="昵称" />
        </label>
        <label>备注（可选）
          <input id="reportNote" placeholder="例如：夸克引流 / 黄推引流" />
        </label>
        <label style="grid-column: 1 / span 2;">原始评论/账号块
          <textarea id="reportRawText" placeholder="粘贴评论块，例如：司泽蔷♥免费破处♥ / @Brian135553 / 若玥🌸附近的DD🌸"></textarea>
        </label>
      </div>
      <div class="actions">
        <button id="submitReport">提交样本</button>
        <span id="reportStatus" class="muted"></span>
      </div>
    </div>

    <div class="cards" id="stats"></div>

    <div class="panel">
      <div class="section-title">
        <div>
          <h2>手动维护黑名单分层</h2>
          <p>confirmed 自动拉黑；suspected 只隐藏/待审核；reported 仅记录；whitelist 永不处理。</p>
        </div>
      </div>
      <div class="inline">
        <label>用户名 <input id="manualScreenName" placeholder="@user" /></label>
        <label>昵称 <input id="manualDisplayName" placeholder="可选" /></label>
        <label>分层
          <select id="manualStatus">
            <option value="confirmed">confirmed：自动拉黑</option>
            <option value="suspected">suspected：隐藏/待审核</option>
            <option value="reported">reported：仅上报未确认</option>
            <option value="whitelist">whitelist：永不处理</option>
          </select>
        </label>
        <label>原因 <input id="manualReason" placeholder="manual_upsert" /></label>
        <button id="manualUpsert">保存分层</button>
        <span id="manualStatusText" class="muted"></span>
      </div>
    </div>

    <section class="table-card">
      <div class="section-title">
        <div><h2>黑名单分层</h2><p>一眼看出账号在哪一层、为什么进名单、命中了哪个字段。</p></div>
      </div>
      <div class="inline">
        <label>分层
          <select id="blacklistStatus">
            <option value="all">全部</option>
            <option value="confirmed">confirmed</option>
            <option value="suspected">suspected</option>
            <option value="reported">reported</option>
            <option value="whitelist">whitelist</option>
          </select>
        </label>
        <label>搜索 <input id="blacklistQuery" placeholder="@user / 原因 / 标签" /></label>
      </div>
      <div class="table-scroll"><table id="blacklistTable"></table></div>
    </section>

    <section class="table-card">
      <div class="section-title">
        <div><h2>拉黑任务队列</h2><p>区分排队、执行中、成功、失败、风控冷却和跳过。</p></div>
      </div>
      <div class="inline">
        <label>状态
          <select id="taskStatus">
            <option value="all">全部</option>
            <option value="pending">pending</option>
            <option value="running">running</option>
            <option value="success">success</option>
            <option value="failed">failed</option>
            <option value="cooldown">cooldown</option>
            <option value="skipped">skipped</option>
          </select>
        </label>
        <label>搜索 <input id="taskQuery" placeholder="@user / 错误 / 原因" /></label>
      </div>
      <div class="table-scroll"><table id="taskTable"></table></div>
    </section>

    <section class="table-card">
      <div class="section-title">
        <div><h2>上报样本与规则建议</h2><p>把样本抽成候选短语，再由 AI 或本地聚合总结规则建议。</p></div>
        <div class="actions" style="margin:0">
          <button id="loadRuleSuggestions" class="secondary">总结规则建议</button>
          <span id="ruleSuggestionStatus" class="muted"></span>
        </div>
      </div>
      <div class="table-scroll" style="margin-bottom:12px"><table id="ruleSuggestionTable"></table></div>
      <div class="table-scroll"><table id="feedbackTable"></table></div>
    </section>

    <section class="table-card">
      <div class="section-title">
        <div><h2>待审核贡献</h2><p>用户共享命中的账号会先由 AI 自动复审，高置信直接进入 confirmed；不确定的留在这里人工处理。</p></div>
        <div class="actions" style="margin:0">
          <button id="autoReviewContrib" class="secondary">自动审核待审贡献</button>
          <span id="autoReviewStatus" class="muted"></span>
        </div>
      </div>
      <div class="table-scroll"><table id="contribTable"></table></div>
    </section>

    <section class="two-col">
      <div class="table-card">
        <div class="section-title"><div><h2>近期事件</h2><p>插件行为和服务端事件。</p></div></div>
        <div class="table-scroll"><table id="eventTable"></table></div>
      </div>
      <div class="table-card">
        <div class="section-title"><div><h2>判定记录</h2><p>规则分、AI 来源、最终动作和命中详情。</p></div></div>
        <div class="table-scroll"><table id="decisionTable"></table></div>
      </div>
    </section>
  </main>

  <script>
    const labels = {
      blacklistTotal: "黑名单总数",
      confirmed: "确认拉黑",
      suspected: "疑似隐藏",
      reported: "上报未确认",
      whitelist: "白名单",
      blockTaskPending: "待处理任务",
      contributionPending: "待审贡献",
      blocked24h: "24h 已拉黑",
      blockFailed24h: "24h 失败",
      decisions24h: "24h 判定",
      eventsTotal: "事件总数"
    };
    function token() {
      return localStorage.getItem("spam_guard_admin_token") || "";
    }
    function headers() {
      const t = token();
      return t ? { "x-admin-token": t } : {};
    }
    function apiPath(url) {
      const prefix = window.location.pathname.startsWith("/x-spam-guard") ? "/x-spam-guard" : "";
      return prefix + url;
    }
    async function jget(url) {
      const r = await fetch(apiPath(url), { headers: headers() });
      if (r.status === 401) throw new Error("需要先保存正确的 Admin Token");
      if (!r.ok) throw new Error(url + " 返回 " + r.status);
      return await r.json();
    }
    async function jpost(url, payload) {
      const r = await fetch(apiPath(url), {
        method: "POST",
        headers: { "content-type": "application/json", ...headers() },
        body: JSON.stringify(payload || {})
      });
      if (r.status === 401) throw new Error("需要先保存正确的 Admin Token");
      if (!r.ok) throw new Error(url + " 返回 " + r.status);
      return await r.json();
    }
    function setStatus(text, isError) {
      const el = document.getElementById("status");
      el.textContent = text || "";
      el.className = "status-line" + (isError ? " error" : "");
    }
    function setText(id, text) {
      document.getElementById(id).textContent = text || "";
    }
    function escapeHtml(text) {
      return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }
    function formatReasonDetails(details) {
      if (!details || typeof details !== "object") return "";
      const ruleReasons = Array.isArray(details.ruleHumanReasons) ? details.ruleHumanReasons : [];
      const ruleMatches = Array.isArray(details.ruleMatchDetails) ? details.ruleMatchDetails : [];
      const lines = [];
      if (details.blacklistLayer) lines.push("分层：" + details.blacklistLayer);
      if (ruleReasons.length) lines.push("规则：" + ruleReasons.join(" | "));
      if (ruleMatches.length) {
        const hitLines = [];
        ruleMatches.forEach(function(item) {
          const hits = Array.isArray(item.hits) ? item.hits : [];
          if (hits.length) {
            hits.forEach(function(hit) {
              const field = hit.field || "unknown";
              const term = hit.term || "";
              const value = hit.value || "";
              hitLines.push(field + " 命中：" + term + (value ? (" in " + value) : ""));
            });
          } else {
            const fs = Array.isArray(item.fields) ? item.fields.join(",") : "";
            const evidence = Array.isArray(item.evidence) ? item.evidence.join(", ") : "";
            hitLines.push(item.rule + (fs ? ("@" + fs) : "") + (evidence ? (" => " + evidence) : ""));
          }
        });
        lines.push("字段命中：" + hitLines.join(" ; "));
      }
      if (details.aiReason) lines.push("AI：" + details.aiReason);
      return escapeHtml(lines.join("\\n"));
    }
    function renderStats(stats) {
      const entries = [
        ["blacklistTotal", stats.blacklistTotal],
        ["confirmed", stats.blacklistConfirmed],
        ["suspected", stats.blacklistSuspected],
        ["reported", stats.blacklistReported],
        ["whitelist", stats.blacklistWhitelist],
        ["blockTaskPending", stats.blockTaskPending],
        ["contributionPending", stats.contributionPending],
        ["blocked24h", stats.blocked24h],
        ["blockFailed24h", stats.blockFailed24h],
        ["decisions24h", stats.decisions24h],
        ["eventsTotal", stats.eventsTotal]
      ];
      document.getElementById("stats").innerHTML = entries.map(function(pair) {
        return '<div class="card"><div class="k">' + labels[pair[0]] + '</div><div class="v">' + (pair[1] ?? 0) + '</div></div>';
      }).join("");
    }
    function emptyRow(cols, text) {
      return '<tr><td colspan="' + cols + '" class="muted">' + escapeHtml(text || "暂无数据") + '</td></tr>';
    }
    function renderContrib(items) {
      const rows = items.map(function(row) {
        const c = row.payload?.candidate || {};
        const v = row.payload?.verdict || {};
        return '<tr>' +
          '<td>' + escapeHtml(row.createdAt || "") + '</td>' +
          '<td>@' + escapeHtml(c.screenName || "") + '<br>' + escapeHtml(c.displayName || "") + '</td>' +
          '<td>' + escapeHtml(c.commentText || "") + '</td>' +
          '<td>' + escapeHtml(v.reason || "") + '<br>' + escapeHtml(String(Number(v.confidence || 0).toFixed(2))) + '</td>' +
          '<td class="mono">' + formatReasonDetails(v.details || {}) + '</td>' +
          '<td><button onclick="review(\\'' + row.id + '\\',\\'approve\\')">通过</button> <button class="secondary" onclick="review(\\'' + row.id + '\\',\\'reject\\')">拒绝</button></td>' +
        '</tr>';
      }).join("");
      document.getElementById("contribTable").innerHTML =
        '<tr><th>创建时间</th><th>账号</th><th>评论</th><th>原因/置信度</th><th>命中解释</th><th>操作</th></tr>' + (rows || emptyRow(6));
    }
    function renderBlacklist(items) {
      const rows = items.map(function(row) {
        const details = formatReasonDetails(row.reasonDetails || {});
        const tags = Array.isArray(row.tags) ? row.tags.join(", ") : "";
        return '<tr>' +
          '<td>' + escapeHtml(row.updatedAt || "") + '</td>' +
          '<td><span class="pill">' + escapeHtml(row.status || "") + '</span></td>' +
          '<td>@' + escapeHtml(row.screenName || "") + '<br>' + escapeHtml(row.displayName || "") + '</td>' +
          '<td>' + escapeHtml(row.reason || "") + '<br>' + escapeHtml(String(Number(row.confidence || 0).toFixed(2))) + '</td>' +
          '<td>' + escapeHtml(tags) + '</td>' +
          '<td class="mono">' + details + '</td>' +
        '</tr>';
      }).join("");
      document.getElementById("blacklistTable").innerHTML =
        '<tr><th>更新时间</th><th>分层</th><th>账号</th><th>原因/置信度</th><th>标签</th><th>字段命中</th></tr>' + (rows || emptyRow(6));
    }
    function renderTasks(items) {
      const rows = items.map(function(row) {
        return '<tr>' +
          '<td>' + escapeHtml(row.updatedAt || "") + '</td>' +
          '<td><span class="pill">' + escapeHtml(row.status || "") + '</span></td>' +
          '<td>@' + escapeHtml(row.screenName || "") + '<br>' + escapeHtml(row.displayName || "") + '</td>' +
          '<td>计划：' + escapeHtml(row.scheduledAt || "") + '<br>开始：' + escapeHtml(row.startedAt || "") + '<br>结束：' + escapeHtml(row.finishedAt || "") + '</td>' +
          '<td>' + escapeHtml(String(row.retries || 0)) + ' / ' + escapeHtml(String(row.maxRetries || 0)) + '</td>' +
          '<td>' + escapeHtml(String(row.xStatusCode || "")) + '</td>' +
          '<td class="mono">' + escapeHtml((row.reason || "") + (row.lastError ? "\\n" + row.lastError : "")) + '</td>' +
        '</tr>';
      }).join("");
      document.getElementById("taskTable").innerHTML =
        '<tr><th>更新时间</th><th>状态</th><th>账号</th><th>执行时间</th><th>重试</th><th>X 返回码</th><th>原因/错误</th></tr>' + (rows || emptyRow(7));
    }
    function renderFeedback(items) {
      const rows = items.map(function(row) {
        const patterns = Array.isArray(row.patternCandidates) && row.patternCandidates.length
          ? row.patternCandidates.slice(0, 16).map(function(item) {
              if (typeof item === "string") return item;
              return (item.value || "") + " [" + (item.kind || "phrase") + ":" + (item.score || 0) + "]";
            }).join(" | ")
          : (Array.isArray(row.fragments) ? row.fragments.slice(0, 12).join(" | ") : "");
        return '<tr>' +
          '<td>' + escapeHtml(row.createdAt || "") + '</td>' +
          '<td>' + escapeHtml(row.label || "") + '</td>' +
          '<td>@' + escapeHtml(row.screenName || "") + '<br>' + escapeHtml(row.displayName || "") + '</td>' +
          '<td class="mono">' + escapeHtml(row.rawText || "") + '</td>' +
          '<td class="mono">' + escapeHtml(patterns) + '</td>' +
        '</tr>';
      }).join("");
      document.getElementById("feedbackTable").innerHTML =
        '<tr><th>创建时间</th><th>类型</th><th>账号</th><th>原文</th><th>候选 pattern</th></tr>' + (rows || emptyRow(5));
    }
    function renderRuleSuggestions(provider, items) {
      const rows = items.map(function(item) {
        return '<tr>' +
          '<td>' + escapeHtml(provider || "") + '</td>' +
          '<td>' + escapeHtml(item.action || "") + '</td>' +
          '<td>' + escapeHtml(item.kind || "") + '</td>' +
          '<td class="mono">' + escapeHtml(item.pattern || "") + '</td>' +
          '<td>' + escapeHtml(String(item.confidence || "")) + '</td>' +
          '<td class="mono">' + escapeHtml(item.reason || "") + '</td>' +
        '</tr>';
      }).join("");
      document.getElementById("ruleSuggestionTable").innerHTML =
        '<tr><th>来源</th><th>建议动作</th><th>类型</th><th>模式</th><th>置信度</th><th>原因</th></tr>' + (rows || emptyRow(6, "点击“总结规则建议”后显示"));
    }
    function renderEvents(items) {
      const rows = items.map(function(row) {
        return '<tr><td>' + escapeHtml(row.at || "") + '</td><td>' + escapeHtml(row.type || "") + '</td><td>@' + escapeHtml(row.screenName || "") + '</td><td>' + escapeHtml(row.reason || "") + '</td><td>' + escapeHtml(String(row.status || "")) + '</td></tr>';
      }).join("");
      document.getElementById("eventTable").innerHTML =
        '<tr><th>时间</th><th>类型</th><th>账号</th><th>原因</th><th>状态</th></tr>' + (rows || emptyRow(5));
    }
    function renderDecisions(items) {
      const rows = items.map(function(row) {
        const f = row.final || {};
        const c = Number(f.confidence || 0).toFixed(2);
        return '<tr><td>' + escapeHtml(row.at || "") + '</td><td>@' + escapeHtml(row.screenName || "") + '</td><td>' + escapeHtml(String(row.ruleScore || 0)) + '</td><td>' + escapeHtml(row.aiProvider || "") + '</td><td>' + (f.shouldBlock ? '拉黑' : '跳过') + ' / ' + c + '</td><td class="mono">' + formatReasonDetails(f.details || {}) + '</td></tr>';
      }).join("");
      document.getElementById("decisionTable").innerHTML =
        '<tr><th>时间</th><th>账号</th><th>规则分</th><th>AI</th><th>最终</th><th>解释</th></tr>' + (rows || emptyRow(6));
    }
    function fillRuntimeConfig(runtime) {
      document.getElementById('aiProvider').value = runtime.aiProvider || 'auto';
      document.getElementById('cheapAiUrl').value = runtime.cheapAiUrl || '';
      document.getElementById('openaiBaseUrl').value = runtime.openaiBaseUrl || 'https://api.openai.com/v1';
      document.getElementById('cheapAiModel').value = runtime.cheapAiModel || 'gpt-4o-mini';
      document.getElementById('openaiApiKey').value = '';
      document.getElementById('openaiKeyStatus').value = runtime.hasOpenaiApiKey ? '已保存' : '未配置';
    }
    async function loadRuntimeConfig() {
      const resp = await jget('/api/admin/runtime-config');
      fillRuntimeConfig(resp.runtime || {});
    }
    async function saveRuntimeConfig() {
      const keyInput = document.getElementById('openaiApiKey').value.trim();
      await jpost('/api/admin/runtime-config', {
        aiProvider: document.getElementById('aiProvider').value,
        cheapAiUrl: document.getElementById('cheapAiUrl').value.trim(),
        openaiBaseUrl: document.getElementById('openaiBaseUrl').value.trim(),
        cheapAiModel: document.getElementById('cheapAiModel').value.trim(),
        openaiApiKey: keyInput ? keyInput : "__KEEP__"
      });
      await loadRuntimeConfig();
      setText('aiStatus', 'AI 配置已保存');
    }
    async function testRuntimeConfig() {
      setText('aiStatus', '测试中...');
      const resp = await jpost('/api/admin/runtime-config/test', {});
      const result = resp.result || {};
      const provider = result.aiResult?.provider || 'unknown';
      const final = result.final || {};
      setText('aiStatus', '来源=' + provider + '，是否拉黑=' + Boolean(final.shouldBlock) + '，置信度=' + Number(final.confidence || 0).toFixed(2));
    }
    async function submitReportSample() {
      const payload = {
        label: document.getElementById('reportLabel').value,
        screenName: document.getElementById('reportScreenName').value.trim(),
        displayName: document.getElementById('reportDisplayName').value.trim(),
        note: document.getElementById('reportNote').value.trim(),
        rawText: document.getElementById('reportRawText').value
      };
      if (!payload.rawText) {
        setText('reportStatus', '请先粘贴样本文本');
        return;
      }
      await jpost('/api/admin/feedback-samples', payload);
      setText('reportStatus', '样本已提交');
      document.getElementById('reportRawText').value = '';
      await loadAll();
    }
    async function manualUpsertLayer() {
      const payload = {
        screenName: document.getElementById('manualScreenName').value.trim(),
        displayName: document.getElementById('manualDisplayName').value.trim(),
        status: document.getElementById('manualStatus').value,
        reason: document.getElementById('manualReason').value.trim() || 'manual_upsert',
        confidence: document.getElementById('manualStatus').value === 'whitelist' ? 1 : 0.9,
        source: 'manual'
      };
      if (!payload.screenName) {
        setText('manualStatusText', '请填写用户名');
        return;
      }
      await jpost('/api/blacklist/upsert', payload);
      setText('manualStatusText', '分层已保存');
      document.getElementById('manualScreenName').value = '';
      document.getElementById('manualDisplayName').value = '';
      await loadAll();
    }
    async function loadRuleSuggestions() {
      setText('ruleSuggestionStatus', '总结中...');
      const resp = await jget('/api/admin/rule-suggestions?limit=300');
      renderRuleSuggestions(resp.provider || '', resp.suggestions || []);
      setText('ruleSuggestionStatus', '已生成 ' + ((resp.suggestions || []).length) + ' 条建议');
    }
    async function review(id, decision) {
      await jpost('/api/contributions/' + id + '/review', { decision });
      await loadAll();
    }
    window.review = review;
    async function autoReviewContributions() {
      const button = document.getElementById('autoReviewContrib');
      button.disabled = true;
      setText('autoReviewStatus', '自动审核中...');
      try {
        const resp = await jpost('/api/admin/contributions/auto-review', { limit: 100 });
        const s = resp.summary || {};
        setText('autoReviewStatus', '扫描 ' + (s.scanned || 0) + '，自动通过 ' + (s.approved || 0) + '，保留待审 ' + (s.pending || 0) + '，失败 ' + (s.failed || 0));
        await loadAll();
      } catch (error) {
        setText('autoReviewStatus', '自动审核失败：' + error.message);
      } finally {
        button.disabled = false;
      }
    }
    async function loadAll() {
      try {
        const blacklistStatus = document.getElementById('blacklistStatus')?.value || 'all';
        const blacklistQuery = document.getElementById('blacklistQuery')?.value.trim() || '';
        const taskStatus = document.getElementById('taskStatus')?.value || 'all';
        const taskQuery = document.getElementById('taskQuery')?.value.trim() || '';
        const responses = await Promise.all([
          jget('/api/admin/stats'),
          jget('/api/admin/blacklist?status=' + encodeURIComponent(blacklistStatus) + '&query=' + encodeURIComponent(blacklistQuery) + '&limit=120'),
          jget('/api/admin/block-tasks?status=' + encodeURIComponent(taskStatus) + '&query=' + encodeURIComponent(taskQuery) + '&limit=120'),
          jget('/api/admin/feedback-samples?label=all&limit=60'),
          jget('/api/admin/contributions?decision=pending&limit=50'),
          jget('/api/admin/events?limit=80'),
          jget('/api/admin/decisions?limit=80')
        ]);
        renderStats(responses[0].stats || {});
        renderBlacklist(responses[1].items || []);
        renderTasks(responses[2].items || []);
        renderFeedback(responses[3].items || []);
        renderContrib(responses[4].items || []);
        renderEvents(responses[5].items || []);
        renderDecisions(responses[6].items || []);
        setStatus('已刷新：' + new Date().toLocaleTimeString(), false);
      } catch (e) {
        setStatus('加载失败：' + e.message, true);
      }
    }
    const tokenInput = document.getElementById('adminToken');
    tokenInput.value = token();
    document.getElementById('saveToken').onclick = function () {
      localStorage.setItem('spam_guard_admin_token', tokenInput.value.trim());
      setStatus('令牌已保存，正在加载...', false);
      loadAll();
      loadRuntimeConfig();
    };
    document.getElementById('refreshAll').onclick = loadAll;
    document.getElementById('saveAiConfig').onclick = saveRuntimeConfig;
    document.getElementById('testAiConfig').onclick = testRuntimeConfig;
    document.getElementById('submitReport').onclick = submitReportSample;
    document.getElementById('manualUpsert').onclick = manualUpsertLayer;
    document.getElementById('loadRuleSuggestions').onclick = loadRuleSuggestions;
    document.getElementById('autoReviewContrib').onclick = autoReviewContributions;
    document.getElementById('blacklistStatus').onchange = loadAll;
    document.getElementById('taskStatus').onchange = loadAll;
    document.getElementById('blacklistQuery').oninput = function () { clearTimeout(window.__blacklistQueryTimer); window.__blacklistQueryTimer = setTimeout(loadAll, 300); };
    document.getElementById('taskQuery').oninput = function () { clearTimeout(window.__taskQueryTimer); window.__taskQueryTimer = setTimeout(loadAll, 300); };
    renderRuleSuggestions('', []);
    if (token()) {
      loadAll();
      loadRuntimeConfig();
    } else {
      setStatus('请先填写并保存 Admin Token', true);
      renderStats({});
      renderBlacklist([]);
      renderTasks([]);
      renderFeedback([]);
      renderContrib([]);
      renderEvents([]);
      renderDecisions([]);
    }
    setInterval(function () {
      if (token()) loadAll();
    }, 10000);
  </script>
</body>
</html>`;
}
