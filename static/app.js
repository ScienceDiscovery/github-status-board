"use strict";
const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const safeUrl = (v) => (/^https:\/\//.test(v || "") ? v : "#");
const link = (url, text) =>
  `<a href="${esc(safeUrl(url))}" target="_blank" rel="noopener">${esc(text)} ↗</a>`;
const number = (v) => (v == null ? "—" : Number(v).toLocaleString("zh-CN"));
const date = (v) =>
  v && !isNaN(new Date(v))
    ? new Date(v).toLocaleString("zh-CN", { hour12: false })
    : "—";
const labels = {
  success: ["通过", "good"],
  failure: ["失败", "bad"],
  timed_out: ["超时", "bad"],
  cancelled: ["已取消", "warn"],
  skipped: ["跳过", "muted"],
  neutral: ["中性", "muted"],
  action_required: ["待处理", "warn"],
  stale: ["已过期", "warn"],
  in_progress: ["运行中", "info"],
  queued: ["排队中", "info"],
  waiting: ["等待", "info"],
  pending: ["等待", "info"],
  completed: ["已完成", "muted"],
  unknown: ["未知", "muted"],
  passed: ["通过", "good"],
  failed: ["失败", "bad"],
  flaky: ["重试后通过", "warn"],
  available: ["已取得报告", "good"],
  missing: ["未上传报告", "warn"],
  unavailable: ["无法读取", "warn"],
  expired: ["产物已过期", "warn"],
  no_counts: ["报告不可解析", "warn"],
  not_inspected: ["未采集报告", "muted"],
  partial: ["报告不完整", "warn"],
};
const badge = (state, text) => {
  const [name, tone] = labels[String(state).toLowerCase()] || [
    text || state || "未知",
    "muted",
  ];
  return `<span class="badge ${tone}">${esc(text || name)}</span>`;
};
const channelNames = {
  gate: "合并门禁",
  daily: "每日构建",
  release: "版本验证",
};
let data,
  search = "",
  workKind = "all",
  lane = "all";
function state(run) {
  return run?.status === "completed"
    ? run.conclusion || "unknown"
    : run?.status || "unknown";
}
function metric(label, value, hint) {
  return `<div class="metric"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="hint">${esc(hint)}</div></div>`;
}
function heading(title, note = "") {
  return `<div class="section-head"><h2>${esc(title)}</h2><p>${esc(note)}</p></div>`;
}
function countSummary(report) {
  const c = report?.counts;
  return c ? `${number(c.passed)} / ${number(c.tests)} 通过` : "暂无用例结果";
}
function breakdown(c) {
  if (!c) return "";
  const total = c.tests || 1;
  return `<div class="bar">${["passed", "failed", "skipped", "flaky"].map((k) => `<i class="${k}" style="width:${Math.max(0, Math.min(100, (c[k] / total) * 100))}%"></i>`).join("")}</div><div class="legend">${[
    ["passed", "通过", "#399d80"],
    ["failed", "失败", "#d26a62"],
    ["skipped", "跳过", "#c0c8ce"],
    ["flaky", "重试", "#d7a948"],
  ]
    .map(
      ([k, n, col]) =>
        `<span style="--color:${col}">${n} ${number(c[k])}</span>`,
    )
    .join("")}</div>`;
}
function e2e(run) {
  return (run?.tests || []).filter((t) => t.layer === "e2e");
}
function sumReports(reports) {
  if (!reports.length || reports.some((r) => !r.counts)) return null;
  return Object.fromEntries(
    ["tests", "passed", "failed", "skipped", "flaky"].map((k) => [
      k,
      reports.reduce((n, r) => n + r.counts[k], 0),
    ]),
  );
}
function attention() {
  const out = [];
  const iss = data.issues,
    prs = data.prs,
    runs = data.quality.runs;
  if (iss?.unassigned_count)
    out.push([
      "warn",
      `${iss.unassigned_count} 个 Issue 尚未认领`,
      "为工作项明确负责人，减少等待。",
      "#work",
    ]);
  if (iss?.stale_count)
    out.push([
      "warn",
      `${iss.stale_count} 个 Issue 长时间无更新`,
      "确认是否仍在计划中。",
      "#work",
    ]);
  if (prs?.waiting_review_count)
    out.push([
      "warn",
      `${prs.waiting_review_count} 个 PR 超过评审时限`,
      "安排评审，解除交付阻塞。",
      "#work",
    ]);
  if (prs?.items?.some((p) => p.ci.state === "failure"))
    out.push([
      "critical",
      "开放 PR 存在失败检查",
      "先定位门禁失败，再安排合入。",
      "#work",
    ]);
  const latest = runs.filter(
    (r, i) =>
      runs.findIndex(
        (x) => x.channel === r.channel && x.workflow_id === r.workflow_id,
      ) === i,
  );
  for (const r of latest) {
    if (["failure", "timed_out"].includes(r.conclusion))
      out.push([
        "critical",
        `${channelNames[r.channel]}失败：${r.name}`,
        `提交 ${(r.sha || "").slice(0, 8)} · ${date(r.updated_at)}`,
        "#quality",
      ]);
    const c = sumReports(e2e(r));
    if (c && (c.failed || c.skipped || c.flaky))
      out.push([
        "warn",
        `E2E：${c.failed} 失败 · ${c.skipped} 跳过 · ${c.flaky} 重试`,
        `${r.name} · 跳过与不稳定用例不计为稳定通过`,
        "#quality",
      ]);
  }
  for (const kind of ["gate", "daily", "release"])
    if (!runs.some((r) => r.channel === kind))
      out.push([
        "warn",
        `${channelNames[kind]}暂无运行记录`,
        "尚不能判断此阶段的交付质量。",
        "#quality",
      ]);
  if (!out.length)
    out.push([
      "info",
      "当前未发现明确阻塞项",
      "仍需结合测试报告和评审状态判断是否可交付。",
      "#quality",
    ]);
  return `<ul class="attention">${out
    .slice(0, 8)
    .map(
      ([sev, title, note, url]) =>
        `<li><span class="dot ${sev}"></span><div><a href="${url}">${esc(title)} →</a><span class="sub">${esc(note)}</span></div></li>`,
    )
    .join("")}</ul>`;
}
function laneCard(kind) {
  const r = data.quality.runs.find((r) => r.channel === kind);
  const c = sumReports(e2e(r));
  return `<article class="card lane"><div class="kicker">${{ gate: "PULL REQUEST / CI", daily: "NIGHTLY / SCHEDULE", release: "RELEASE / VERSION" }[kind]}</div><h3>${channelNames[kind]}</h3>${r ? `<div class="run-title">${link(r.url, r.name)}</div>${badge(state(r))}<span class="sub">${esc(r.branch)} · <code>${esc(r.sha?.slice(0, 8))}</code> · 第 ${r.attempt} 次运行</span><span class="sub">${date(r.updated_at)}</span><div class="numbers"><div><b>${c ? number(c.passed) + " / " + number(c.tests) : "—"}</b><span>E2E 稳定通过 / 总用例</span></div><div><b>${c && c.tests ? ((c.passed / c.tests) * 100).toFixed(1) + "%" : "—"}</b><span>通过率</span></div></div>${c ? breakdown(c) : `<p class="small-note">${r.status === "completed" ? "没有可用的 E2E 用例报告；构建通过不等于 E2E 已通过。" : "运行尚未结束，测试结果待产出。"}</p>`}` : '<div class="empty">暂无运行记录<br><span class="sub">接入此类工作流后自动展示</span></div>'}</article>`;
}
function overview() {
  const iss = data.issues,
    prs = data.prs;
  const latest = data.quality.runs.find((r) => e2e(r).some((t) => t.counts));
  const c = sumReports(e2e(latest));
  return `<div class="grid metrics">${metric("开放 Issue", number(iss?.open_count), iss ? `${iss.unassigned_count} 未认领 · ${iss.stale_count} 陈旧` : "数据不可用")}${metric("待合入 PR", number(prs?.open_count), prs ? `${prs.waiting_review_count} 等待评审 · ${prs.draft_count} 草稿` : "数据不可用")}${metric("最近报告 · E2E", c ? `${number(c.passed)} / ${number(c.tests)}` : "—", latest ? `${latest.name} · ${date(latest.updated_at)}` : "尚无 E2E 用例报告")}${metric("最近发布版本", data.releases[0]?.tag || "—", data.releases[0] ? date(data.releases[0].published_at) : "尚未创建 Release")}</div>${heading("交付质量的三道观察窗", "各展示最近一次运行，不混用不同提交的测试结果")}<div class="grid lanes">${["gate", "daily", "release"].map(laneCard).join("")}</div>${heading("下一步值得关注")}<div class="grid split"><article class="card"><h2>风险与待办</h2>${attention()}</article><article class="card"><h2>交付节奏</h2><span class="sub">以工作项和评审为依据</span><div class="numbers"><div><b>${number(iss?.counts?.opened_30d)}</b><span>30 天新增 Issue</span></div><div><b>${number(iss?.counts?.closed_30d)}</b><span>30 天关闭 Issue</span></div><div><b>${number(prs?.merged_30d)}</b><span>30 天合入 PR</span></div></div><p class="small-note">${prs?.median_time_to_merge_h != null ? "PR 合入中位耗时 " + prs.median_time_to_merge_h + " 小时" : "暂无已合入 PR 的耗时样本"}</p><h3 style="margin-top:26px">门禁配置</h3><p class="small-note">${data.quality.required_checks?.length ? "必需检查：" + esc(data.quality.required_checks.join("、")) : data.quality.branch_protected === false ? "默认分支未启用保护。下方 PR 展示已上报的检查结果，不代表已强制门禁。" : "必需检查规则暂不可读取，请结合 GitHub 的合并条件。"}</p><a href="#work">查看工作项与 PR 检查 →</a></article></div>`;
}
function work() {
  return `${heading("Issue 与 Pull Request", "优先处理无人认领、等待评审和检查失败的工作项")}<div class="filters"><label>类型 <select id="work-kind" aria-label="类型"><option value="all">全部</option><option value="issue">Issue</option><option value="pr">PR</option></select></label><label>搜索 <input id="search" type="search" placeholder="标题、编号、负责人、标签" value="${esc(search)}"></label></div><div id="work-table"></div>`;
}
function workTable() {
  const items = [
    ...(data.issues?.items || []).map((i) => ({ ...i, kind: "issue" })),
    ...(data.prs?.items || []).map((i) => ({ ...i, kind: "pr" })),
  ].filter(
    (i) =>
      (workKind === "all" || i.kind === workKind) &&
      JSON.stringify([i.number, i.title, i.assignees, i.labels])
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const body = items
    .slice(0, 100)
    .map((i) => {
      const checks = i.ci?.checks || [];
      return `<tr><td class="title">${badge(i.kind, i.kind === "pr" ? "PR" : "Issue")} ${link(i.url, `#${i.number} ${i.title}`)}<div class="pills">${(i.labels || []).map((l) => `<span class="pill">${esc(l.name)}</span>`).join("")}</div></td><td>${esc((i.assignees || []).join(", ") || "未认领")}<span class="sub">作者 ${esc(i.author)}</span></td><td class="compact">${i.kind === "pr" ? badge(i.review_decision === "APPROVED" ? "success" : i.review_decision === "CHANGES_REQUESTED" ? "failure" : "pending", i.draft ? "草稿" : i.review_decision === "APPROVED" ? "已批准" : i.review_decision === "CHANGES_REQUESTED" ? "需修改" : "待评审") : esc(i.milestone || "未设里程碑")}</td><td>${i.kind === "pr" ? `${badge(i.ci?.state || "unknown")}<span class="sub">${checks.length} 项已上报检查 · ${esc(i.head_sha?.slice(0, 8))}</span>${checks.length ? `<details><summary>查看检查</summary>${checks.map((c) => `<p>${badge(c.conclusion)} ${link(c.url, c.name)}</p>`).join("")}</details>` : ""}` : "—"}</td><td class="compact">${number(Math.floor(i.age_days || 0))} 天<span class="sub">${date(i.updated_at)}</span></td></tr>`;
    })
    .join("");
  $("#work-table").innerHTML =
    `<p class="small-note">匹配 ${items.length} 项${items.length > 100 ? "，显示前 100 项；请缩小搜索范围" : ""}</p><div class="table-wrap"><table><thead><tr><th>工作项</th><th>负责人</th><th>评审 / 里程碑</th><th>当前提交检查</th><th>创建至今 / 更新</th></tr></thead><tbody>${body || '<tr><td colspan="5" class="empty">没有匹配的开放工作项</td></tr>'}</tbody></table></div>`;
}
function runCard(r) {
  return `<article class="card run-card"><div class="run-head"><h3>${link(r.url, r.name)} <span class="count-inline">${channelNames[r.channel]}</span></h3>${badge(state(r))}</div><p class="run-meta">${esc(r.branch)} · <code>${esc(r.sha?.slice(0, 12))}</code> · Run #${r.id} / attempt ${r.attempt} · ${date(r.updated_at)} · ${esc(r.event)}</p>${r.tests.length ? `<div class="table-wrap"><table><thead><tr><th>测试层 / 报告</th><th>总用例</th><th>稳定通过</th><th>失败</th><th>跳过</th><th>重试通过</th><th>通过率</th></tr></thead><tbody>${r.tests.map((t, i) => `<tr><td class="title"><strong>${esc(t.layer.toUpperCase())}</strong> <button type="button" class="test-link" data-run="${r.id}" data-test="${i}">${esc(t.name)} →</button><span class="sub">${badge(t.status)}</span></td>${["tests", "passed", "failed", "skipped", "flaky"].map((k) => `<td class="num">${number(t.counts?.[k])}</td>`).join("")}<td class="num">${t.counts?.tests ? ((t.counts.passed / t.counts.tests) * 100).toFixed(1) + "%" : "—"}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">${badge(r.reports_status)}<br>暂无可核验的用例数量；请上传 Playwright JSON、JUnit 或测试汇总产物。</p>`}<div class="job-list">${r.jobs.map((j) => `<span>${badge(j.conclusion || j.status)} ${link(j.url, j.name)}${j.failed_steps.length ? `<span class="sub">失败步骤：${esc(j.failed_steps.join("、"))}</span>` : ""}</span>`).join("")}</div></article>`;
}
function quality() {
  const runs = data.quality.runs.filter(
    (r) => lane === "all" || r.channel === lane,
  );
  return `${heading("构建与测试证据", "运行结果和测试用例结果分别判断")}<div class="filters"><label>阶段 <select id="lane" aria-label="阶段"><option value="all">全部阶段</option><option value="gate">合并门禁</option><option value="daily">每日构建</option><option value="release">版本验证</option></select></label><span class="muted">稳定通过率 = 通过 ÷ 总用例；跳过与重试通过单列</span></div>${runs.length ? runs.slice(0, 30).map(runCard).join("") : '<div class="card empty">此阶段尚无 Actions 运行记录。接入对应工作流后，这里会展示提交、任务和测试报告。</div>'}<p class="small-note">最多展示最近 100 次运行中的 30 次；优先读取各阶段／工作流最新报告，最多 12 次。重跑只使用当前 attempt 产生的产物。</p>`;
}
function releases() {
  return `${heading("版本验证", "仅关联版本提交 SHA 一致的版本验证运行")}<div class="card">${
    data.releases.length
      ? data.releases
          .map((release) => {
            const runs = data.quality.runs.filter((r) =>
              release.validation_run_ids.includes(r.id),
            );
            return `<div class="release-row"><div><h3>${link(release.url, release.tag)}</h3>${badge(release.prerelease ? "pending" : "success", release.prerelease ? "预发布" : "已发布")}<span class="sub">${date(release.published_at)}</span><code>${esc(release.sha?.slice(0, 12) || "提交未知")}</code></div><div>${runs.length ? runs.map((r) => `<div class="release-evidence">${badge(state(r))}${link(r.url, r.name)}<span>E2E ${countSummary({ counts: sumReports(e2e(r)) })}</span></div>`).join("") : `${badge("missing", "尚无匹配的版本验证")}<p class="small-note">发布成功不等于测试完成；等待此版本提交的验证运行。</p>`}</div></div>`;
          })
          .join("")
      : '<div class="empty">仓库尚无 Release。发布版本后，将按标签对应的提交关联验证证据。</div>'
  }</div>`;
}
function render() {
  if (!data) return;
  const tab = location.hash.slice(1) || "overview";
  document.querySelectorAll(".tabs a").forEach((a) => {
    const active = a.hash === "#" + tab;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  $("#content").innerHTML = (
    { overview, work, quality, releases }[tab] || overview
  )();
  if (tab === "work") {
    $("#work-kind").value = workKind;
    workTable();
    $("#work-kind").onchange = (e) => {
      workKind = e.target.value;
      workTable();
    };
    $("#search").oninput = (e) => {
      search = e.target.value;
      workTable();
    };
  }
  if (tab === "quality") {
    $("#lane").value = lane;
    $("#lane").onchange = (e) => {
      lane = e.target.value;
      render();
    };
  }
}
async function load() {
  const btn = $("#refresh");
  btn.disabled = true;
  try {
    const response = await fetch("./data/snapshot.json?ts=" + Date.now(), {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("快照暂不可用");
    const doc = await response.json();
    if (doc.schema_version !== 1) throw new Error("快照版本不兼容");
    data = doc;
    $("#repo-name").textContent =
      data.repository.name +
      " · " +
      (data.repository.description || "项目交付与质量跟踪");
    $("#source-link").href = safeUrl(data.repository.url);
    $("#updated-at").textContent = "数据更新于 " + date(data.generated_at);
    const age = (Date.now() - new Date(data.generated_at)) / 3600000;
    $("#freshness-badge").textContent =
      age > 2 ? "数据已超过 2 小时" : "快照已更新";
    $("#freshness-badge").className = "badge " + (age > 2 ? "warn" : "good");
    $("#banner").classList.toggle("hidden", !data.notices.length);
    $("#banner").textContent = data.notices.map((n) => n.message).join(" ");
    $("#scope-note").textContent = "数据来源：GitHub + Actions 测试产物";
    render();
  } catch (err) {
    $("#banner").textContent =
      "读取失败：" + err.message + "。可稍后刷新；保留已加载的数据。";
    $("#banner").classList.remove("hidden");
  } finally {
    btn.disabled = false;
  }
}
$("#refresh").onclick = load;
window.addEventListener("hashchange", render);
$("#close-detail").onclick = () => $("#test-detail").close();
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-test]");
  if (!btn || !data) return;
  const r = data.quality.runs.find((r) => String(r.id) === btn.dataset.run),
    t = r.tests[Number(btn.dataset.test)];
  $("#detail-title").textContent = t.layer.toUpperCase() + " · " + t.name;
  $("#detail-body").innerHTML =
    `<p>${link(r.url, `${r.name} · Run #${r.id} / attempt ${r.attempt}`)}</p><p class="small-note">${date(r.updated_at)} · ${esc(r.sha)}</p><h3>${esc(countSummary(t))}</h3>${breakdown(t.counts)}<div class="table-wrap" style="margin-top:20px"><table><thead><tr><th>结果</th><th>用例</th><th>文件 / 项目</th></tr></thead><tbody>${t.cases.length ? t.cases.map((c) => `<tr><td>${badge(c.status)}</td><td class="title">${esc(c.name)}</td><td>${esc(c.file)}<span class="sub">${esc(c.project || "")}</span></td></tr>`).join("") : '<tr><td colspan="3" class="empty">此报告仅提供汇总，没有逐用例明细。</td></tr>'}</tbody></table></div><p class="small-note">最多展示 500 条用例；原始日志、截图和 trace 请从 GitHub 运行页查看。</p>`;
  $("#test-detail").showModal();
});
load();
setInterval(load, 60000);
