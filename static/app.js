/* GitHub 状态看板 — 单页渲染逻辑（无构建、无依赖）。
 * 数据来自同站点静态 snapshot.json；每个区块独立渲染，区块级错误只影响自己的卡片。 */
(() => {
  'use strict';

  // ------------------------------------------------------------ utilities
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = (v) => (v == null ? '—' : Number(v).toLocaleString('zh-CN'));
  const pct = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`);
  const dur = (s) => {
    if (s == null) return '—';
    s = Math.round(s);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  };
  const hours = (h) => (h == null ? '—' : h * 60 < 1 ? '<1 分钟' : h < 1 ? `${Math.round(h * 60)} 分钟` : h < 48 ? `${h.toFixed(1)} 小时` : `${(h / 24).toFixed(1)} 天`);
  const codeify = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
  // Memory-only parts of the snapshot come back from the disk cache as {redacted:true} after a restart.
  const live = (v) => (v && typeof v === 'object' && v.redacted ? null : v);
  const pending = (v) => !!(v && typeof v === 'object' && v.redacted);
  const memoryOnlyNote = (what) => `<div class="muted">${badge('内存态', 'info')} ${esc(what)}只保留在进程内存、不写入磁盘缓存；服务刚重启，等待本轮采集（约 15 秒）后显示。</div>`;
  const ago = (iso) => {
    if (!iso) return '—';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 86400 * 60) return `${Math.floor(diff / 86400)} 天前`;
    return `${Math.floor(diff / 86400 / 30)} 个月前`;
  };
  const date = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');
  const shortDate = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const shortDateTime = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return `${shortDate(iso)} ${[d.getHours(), d.getMinutes(), d.getSeconds()].map((value) => String(value).padStart(2, '0')).join(':')}`;
  };
  const days = (d) => (d == null ? '—' : d < 1 ? '<1 天' : `${Math.round(d)} 天`);
  const tip = (text) => ` data-tip="${esc(text)}"`;
  const link = (href, text, extra = '') => `<a href="${esc(/^https:\/\//.test(href || "") ? href : "#")}" target="_blank" rel="noopener"${extra}>${text}</a>`;
  const LAYER_COLOR = { unit: 'var(--s1)', e2e: 'var(--s2)', st: 'var(--s3)', 'ci-self': 'var(--s4)', tooling: 'var(--s5)', other: 'var(--muted)' };
  const LAYER_NAME = { unit: '单元 (unit)', e2e: '端到端 (e2e)', st: '系统/冒烟 (st)', 'ci-self': 'CI 自检', tooling: '脚本工具', other: '其他' };
  const CONCLUSION_TONE = { success: 'good', failure: 'bad', timed_out: 'bad', cancelled: '', skipped: '', in_progress: 'warn', queued: 'warn', pending: 'warn', neutral: '', action_required: 'warn', startup_failure: 'bad', error: 'bad', expected: 'warn' };
  const CONCLUSION_NAME = { success: '成功', failure: '失败', timed_out: '超时', cancelled: '取消', skipped: '跳过', in_progress: '运行中', queued: '排队', pending: '等待', neutral: '中性', action_required: '需处理', startup_failure: '启动失败', error: '错误', expected: '等待' };

  const STATE = { snap: null, status: null, tab: 'overview', sort: {}, filters: { issueQ: '', issueLabel: '', issueAssignee: '', runBranch: '' }, coverageWeekOffset: 0, pollTimer: null };

  // ------------------------------------------------------------ components
  const badge = (text, tone = '', extra = '') => `<span class="badge ${tone}"${extra}>${esc(text)}</span>`;
  const conclusionBadge = (c) => badge(CONCLUSION_NAME[c] || c || '未知', CONCLUSION_TONE[c] ?? '');
  const tiles = (items) => `<div class="tiles">${items.map((t) => {
    const inner = `<div class="label"><span>${esc(t.label)}</span>${t.tag ? `<span>${t.tag}</span>` : ''}</div>
      <div class="value">${t.value}${t.unit ? `<small>${esc(t.unit)}</small>` : ''}</div>${t.sub ? `<div class="foot">${t.sub}</div>` : ''}`;
    return `<div class="tile ${t.tone || ''}">${t.href ? `<a href="${esc(t.href)}">${inner}</a>` : inner}</div>`;
  }).join('')}</div>`;
  const card = (title, body, opts = {}) => `<div class="card ${opts.span2 ? 'span2' : ''}"><h3>${esc(title)}${opts.sub ? `<span class="sub">${opts.sub}</span>` : ''}</h3>${body}</div>`;
  const empty = (text) => `<div class="empty">${esc(text)}</div>`;
  const kv = (pairs) => `<dl class="kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const sectionHead = (title, sub = '') => `<div class="section-head"><h2>${esc(title)}</h2><span class="sub">${sub}</span></div>`;

  /** Horizontal magnitude bars: one hue (sequential job), value text in ink. */
  const bars = (items, opts = {}) => {
    if (!items.length) return empty(opts.emptyText || '暂无数据');
    const max = opts.max ?? Math.max(...items.map((i) => i.value || 0), 1);
    return `<div class="bars">${items.map((i) => {
      const segs = i.segments
        ? i.segments.map((s) => `<span class="fill" style="width:${(s.value / max) * 100}%;background:${s.color}"${tip(`${s.name}: ${s.value}`)}></span>`).join('')
        : `<span class="fill" style="width:${((i.value || 0) / max) * 100}%;${i.color ? `background:${i.color}` : ''}"></span>`;
      return `<span class="lbl" title="${esc(i.label)}">${i.labelHtml || esc(i.label)}</span><span class="track">${segs}</span><span class="val">${i.valueText ?? n(i.value)}</span>`;
    }).join('')}</div>`;
  };
  const legend = (items) => `<div class="legend">${items.map((i) => `<span><i style="background:${i.color}"></i>${esc(i.name)}${i.value != null ? ` ${n(i.value)}` : ''}</span>`).join('')}</div>`;
  const stack = (segments) => {
    const total = segments.reduce((a, s) => a + (s.value || 0), 0) || 1;
    return `<div class="stack">${segments.filter((s) => s.value).map((s) => `<span style="width:${(s.value / total) * 100}%;background:${s.color}"${tip(`${s.name}: ${s.value} (${((s.value / total) * 100).toFixed(1)}%)`)}></span>`).join('')}</div>`;
  };
  const ratioBar = (v, tone = '') => `<span class="ratio ${tone}"><span style="width:${Math.max(0, Math.min(100, v || 0))}%"></span></span>`;
  const sparkline = (values, labels = [], unit = '次提交') => {
    if (!values.length) return '';
    const w = 400, h = 54, pad = 4, max = Math.max(...values, 1);
    const pts = values.map((v, i) => [pad + (i * (w - 2 * pad)) / Math.max(values.length - 1, 1), h - pad - (v / max) * (h - 2 * pad)]);
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const area = `${path} L${pts[pts.length - 1][0].toFixed(1)},${h - pad} L${pts[0][0].toFixed(1)},${h - pad} Z`;
    const last = pts[pts.length - 1];
    const dots = pts.map((p, i) => `<rect x="${(p[0] - 6).toFixed(1)}" y="0" width="12" height="${h}" fill="transparent"${tip(`${labels[i] || ''}: ${values[i]} ${unit}`)}></rect>`).join('');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path class="area" d="${area}"></path><line class="base" x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}"></line><path d="${path}"></path><circle cx="${last[0]}" cy="${last[1]}" r="3"></circle>${dots}</svg>`;
  };
  const dayDate = (day) => new Date(`${day}T00:00:00Z`);
  const dayString = (value) => {
    const d = value instanceof Date ? value : dayDate(value);
    return d.toISOString().slice(0, 10);
  };
  const addDays = (day, count) => {
    const d = dayDate(day);
    d.setUTCDate(d.getUTCDate() + count);
    return dayString(d);
  };
  const weekStart = (day) => {
    const d = dayDate(day);
    const offset = (d.getUTCDay() + 6) % 7;
    return addDays(day, -offset);
  };
  const dayLabel = (day) => {
    const d = dayDate(day);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  };
  const coverageRange = (languages) => {
    const days = Object.values(languages).flatMap((dataset) => (dataset.history || []).map((row) => row.day).filter(Boolean)).sort();
    if (!days.length) return null;
    const latestDay = days[days.length - 1];
    const earliest = weekStart(days[0]);
    const firstHistoryWeek = addDays(weekStart(latestDay), -7);
    const maxOffset = dayDate(firstHistoryWeek) < dayDate(earliest)
      ? 0
      : Math.floor((dayDate(firstHistoryWeek) - dayDate(earliest)) / 604800000) + 1;
    STATE.coverageWeekOffset = Math.max(0, Math.min(STATE.coverageWeekOffset, maxOffset));
    if (STATE.coverageWeekOffset === 0) {
      return { start: addDays(latestDay, -6), end: latestDay, maxOffset, recent: true };
    }
    const start = addDays(firstHistoryWeek, -7 * (STATE.coverageWeekOffset - 1));
    return { start, end: addDays(start, 6), maxOffset, recent: false };
  };
  const coverageTrend = (history, selectedWeek) => {
    if (!selectedWeek) return '';
    const w = 800, h = 210, left = 58, right = 18, top = 12, bottom = 34;
    const plotW = w - left - right, plotH = h - top - bottom;
    const byDay = new Map(history.filter((row) => row.day).map((row) => [row.day, row]));
    const slots = Array.from({ length: 7 }, (_, index) => {
      const day = addDays(selectedWeek, index);
      return { day, row: byDay.get(day) || null };
    });
    const values = slots.filter((slot) => slot.row?.totals?.lines?.percentage != null)
      .map((slot) => Number(slot.row.totals.lines.percentage));
    if (!values.length) {
      return `<div class="coverage-week-empty">${slots.map((slot) => `<span>${dayLabel(slot.day)}</span>`).join('')}<strong>该周没有成功的完整覆盖率结果</strong></div>`;
    }
    const rawMin = Math.min(...values), rawMax = Math.max(...values);
    const margin = Math.max((rawMax - rawMin) * 0.18, 0.5);
    const paddedMin = Math.max(0, rawMin - margin), paddedMax = Math.min(100, rawMax + margin);
    const roughStep = Math.max((paddedMax - paddedMin) / 4, 0.1);
    const magnitude = 10 ** Math.floor(Math.log10(roughStep));
    const fraction = roughStep / magnitude;
    const tickStep = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude;
    const yMin = Math.max(0, Math.floor(paddedMin / tickStep) * tickStep);
    const yMax = Math.min(100, Math.ceil(paddedMax / tickStep) * tickStep);
    const yRange = yMax - yMin || 1;
    const pts = slots.map((slot, index) => {
      if (!slot.row) return null;
      const value = Number(slot.row.totals.lines.percentage);
      return {
        x: left + (index * plotW) / 6,
        y: top + ((yMax - value) / yRange) * plotH,
        value,
        row: slot.row,
        day: slot.day,
      };
    });
    const segments = [];
    for (const point of pts) {
      if (!point) {
        if (segments.length && segments[segments.length - 1].length) segments.push([]);
        continue;
      }
      if (!segments.length) segments.push([]);
      segments[segments.length - 1].push(point);
    }
    const populated = segments.filter((segment) => segment.length);
    const paths = populated.map((segment) => segment.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '));
    const baseY = top + plotH;
    const areas = populated.filter((segment) => segment.length > 1).map((segment) => {
      const path = segment.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
      return `${path} L${segment[segment.length - 1].x.toFixed(1)},${baseY} L${segment[0].x.toFixed(1)},${baseY} Z`;
    });
    const ticks = Array.from({ length: Math.round((yMax - yMin) / tickStep) + 1 }, (_, index) => yMin + tickStep * index);
    const yAxis = ticks.map((value) => {
      const y = top + ((yMax - value) / yRange) * plotH;
      const label = tickStep < 1 ? value.toFixed(1) : value.toFixed(0);
      return `<line class="coverage-grid" x1="${left}" y1="${y.toFixed(1)}" x2="${w - right}" y2="${y.toFixed(1)}"></line><text class="coverage-y-label" x="${left - 9}" y="${(y + 4).toFixed(1)}" text-anchor="end">${label}%</text>`;
    }).join('');
    const xAxis = slots.map((slot, index) => {
      const x = left + (index * plotW) / 6;
      const anchor = index === 0 ? 'start' : index === 6 ? 'end' : 'middle';
      return `<text class="coverage-x-label" x="${x.toFixed(1)}" y="${h - 8}" text-anchor="${anchor}">${dayLabel(slot.day)}</text>`;
    }).join('');
    const dots = pts.filter(Boolean).map((point) => {
      const label = `${date(point.row.created_at)} · ${pct(point.value)}\n${point.row.kind === 'nightly' ? 'nightly' : 'main push'} · ${(point.row.sha || '').slice(0, 12)}\n${point.row.artifact || ''}`;
      return `<circle class="coverage-dot" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4"></circle><circle class="coverage-hit" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="11"${tip(label)}></circle>`;
    }).join('');
    return `<svg class="coverage-trend" viewBox="0 0 ${w} ${h}" role="img" aria-label="完整行覆盖率历史趋势">${yAxis}<line class="coverage-axis" x1="${left}" y1="${top}" x2="${left}" y2="${baseY}"></line><line class="coverage-axis" x1="${left}" y1="${baseY}" x2="${w - right}" y2="${baseY}"></line>${areas.map((area) => `<path class="coverage-area" d="${area}"></path>`).join('')}${paths.map((path) => `<path class="coverage-line" d="${path}"></path>`).join('')}${dots}${xAxis}</svg>`;
  };
  // CI history lanes: one row per trigger lane, one column per day on a shared axis.
  // The collector buckets days and orders runs, so a column simply stacks them top-down.
  const LANE_SOURCE = { pr: 'CI · pull_request', main: 'CI · 默认分支 push / 手动', daily: 'Nightly · 定时 / 手动', release: 'Release · 版本 tag' };
  const LANE_OUTCOMES = [['success', '成功'], ['failure', '失败/超时'], ['cancelled', '取消'], ['running', '运行中'], ['other', '其他（待批准等）']];
  const LANE_EVENT = { schedule: 'schedule · 定时', workflow_dispatch: 'workflow_dispatch · 手动' };
  const LANE_STACK = 10; // runs visible per day before that column scrolls
  const laneDay = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${m}/${d}`; };
  const laneRun = (lane, day, r, zone) => {
    const pr = r.pr ? ` · PR #${r.pr}${r.pr_linked ? '' : '（按分支推断）'}` : '';
    const text = [
      `${r.workflow} · ${LANE_EVENT[r.event] || r.event || '未知事件'}${pr}`,
      `${CONCLUSION_NAME[r.conclusion] || CONCLUSION_NAME[r.status] || r.conclusion || r.status || '未知'}${r.attempt > 1 ? ` · 第 ${r.attempt} 次尝试` : ''}`,
      `${laneDay(day)} ${r.time}（${zone}）`,
      `${lane === 'release' ? '标签' : '分支'} ${r.branch || '—'}${r.sha ? ` · ${r.sha}` : ''}`,
      r.title,
    ].filter(Boolean).join('\n');
    const href = /^https:\/\//.test(r.url || '') ? r.url : '#';
    return `<a class="ci-run ${esc(r.outcome)}" href="${esc(href)}" target="_blank" rel="noopener" aria-label="${esc(text)}"${tip(text)}></a>`;
  };
  const ciLanes = (L) => {
    if (!L) return empty('分层历史会在下一次采集后出现');
    const zone = L.zone || 'UTC+8';
    const uncollected = (day) => L.collected_since && day < L.collected_since;
    const outcomes = (runs) => LANE_OUTCOMES.map(([key, name]) => [name, runs.filter((r) => r.outcome === key).length]).filter(([, count]) => count).map(([name, count]) => `${name} ${count}`).join(' · ');
    const rows = L.lanes.map((lane) => {
      const s = lane.summary;
      const counts = [['成功', s.success], ['失败', s.failure], ['取消', s.cancelled], ['运行中', s.running], ...(s.other ? [['其他', s.other]] : [])];
      const head = `<div class="ci-lane-head" role="rowheader"><b>${esc(lane.label)}</b><span class="ci-lane-src">${esc(LANE_SOURCE[lane.key] || '')}</span>`
        + `<span class="ci-lane-rate">成功率 ${pct(s.success_rate)}</span>`
        + `<span class="ci-lane-sum">${s.total ? counts.map(([name, count]) => `<span>${name} ${count}</span>`).join(' · ') : '窗口内没有 run'}</span></div>`;
      const days = lane.days.map((runs, i) => {
        const day = L.days[i];
        if (uncollected(day)) return `<div class="ci-lane-day uncollected" role="cell"${tip(`${laneDay(day)} 未采集`)}></div>`;
        const more = runs.length > LANE_STACK ? `<span class="ci-day-more">${runs.length}</span>` : '';
        const note = runs.length ? tip(`${laneDay(day)} · ${lane.label} ${runs.length} 次\n${outcomes(runs)}`) : '';
        return `<div class="ci-lane-day${more ? ' dense' : ''}" role="cell"${note}><div class="ci-day-stack">${runs.map((r) => laneRun(lane.key, day, r, zone)).join('')}</div>${more}</div>`;
      }).join('');
      return `<div class="ci-lane-row" role="row" data-lane="${esc(lane.key)}">${head}${days}</div>`;
    }).join('');
    const axis = L.days.map((day, i) => `<div class="ci-axis-day" role="columnheader">${i === 0 || day.endsWith('-01') ? laneDay(day) : Number(day.slice(8))}</div>`).join('');
    const ex = L.excluded || {};
    const notes = [
      '成功率 = 成功 ÷（成功 + 失败/超时），取消、运行中与其他不计入；重跑按最后一次尝试着色，仍放在 run 创建的那天。',
      'Nightly / Release 通过 workflow_call 调用的 CI 不单独成点，只计入调用方所在的 Daily / 版本层。',
      ex.other ? `另有 ${ex.other} 次 run 不属于这四层（其他工作流或非默认分支 push），未画入。` : '',
      ex.called ? `${ex.called} 次由其他工作流调用的 CI 子 run 已并入调用方。` : '',
      ex.unknown ? `${ex.unknown} 次 run 缺少触发事件，无法分层。` : '',
      L.collected_since ? `${laneDay(L.collected_since)} 之前的日期尚未采集（斜纹），不代表没有运行。` : '',
    ].filter(Boolean);
    const legendItems = LANE_OUTCOMES.map(([key, name]) => `<span><i class="ci-run ${key}"></i>${esc(name)}</span>`).join('') + (L.collected_since ? '<span><i class="ci-lane-day uncollected"></i>未采集</span>' : '');
    return `<div class="ci-lanes-scroll"><div class="ci-lanes" role="table" aria-label="CI 分层历史" style="--days:${L.days.length}">${rows}<div class="ci-lane-row ci-axis" role="row"><div class="ci-lane-head" role="rowheader"></div>${axis}</div></div></div>`
      + `<div class="legend ci-legend">${legendItems}</div><ul class="notes ci-lane-notes">${notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  };
  // Narrow screens scroll the day axis. Stay on the newest day unless the reader scrolled away.
  const pinLanes = (keep) => {
    const el = $('#tab-ci .ci-lanes-scroll');
    if (!el || !el.clientWidth) return;
    if (keep != null) { el.scrollLeft = keep; el.dataset.away = '1'; } else if (!el.dataset.away) el.scrollLeft = el.scrollWidth;
  };
  const labelChips = (labels) => labels.map((l) => `<span class="label-chip"><span class="sw" style="background:#${esc(l.color || '999')}"></span>${esc(l.name)}</span>`).join('');

  /** Sortable table. cols: [{key,label,num,render,sort}] ; rows: objects. Sorting is client-side by id. */
  const table = (id, cols, rows, opts = {}) => {
    const sort = STATE.sort[id] || opts.defaultSort || null;
    let data = rows.slice();
    if (sort) {
      const col = cols.find((c) => c.key === sort.key);
      const getter = col?.sort || ((r) => r[sort.key]);
      data.sort((a, b) => {
        const va = getter(a), vb = getter(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return (va > vb ? 1 : va < vb ? -1 : 0) * (sort.dir === 'desc' ? -1 : 1);
      });
    }
    if (opts.limit) data = data.slice(0, opts.limit);
    if (!data.length) return empty(opts.emptyText || '暂无数据');
    const head = cols.map((c) => `<th class="${c.num ? 'num' : ''} ${c.sortable === false ? '' : 'sortable'}" data-table="${id}" data-key="${c.key}">${esc(c.label)}${sort && sort.key === c.key ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : ''}</th>`).join('');
    const body = data.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${opts.limit && rows.length > opts.limit ? `<div class="muted" style="margin-top:6px">仅显示前 ${opts.limit} / ${rows.length} 条</div>` : ''}`;
  };

  const KIND_TEXT = { unauthorized: '未授权', forbidden: '权限不足', rate_limited: 'API 限流', not_found: '不存在或无权限', network: '网络错误', server: 'GitHub 服务端错误', internal: '看板内部错误', error: '错误' };
  const errorBanner = (err, what = '') => {
    if (!err) return '';
    const reset = err.reset_at ? `（重置于 ${date(new Date(err.reset_at * 1000).toISOString())}）` : '';
    const hint = err.hint ? `<div class="hint">${esc(err.hint).replace(/`([^`]+)`/g, '<code>$1</code>')}</div>` : '';
    return `<div class="banner error"><span class="icon">⛔</span><div><div class="title">${esc(what)}${KIND_TEXT[err.kind] || err.kind}${err.status ? ` · HTTP ${err.status}` : ''}${reset}</div><div>${esc(err.message)}</div>${hint}${err.trace ? `<details><summary>堆栈</summary><pre class="mono">${esc(err.trace)}</pre></details>` : ''}</div><div class="banner-actions"><button class="btn small" data-action="refresh">重试</button></div></div>`;
  };
  const notesList = (notes) => (notes && notes.length ? `<ul class="notes">${notes.map((x) => `<li><b>${esc(x.what || x.key)}</b>：${esc(x.message)}${x.hint ? ` <span class="muted">${esc(x.hint)}</span>` : ''}</li>`).join('')}</ul>` : '');
  const sectionState = (sec, name) => {
    if (!sec) return `<div class="banner warn"><span class="icon">⏳</span><div><div class="title">${esc(name)} 尚未采集</div><div>当前已发布快照没有这部分数据。</div></div></div>`;
    if (sec.status === 'error') return errorBanner(sec.error, `${name}：`);
    return notesList(sec.notes);
  };

  // ------------------------------------------------------------ renderers
  function renderOverview(snap) {
    const S = snap.sections;
    const repo = S.repo?.data, iss = S.issues?.data, prs = S.prs?.data, ci = S.ci?.data, tests = S.tests?.data, ops = S.ops?.data;
    const ut = tests?.executed?.find((e) => e.layer === 'ut' || e.artifact.startsWith('ut'));
    const e2e = tests?.executed?.find((e) => e.layer === 'e2e');
    const mainRate = ci?.main?.success_rate;
    const cov = tests?.coverage;
    const coverageLanguages = [['node', 'Node.js'], ['python', 'Python']].map(([key, label]) => {
      const dataset = cov?.languages?.[key];
      const value = dataset?.current?.totals?.lines?.percentage ?? dataset?.baseline?.totals?.lines?.percentage;
      return value == null ? null : `${label} ${pct(value)}`;
    }).filter(Boolean).join(' · ');
    const rel = ops?.releases?.latest;
    let html = window.GSBQuality?.summary() || '';
    html += repo ? `<div class="muted" style="margin-bottom:10px">${esc(repo.description || '')} · ⭐ ${n(repo.stars)} · fork ${n(repo.forks)} · ${esc(repo.language || '')} · ${esc(repo.license || '无 license')} · 默认分支 <code>${esc(repo.default_branch)}</code> · 最近 push ${ago(repo.pushed_at)}</div>` : '';
    html += tiles([
      { label: 'Issue 开放', value: n(iss?.open_count), href: '#issues', sub: iss ? `7 天 +${n(iss.counts.opened_7d)} / −${n(iss.counts.closed_7d)} · 陈旧 ${n(iss.stale_count)}` : '—', tone: '' },
      { label: 'PR 开放', value: n(prs?.open_count), href: '#prs', sub: prs ? `草稿 ${prs.draft_count} · 等待评审 ${prs.waiting_review_count} · CI 失败 ${prs.ci_states.failure || 0}` : '—', tone: prs && prs.waiting_review_count ? 'warn' : '' },
      { label: `CI 主干成功率`, value: pct(mainRate), href: '#ci', sub: ci ? `连续失败 ${ci.red_streak_main} 次 · 7 天失败 ${ci.failures_7d}` : '—', tone: mainRate == null ? '' : mainRate >= 80 ? 'good' : mainRate >= 50 ? 'warn' : 'bad' },
      { label: 'CI 最近执行用例', value: n(ut?.totals?.tests), href: '#tests', sub: ut?.totals ? `UT 通过 ${n(ut.totals.passed)} · 失败 ${n(ut.totals.failed)}${e2e?.totals ? ` · E2E ${e2e.totals.passed}/${e2e.totals.tests}` : ''}` : ut ? '产物存在但没有解析出用例数' : '无产物', tone: ut?.totals?.failed ? 'bad' : '' },
      { label: '测试文件', value: n(tests?.tree?.total), href: '#tests', sub: tests?.tree ? Object.entries(tests.tree.by_layer).map(([k, v]) => `${k} ${v}`).join(' · ') : '—' },
      { label: '整仓行覆盖率', value: cov?.value?.lines_pct != null ? pct(cov.value.lines_pct) : '无数据源', href: '#coverage', sub: cov?.source ? (coverageLanguages || '单一来源') : '已探测 Actions / Codecov / check-run，均未命中', tone: cov?.source ? (cov?.current?.kind === 'authoritative' ? 'good' : 'warn') : 'warn' },
      { label: '最新 Release', value: rel ? esc(rel.tag) : '—', href: '#ops', sub: rel ? `${days(rel.age_days)}前 · 未发布提交 ${n(ops.releases.unreleased?.commits)}` : '无 release' },
      { label: '社区健康度', value: ops?.community ? pct(ops.community.health_percentage) : '—', href: '#ops', sub: ops?.community ? `缺 ${ops.community.missing.join(', ') || '无'}` : '—' },
    ]);

    // Attention list — computed from the same data the tabs show.
    const items = [];
    if (ci?.red_streak_main) items.push(['critical', `主干 CI 连续失败 ${ci.red_streak_main} 次；最近一次失败 job：${(ci.latest_main?.jobs || []).filter((j) => j.conclusion === 'failure').map((j) => `${j.name}${j.failed_steps.length ? `（步骤 ${j.failed_steps.join('、')}）` : ''}`).join('、') || '—'}`, '#ci']);
    if (prs?.waiting_review_count) items.push(['warn', `${prs.waiting_review_count} 个 PR 超过 ${prs.review_sla_days} 天无人评审：${prs.items.filter((p) => p.waiting_review).map((p) => `#${p.number}`).join(' ')}`, '#prs']);
    if (prs?.ci_states?.failure) items.push(['warn', `${prs.ci_states.failure} 个开放 PR 的 CI 为失败状态`, '#prs']);
    if (prs?.items?.some((p) => p.mergeable === 'CONFLICTING')) items.push(['warn', `存在冲突的 PR：${prs.items.filter((p) => p.mergeable === 'CONFLICTING').map((p) => `#${p.number}`).join(' ')}`, '#prs']);
    if (e2e?.totals?.failed) items.push(['warn', `最近 E2E 产物有 ${e2e.totals.failed} 个失败/超时用例（分支 ${e2e.branch}）`, '#tests']);
    if (iss?.no_response_count) items.push(['info', `${iss.no_response_count} 个开放 Issue 还没有任何评论，${iss.unassigned_count} 个无人认领，${iss.unlabeled_count} 个无标签`, '#issues']);
    if (iss?.stale_count) items.push(['info', `${iss.stale_count} 个 Issue 超过 ${iss.stale_days_threshold} 天没有更新`, '#issues']);
    if (tests?.inventory?.some((p) => !p.tested)) items.push(['info', `没有任何测试文件的包：${tests.inventory.filter((p) => !p.tested).map((p) => p.package).join('、')}`, '#tests']);
    if (cov && !cov.source) items.push(['info', '仓库没有可用的覆盖率数据源（无 coverage 产物 / Codecov / 覆盖率配置）', '#coverage']);
    if (ops?.branches?.protection && !ops.branches.protection.enabled) items.push(['warn', `默认分支 ${ops.branches.default} 未启用分支保护（rulesets ${ops.branches.rulesets?.length || 0} 条）`, '#ops']);
    if (ops?.branches?.stale?.length) items.push(['info', `陈旧分支：${ops.branches.stale.map((b) => `${b.name}（落后 ${n(b.behind)}）`).join('、')}`, '#ops']);
    if (live(ops?.security) && !ops.security.dependabot?.ok) items.push(['info', `安全告警不可读：${ops.security.dependabot?.error?.hint || ''}`, '#ops']);
    if (live(ops?.security)?.dependabot?.ok && ops.security.dependabot.open) items.push(['warn', `${ops.security.dependabot.open} 个开放的 Dependabot 告警`, '#ops']);
    if (ops?.releases?.unreleased?.commits > 50) items.push(['info', `自 ${ops.releases.latest?.tag} 以来已有 ${n(ops.releases.unreleased.commits)} 个提交未发布`, '#ops']);
    if (ops?.contributors?.bus_factor_50 === 1) items.push(['info', `贡献高度集中：一位贡献者贡献了 ${ops.contributors.top[0]?.share}% 的提交`, '#ops']);
    if (!items.length) items.push(['info', '当前快照未发现告警；数据缺失的项目请查看对应页面', '#overview']);

    const status = Object.entries(S).map(([k, s]) => badge(`${k} ${s.status}${s.elapsed_s ? ` · ${s.elapsed_s}s` : ''}`, s.status === 'ok' ? 'good' : s.status === 'partial' ? 'warn' : 'bad'));
    html += `<div class="grid wide" style="margin-top:12px">${card('需要关注', `<ul class="attention">${items.map(([sev, text, href]) => `<li><span class="sev ${sev}"></span><span>${codeify(text)} <a href="${href}">查看</a></span></li>`).join('')}</ul>`)}
      ${card('数据源状态', `<div class="status-row">${status.join('')}</div>${kv([
        ['采集时间', `${date(snap.generated_at)}（${ago(snap.generated_at)}）`],
        ['数据来源', link(snap.repo_url, esc(snap.repo))],
        ['视图刷新', '每 60 秒读取已发布快照'],
      ])}<div class="muted" style="margin-top:8px">各区块的错误与降级说明显示在对应标签页顶部。</div>`)}</div>`;
    return html;
  }

  function renderIssues(sec) {
    const d = sec?.data;
    let html = sectionState(sec, 'Issue');
    if (!d) return html;
    html += tiles([
      { label: '开放', value: n(d.open_count), sub: d.truncated ? '列表已截断（只取前 500）' : '' },
      { label: '已关闭（累计）', value: n(d.counts.closed_total) },
      { label: '30 天新增', value: n(d.counts.opened_30d), sub: `7 天 ${n(d.counts.opened_7d)}` },
      { label: '30 天关闭', value: n(d.counts.closed_30d), sub: `7 天 ${n(d.counts.closed_7d)}` },
      { label: `陈旧（≥${d.stale_days_threshold} 天无更新）`, value: n(d.stale_count), tone: d.stale_count ? 'warn' : '' },
      { label: '无人认领', value: n(d.unassigned_count), tone: d.unassigned_count ? 'warn' : '' },
      { label: '无标签', value: n(d.unlabeled_count) },
      { label: '零回复', value: n(d.no_response_count) },
      { label: '中位年龄', value: days(d.median_age_days), sub: `最老 ${days(d.oldest_age_days)}` },
    ]);
    const issueRow = (i) => `<span class="title">${link(i.url, `#${i.number} ${esc(i.title)}`)}</span><span class="sub">${esc(i.author)} · ${labelChips(i.labels)}</span>`;
    html += `<div class="grid">
      ${card('标签分布', bars(d.labels.map((l) => ({ label: l.name, labelHtml: `<span class="label-chip"><span class="sw" style="background:#${esc(l.color || '999')}"></span>${esc(l.name)}</span>`, value: l.count })), { emptyText: '开放 Issue 都没有标签' }) + (d.unused_labels.length ? `<div class="muted" style="margin-top:8px">仓库另有 ${d.unused_labels.length} 个标签未用于任何开放 Issue：${esc(d.unused_labels.join('、'))}</div>` : ''), { sub: '按开放 Issue 计数' })}
      ${card('年龄分布', bars(d.aging.map((a) => ({ label: a.bucket, value: a.count }))), { sub: '按创建时间' })}
      ${card('认领负载', bars(d.assignee_load.map((a) => ({ label: a.login, value: a.count })), { emptyText: '所有开放 Issue 均无人认领' }), { sub: '按 assignee' })}
      ${card('里程碑', bars(d.milestones.map((m) => ({ label: m.name, value: m.count }))))}
    </div>`;
    html += `<div class="grid wide" style="margin-top:12px">
      ${card('最近更新', table('iss-recent', [
        { key: 'number', label: 'Issue', render: issueRow, sortable: false },
        { key: 'updated_at', label: '更新', render: (i) => ago(i.updated_at) },
        { key: 'comments', label: '评论', num: true },
      ], d.recent, { limit: 10 }))}
      ${card('最久未动', table('iss-stale', [
        { key: 'number', label: 'Issue', render: issueRow, sortable: false },
        { key: 'idle_days', label: '闲置', num: true, render: (i) => days(i.idle_days) },
        { key: 'age_days', label: '年龄', num: true, render: (i) => days(i.age_days) },
      ], (d.stale.length ? d.stale : d.oldest), { limit: 10, emptyText: '没有陈旧 Issue' }), { sub: d.stale.length ? `≥${d.stale_days_threshold} 天无更新` : '暂无陈旧 Issue，显示最老的开放 Issue' })}
    </div>`;
    // Drill-down list with filters.
    const f = STATE.filters;
    const labels = [...new Set(d.items.flatMap((i) => i.labels.map((l) => l.name)))].sort();
    const assignees = [...new Set(d.items.flatMap((i) => i.assignees))].sort();
    let rows = d.items;
    if (f.issueQ) rows = rows.filter((i) => `${i.number} ${i.title} ${i.author}`.toLowerCase().includes(f.issueQ.toLowerCase()));
    if (f.issueLabel === '__none__') rows = rows.filter((i) => !i.labels.length);
    else if (f.issueLabel) rows = rows.filter((i) => i.labels.some((l) => l.name === f.issueLabel));
    if (f.issueAssignee === '__none__') rows = rows.filter((i) => !i.assignees.length);
    else if (f.issueAssignee) rows = rows.filter((i) => i.assignees.includes(f.issueAssignee));
    if(d.preview_total>d.items.length)html += `<p>当前列表 ${d.items.length} / ${d.preview_total} · <a href="#history">查看全部历史</a></p>`;
    html += sectionHead('开放 Issue', `${rows.length} / ${d.items.length}`);
    html += `<div class="card"><div class="filters">
      <input type="text" data-filter="issueQ" placeholder="搜索编号 / 标题 / 作者" value="${esc(f.issueQ)}">
      <select data-filter="issueLabel"><option value="">全部标签</option><option value="__none__" ${f.issueLabel === '__none__' ? 'selected' : ''}>无标签</option>${labels.map((l) => `<option ${f.issueLabel === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <select data-filter="issueAssignee"><option value="">全部认领人</option><option value="__none__" ${f.issueAssignee === '__none__' ? 'selected' : ''}>无人认领</option>${assignees.map((a) => `<option ${f.issueAssignee === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>
    </div>${table('iss-all', [
      { key: 'number', label: '#', num: true, render: (i) => link(i.url, `#${i.number}`) },
      { key: 'title', label: '标题', render: (i) => `${link(i.url, esc(i.title))}<div class="sub">${labelChips(i.labels)}${i.milestone ? ` · ${esc(i.milestone)}` : ''}</div>` },
      { key: 'author', label: '作者' },
      { key: 'assignees', label: '认领', render: (i) => (i.assignees.length ? esc(i.assignees.join(', ')) : '<span class="muted">—</span>'), sort: (i) => i.assignees.join(',') },
      { key: 'comments', label: '评论', num: true },
      { key: 'created_at', label: '创建', render: (i) => ago(i.created_at) },
      { key: 'updated_at', label: '更新', render: (i) => ago(i.updated_at) },
    ], rows, { defaultSort: { key: 'updated_at', dir: 'desc' } })}</div>`;
    return html;
  }

  function renderPRs(sec) {
    const d = sec?.data;
    let html = sectionState(sec, 'PR');
    if (!d) return html;
    html += tiles([
      { label: '开放 PR', value: n(d.open_count) },
      { label: '草稿', value: n(d.draft_count) },
      { label: `等待评审 > ${d.review_sla_days} 天`, value: n(d.waiting_review_count), tone: d.waiting_review_count ? 'warn' : 'good' },
      { label: 'CI 失败', value: n(d.ci_states.failure || 0), tone: d.ci_states.failure ? 'bad' : 'good', sub: `成功 ${d.ci_states.success || 0} · 进行中 ${d.ci_states.pending || 0}` },
      { label: '30 天合并', value: n(d.merged_30d), sub: `关闭未合并 ${n(d.closed_unmerged_30d)}` },
      { label: '合并时长中位（全部）', value: hours(d.median_time_to_merge_h), sub: `P90 ${hours(d.p90_time_to_merge_h)} · 含 bot 同步 PR` },
      { label: '合并时长中位（人工 PR）', value: hours(d.median_time_to_merge_h_human), sub: d.merged_human_count ? `样本 ${d.merged_human_count} 个非 bot PR` : '暂无非 bot PR 样本' },
    ]);
    const DECISION = { APPROVED: ['已批准', 'good'], CHANGES_REQUESTED: ['需修改', 'bad'], REVIEW_REQUIRED: ['待评审', 'warn'], NONE: ['无评审', ''] };
    const MERGEABLE = { MERGEABLE: ['可合并', 'good'], CONFLICTING: ['有冲突', 'bad'], UNKNOWN: ['计算中', ''] };
    const ciCell = (p) => {
      const checks = p.ci.checks || [];
      const ok = checks.filter((c) => c.conclusion === 'success').length;
      const bad = checks.filter((c) => ['failure', 'timed_out', 'error', 'cancelled', 'startup_failure'].includes(c.conclusion)).length;
      const state = p.ci.state ? conclusionBadge(p.ci.state) : badge('无检查', 'none');
      const list = checks.length ? `<details><summary>${ok}/${checks.length} 通过${bad ? `，${bad} 失败` : ''}</summary><ul class="checks">${checks.map((c) => `<li>${conclusionBadge(c.conclusion)} ${c.url ? link(c.url, esc(c.name)) : esc(c.name)}</li>`).join('')}</ul></details>` : '';
      return `${state}${list}`;
    };
    html += sectionHead('开放 PR');
    html += `<div class="card">${table('pr-open', [
      { key: 'number', label: '#', num: true, render: (p) => link(p.url, `#${p.number}`) },
      { key: 'title', label: '标题', render: (p) => `${link(p.url, esc(p.title))}<div class="sub">${esc(p.author)} · <code>${esc(p.head)}</code> → <code>${esc(p.base)}</code>${p.labels.length ? ' · ' + labelChips(p.labels) : ''}</div>` },
      { key: 'age_days', label: '年龄', num: true, render: (p) => days(p.age_days) },
      { key: 'review_decision', label: '状态', render: (p) => [p.draft ? badge('草稿', 'none') : '', badge(...(DECISION[p.review_decision] || [p.review_decision, ''])), p.mergeable ? badge(...(MERGEABLE[p.mergeable] || [p.mergeable, ''])) : '', p.waiting_review ? badge(`等待评审 ${days(p.age_days)}`, 'warn') : ''].filter(Boolean).join(' ') },
      { key: 'ci', label: 'CI', render: ciCell, sort: (p) => p.ci.state },
      { key: 'requested_reviewers', label: '评审人', render: (p) => (p.requested_reviewers.length ? esc(p.requested_reviewers.join(', ')) : p.reviews.length ? esc([...new Set(p.reviews.map((r) => r.author))].join(', ')) : '<span class="muted">未指定</span>'), sort: (p) => p.requested_reviewers.length },
      { key: 'updated_at', label: '更新', render: (p) => ago(p.updated_at) },
    ], d.items, { emptyText: '当前没有开放 PR' })}</div>`;
    html += `<div class="grid" style="margin-top:12px">
      ${card('评审负载', bars(d.reviewer_load.map((r) => ({ label: r.login, value: r.count })), { emptyText: '开放 PR 没有被指定或提交过评审' }), { sub: '被请求评审 + 已提交评审（开放 PR）' })}
      ${card('PR 作者', bars(d.authors.map((a) => ({ label: a.login, value: a.count }))), { sub: '开放 + 最近关闭' })}
      ${card('评审决定', bars(Object.entries(d.review_decisions).map(([k, v]) => ({ label: (DECISION[k] || [k])[0], value: v }))))}
      ${card('CI 状态', bars(Object.entries(d.ci_states).map(([k, v]) => ({ label: CONCLUSION_NAME[k] || k, value: v }))))}
    </div>`;
    html += sectionHead('最近合并', '按合并时间');
    html += `<div class="card">${table('pr-merged', [
      { key: 'number', label: '#', num: true, render: (p) => link(p.url, `#${p.number}`) },
      { key: 'title', label: '标题', render: (p) => `${link(p.url, esc(p.title))}<div class="sub">${esc(p.author)}</div>` },
      { key: 'merged_at', label: '合并', render: (p) => ago(p.merged_at) },
      { key: 'time_to_merge_h', label: '开到合并', num: true, render: (p) => hours(p.time_to_merge_h) },
    ], d.recent_merged, { limit: 15 })}</div>`;
    return html;
  }

  function renderCI(sec) {
    const d = sec?.data;
    let html = sectionState(sec, 'CI');
    if (!d) return html;
    const rateTone = (r) => (r == null ? '' : r >= 80 ? 'good' : r >= 50 ? 'warn' : 'bad');
    html += tiles([
      { label: `主干 (${d.default_branch}) 成功率`, value: pct(d.main.success_rate), tone: rateTone(d.main.success_rate), sub: `${d.main.success} 成功 / ${d.main.failure} 失败 / ${d.main.cancelled} 取消` },
      { label: 'PR 触发成功率', value: pct(d.pull_request.success_rate), tone: rateTone(d.pull_request.success_rate), sub: `${d.pull_request.success} 成功 / ${d.pull_request.failure} 失败` },
      { label: '主干连续失败', value: n(d.red_streak_main), tone: d.red_streak_main ? 'bad' : 'good', unit: '次' },
      { label: '7 天失败', value: n(d.failures_7d), tone: d.failures_7d ? 'warn' : '' },
      { label: '主干中位耗时', value: dur(d.main.median_duration_s) },
      { label: '采样 run', value: n(d.runs_sampled), sub: `job 明细取最近 ${d.job_history_runs} 次主干 run` },
    ]);
    const L = d.lanes;
    const range = L ? `近 ${L.window_days} 天（${laneDay(L.days[0])}–${laneDay(L.days[L.days.length - 1])}，${esc(L.zone)}）` : '';
    html += `<div class="grid one" style="margin-top:12px">
      ${card('CI 分层历史', ciLanes(L), { sub: `${range} · 各层共用日期轴，每格一次 run，同一天自上而下按时间排列（上早下晚）· 点击打开 run` })}
    </div>`;
    html += `<div class="grid wide" style="margin-top:12px">
      ${card('最近一次主干 run', d.latest_main ? `${kv([
        ['Run', `${link(d.latest_main.run.url, esc(d.latest_main.run.title))} ${conclusionBadge(d.latest_main.run.conclusion)}`],
        ['时间', `${date(d.latest_main.run.created_at)} · ${dur(d.latest_main.run.duration_s)} · ${esc(d.latest_main.run.actor)}`],
      ])}<ul class="checks" style="margin-top:8px">${d.latest_main.jobs.map((j) => `<li>${conclusionBadge(j.conclusion)} ${link(j.url, esc(j.name))} <span class="muted">${dur(j.duration_s)}</span>${j.failed_steps.length ? ` <span class="bad">失败步骤：${esc(j.failed_steps.join('、'))}</span>` : ''}</li>`).join('')}</ul>` : empty('没有主干 run'))}
    </div>`;
    html += sectionHead('Workflow 健康');
    html += `<div class="card">${table('ci-wf', [
      { key: 'name', label: 'Workflow', render: (w) => `${link(w.url, esc(w.name))}<div class="sub"><code>${esc(w.path)}</code> · ${esc(w.state)}</div>` },
      { key: 'all', label: '总体成功率', num: true, render: (w) => `${ratioBar(w.all.success_rate, rateTone(w.all.success_rate))}${pct(w.all.success_rate)} <span class="muted">(${w.all.total})</span>`, sort: (w) => w.all.success_rate },
      { key: 'main', label: '主干', num: true, render: (w) => `${pct(w.main.success_rate)} <span class="muted">(${w.main.total})</span>`, sort: (w) => w.main.success_rate },
      { key: 'pull_request', label: 'PR', num: true, render: (w) => `${pct(w.pull_request.success_rate)} <span class="muted">(${w.pull_request.total})</span>`, sort: (w) => w.pull_request.success_rate },
      { key: 'failures_7d', label: '7 天失败', num: true },
      { key: 'median', label: '中位耗时', num: true, render: (w) => dur(w.all.median_duration_s), sort: (w) => w.all.median_duration_s },
      { key: 'last', label: '最近 run', render: (w) => (w.last_run ? `${conclusionBadge(w.last_run.conclusion || w.last_run.status)} ${link(w.last_run.url, esc(w.last_run.branch))} <span class="muted">${ago(w.last_run.created_at)}</span>` : '—'), sortable: false },
    ], d.workflows)}</div>`;
    html += sectionHead('Job 健康', `最近 ${d.job_history_runs} 次主干 run 的 job 级统计`);
    html += `<div class="card">${table('ci-jobs', [
      { key: 'name', label: 'Job' },
      { key: 'success_rate', label: '成功率', num: true, render: (j) => `${ratioBar(j.success_rate, rateTone(j.success_rate))}${pct(j.success_rate)}` },
      { key: 'runs', label: '次数', num: true, render: (j) => `${j.runs} <span class="muted">(${j.success}✓ ${j.failure}✗ ${j.cancelled}取消)</span>` },
      { key: 'median_duration_s', label: '中位耗时', num: true, render: (j) => dur(j.median_duration_s) },
      { key: 'last', label: '最近', render: (j) => (j.last ? `${conclusionBadge(j.last.conclusion)} ${link(j.last.url, ago(j.last.created_at))}` : '—'), sortable: false },
      { key: 'steps', label: '常失败步骤', render: (j) => (j.top_failed_steps.length ? j.top_failed_steps.map((s) => `${esc(s.step)} ×${s.count}`).join('，') : '<span class="muted">—</span>'), sortable: false },
    ], d.job_health, { emptyText: '没有可统计的 job' })}</div>`;
    const branches = [...new Set(d.recent_runs.map((r) => r.branch))];
    const f = STATE.filters;
    const runs = f.runBranch ? d.recent_runs.filter((r) => r.branch === f.runBranch) : d.recent_runs;
    html += sectionHead('最近 run', `${runs.length} 条`);
    html += `<div class="card"><div class="filters"><select data-filter="runBranch"><option value="">全部分支</option>${branches.map((b) => `<option ${f.runBranch === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></div>${table('ci-runs', [
      { key: 'conclusion', label: '结论', render: (r) => conclusionBadge(r.conclusion || r.status) },
      { key: 'title', label: '标题', render: (r) => `${link(r.url, esc(r.title))}<div class="sub">${esc(r.name)} · <code>${esc(r.sha)}</code> · ${esc(r.actor)}</div>` },
      { key: 'branch', label: '分支', render: (r) => `<code>${esc(r.branch)}</code>` },
      { key: 'event', label: '事件' },
      { key: 'duration_s', label: '耗时', num: true, render: (r) => dur(r.duration_s) },
      { key: 'created_at', label: '时间', render: (r) => ago(r.created_at) },
    ], runs, { limit: 30 })}</div>`;
    return html;
  }

  // Source-tagged tests: the collector evaluates every CI profile on the latest
  // default-branch catalog; this only lays the answer out.
  const PROFILE_NAME = { pr: 'PR', daily: 'Daily', release: 'Release' };
  const SLICE_NAME = { ut: 'UT', st: 'ST', e2e: 'E2E' };
  const TAKE = { yes: ['✓', '选取'], any: ['不限', '不限制该维度'], no: ['✗', '不选'] };
  const tagChip = (tag, muted) => `<span class="tag-chip${muted ? ' muted' : ''}">${esc(tag)}</span>`;
  function taggedSection(t) {
    let html = sectionHead('标签化测试', t ? `默认分支最新 CI 冻结的用例目录 · ${n(t.cases)} 个用例 · ${t.dimensions.length} 个标签维度 · ${n(t.signatures)} 种标签组合` : '');
    if (!t) return html + `<div class="banner warn"><span class="icon">▲</span><div><div class="title">尚未读取到标签化测试目录</div><div>需要源仓 CI 在 ut / st / e2e-results 产物中上传各层的 <code>tagged/catalog.json</code> 与 <code>plan.json</code>；读取到默认分支的一次运行后，这里显示各维度标签、PR / Daily / Release 的组合与覆盖情况。</div></div></div>`;
    const share = (x) => (t.cases ? `${((x / t.cases) * 100).toFixed(1)}%` : '—');
    const runText = (p) => {
      if (!p.run) return '暂无该组合的运行';
      const parts = Object.entries(p.results || {}).filter(([, r]) => r).map(([s, r]) => `${SLICE_NAME[s] || s} ${n(r.passed)}/${n(r.planned)}`);
      return `最近运行 ${shortDate(p.run.created_at)}${parts.length ? ` · 通过 ${parts.join(' · ')}` : ''}`;
    };
    const catalogRun = t.catalog.run;
    const notes = [];
    if (t.catalog.missing.length) notes.push(`目录缺少 ${t.catalog.missing.map((s) => SLICE_NAME[s] || s).join('、')} 层（该层产物未读取到），这些用例不在统计内。`);
    if (!t.schema.known) notes.push('未读取到标签词表：未声明的维度没有补默认值，词表外的标签值也无法列出。');
    const drift = t.checks.filter((c) => c.computed !== c.planned);
    if (drift.length) notes.push(`看板按规则计算的选中数与 CI 冻结计划不一致（${drift.map((c) => `${SLICE_NAME[c.slice] || c.slice}：计划 ${n(c.planned)}，计算 ${c.computed == null ? '无法解析' : n(c.computed)}`).join('；')}），覆盖数字仅供参考。`);
    t.profiles.filter((p) => p.run && p.revisions?.length && t.catalog.revision.length && p.revisions.join() !== t.catalog.revision.join()).forEach((p) => notes.push(`${PROFILE_NAME[p.name]} 的规则取自修订 ${p.revisions.map((r) => r.slice(0, 7)).join('/')}，目录为 ${t.catalog.revision.map((r) => r.slice(0, 7)).join('/')}；覆盖按同一目录计算。`));
    html += `<div class="muted" style="margin:-4px 0 8px">目录来自 ${link(catalogRun.url, `run ${esc(catalogRun.id)}`)}（${esc(catalogRun.branch)} · ${esc(catalogRun.event)} · ${ago(catalogRun.created_at)} · 修订 <code>${esc(t.catalog.revision.map((r) => r.slice(0, 7)).join('/'))}</code>）；各组合的规则取自其最近一次默认分支 / 版本运行的冻结计划。</div>`;
    html += tiles([
      { label: '目录用例', value: n(t.cases), sub: `${t.catalog.slices.map((s) => SLICE_NAME[s] || s).join(' + ')} 三层合并去重` },
      ...t.profiles.map((p) => ({ label: `${PROFILE_NAME[p.name]} 选中`, value: p.covered == null ? '—' : n(p.covered), sub: p.covered == null ? (p.error ? '规则无法解析' : '暂无运行，无法读取组合') : `${share(p.covered)} · ${esc(runText(p))}` })),
      { label: '任一组合覆盖', value: share(t.covered), sub: `${n(t.covered)} / ${n(t.cases)} 个用例`, tone: 'good' },
      { label: '从未覆盖', value: n(t.uncovered.cases), sub: '当前任何组合都不会选中', tone: t.uncovered.cases ? 'warn' : 'good' },
    ]);
    if (notes.length) html += `<ul class="notes">${notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;

    // Dimension × profile matrix: reading down a profile column gives its combination.
    const profiles = t.profiles;
    const head = profiles.map((p) => `<th class="take-col"><div>${esc(PROFILE_NAME[p.name])}</div><div class="sub">${p.same_as ? `与 ${esc(PROFILE_NAME[p.same_as])} 相同` : p.run ? (p.rules ? `${p.rules.length} 条规则` : '含 not，见选择器') : '暂无运行'}</div></th>`).join('');
    const body = t.dimensions.map((dim) => {
      const meta = [dim.multiple ? '可多选' : '单选', dim.vocabulary != null ? `词表 ${dim.vocabulary} 个` : '', `使用 ${dim.used} 个`, dim.default ? `默认 ${dim.default}` : ''].filter(Boolean).join(' · ');
      const group = `<tr class="dim-row"><th colspan="${2 + profiles.length}"><b>${esc(dim.group)}</b> <span class="sub">${esc(meta)}</span></th></tr>`;
      return group + dim.values.map((v) => {
        const miss = v.cases - v.covered;
        const bar = `<span class="tag-bar"${tip(`${dim.group}:${v.value}\n${n(v.cases)} 个用例 · 被任一组合选中 ${n(v.covered)} · 从未覆盖 ${n(miss)}`)}>${v.covered ? `<span class="hit" style="width:${(v.covered / t.cases) * 100}%"></span>` : ''}${miss ? `<span class="miss" style="width:${(miss / t.cases) * 100}%"></span>` : ''}</span>`;
        const takes = profiles.map((p) => {
          const state = v.profiles[p.name];
          if (!p.run) return '<td class="take-col"></td>';
          const [mark, text] = TAKE[state] || ['?', '规则无法展开'];
          return `<td class="take-col"><span class="take ${esc(state || 'unknown')}"${tip(`${PROFILE_NAME[p.name]} ${text} ${dim.group}:${v.value}`)} aria-label="${esc(`${PROFILE_NAME[p.name]} ${text} ${dim.group}:${v.value}`)}">${mark}</span></td>`;
        }).join('');
        return `<tr class="${v.cases ? '' : 'unused'}" data-tag="${esc(`${dim.group}:${v.value}`)}"><td>${tagChip(v.value, !v.cases)}</td><td class="tag-count">${bar}<span class="num">${n(v.cases)}</span>${miss ? ` <span class="miss-text">未覆盖 ${n(miss)}</span>` : ''}</td>${takes}</tr>`;
      }).join('');
    }).join('');
    const ruleText = (p) => {
      if (!p.run) return `${PROFILE_NAME[p.name]}：暂无运行，无法读取组合`;
      if (p.same_as) return `${PROFILE_NAME[p.name]}：与 ${PROFILE_NAME[p.same_as]} 规则相同`;
      if (!p.rules) return `${PROFILE_NAME[p.name]}：${Object.values(p.selectors).join(' ｜ ')}`;
      return `${PROFILE_NAME[p.name]}：${p.rules.map((row) => row.map(([g, vs]) => vs.length > 1 ? `${g} ∈ {${vs.join(', ')}}` : `${g} = ${vs[0]}`).join(' 且 ')).join('；或 ')}（目标 ${p.targets.join('、')}）`;
    };
    html += `<div class="grid one" style="margin-top:12px">${card('每个维度的标签与组合', `<ul class="rule-list">${profiles.map((p) => `<li>${esc(ruleText(p))}</li>`).join('')}</ul>
      <div class="table-wrap"><table class="tag-matrix"><thead><tr><th>标签</th><th>用例数</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
      <div class="legend"><span><i style="background:var(--s1)"></i>被任一组合选中</span><span><i style="background:var(--warning)"></i>从未覆盖</span><span>✓ 组合选取该标签 · 不限 = 组合不约束该维度 · ✗ 不选</span></div>
      <div class="muted" style="margin-top:6px">读法：同一维度内多个 ✓ 是“或”，不同维度之间是“且”。可多选维度（os、arch）上一个用例可带多个值，各值计数之和会大于用例总数；多平台用例只要有一个平台实例被选中即算覆盖。</div>`, { sub: '标签值计数按默认分支目录；组合列来自冻结计划' })}</div>`;

    // Never covered: why, then which cases.
    const reasons = t.uncovered.reasons;
    const items = t.uncovered.items;
    html += `<div class="grid wide" style="margin-top:12px">${card('从未覆盖的用例', reasons.length ? `${bars(reasons.map((r) => ({ label: r.reason, value: r.cases, color: 'var(--warning)' })))}
      <details style="margin-top:8px"><summary>查看用例（${n(t.uncovered.cases)}${items.length < t.uncovered.cases ? `，列出前 ${items.length} 个` : ''}）</summary>${table('tag-uncovered', [
        { key: 'reason', label: '被排除的标签', render: (r) => `<span class="nowrap">${esc(r.reason)}</span>` },
        { key: 'id', label: '用例', render: (r) => `<span class="mono case-id" title="${esc(r.id)}">${esc(r.id)}</span>` },
      ], items)}</details>` : empty('所有用例都至少被一个组合选中'), { sub: '按挡住它的标签归类：该标签值不在任何组合里' })}
      ${card('标签组合', table('tag-combos', [
        { key: 'cases', label: '用例', num: true },
        { key: 'tags', label: '标签（灰色为默认值）', sortable: false, render: (c) => c.tags.map((tag) => { const [g, v] = tag.split(':'); const dim = t.dimensions.find((x) => x.group === g); return tagChip(tag, dim?.default === v); }).join(' ') },
        ...profiles.map((p) => ({ key: p.name, label: PROFILE_NAME[p.name], sortable: false, render: (c) => c.profiles[p.name] == null ? '<span class="muted">—</span>' : c.profiles[p.name] ? '<span class="take yes">✓</span>' : '<span class="take no">✗</span>' })),
      ], t.combinations, { limit: 40 }), { sub: '标签完全相同的用例被组合选中的方式也相同' })}</div>`;
    return html;
  }

  function renderTests(sec) {
    const d = sec?.data;
    let html = sectionState(sec, '测试');
    if (!d) return html;
    const tree = d.tree;
    const ut = d.executed.find((e) => e.artifact.startsWith('ut'));
    const e2e = d.executed.find((e) => e.layer === 'e2e');
    const cov = d.coverage;
    html += tiles([
      { label: '测试文件（仓库树）', value: n(tree?.total), sub: tree ? `来源 ${esc(d.tree_source)}` : '文件树不可用' },
      { label: '有测试的包', value: tree ? `${d.inventory.filter((p) => p.tested).length}<small>/ ${d.inventory.length}</small>` : '—', tone: d.inventory.some((p) => !p.tested) ? 'warn' : 'good' },
      { label: 'CI 最近 UT 用例', value: n(ut?.totals?.tests), sub: ut?.totals ? `${ut.totals.passed} 通过 · ${ut.totals.failed} 失败 · ${ut.totals.skipped} 跳过` : ut ? '产物存在但没有解析出用例数' : '无产物', tone: ut?.totals?.failed ? 'bad' : ut?.totals ? 'good' : '' },
      { label: 'CI 最近 E2E 用例', value: n(e2e?.totals?.tests), sub: e2e?.totals ? `${e2e.totals.passed} 通过 · ${e2e.totals.failed} 失败/超时 · ${e2e.totals.skipped} 跳过 · ${e2e.totals.flaky} 重试通过` : e2e ? '产物存在但没有解析出用例数' : '无产物', tone: e2e?.totals?.failed ? 'bad' : e2e?.totals ? 'good' : '' },
      { label: '行覆盖率', value: cov?.value?.lines_pct != null ? pct(cov.value.lines_pct) : '无数据源', tone: cov?.source ? 'good' : 'warn', sub: cov?.source ? esc(cov.source) : '见下方数据源探测与降级视图' },
    ]);
    html += taggedSection(d.tagged);

    // Distribution ----------------------------------------------------------
    if (tree) {
      const layerSegs = Object.entries(tree.by_layer).map(([k, v]) => ({ name: LAYER_NAME[k] || k, value: v, color: LAYER_COLOR[k] || 'var(--muted)' }));
      const pkgs = tree.by_package.slice(0, 20).map((p) => ({ label: p.package, value: p.files, segments: Object.entries(p.layers).map(([k, v]) => ({ name: LAYER_NAME[k] || k, value: v, color: LAYER_COLOR[k] })) }));
      html += `<div class="grid wide" style="margin-top:12px">
        ${card('按层分布', stack(layerSegs) + legend(layerSegs) + `<div style="margin-top:10px">${bars(Object.entries(tree.by_language).map(([k, v]) => ({ label: k, value: v })))}</div>`, { sub: '测试文件数；下方按语言' })}
        ${card('按包 / 目录分布', bars(pkgs) + legend(layerSegs.map((s) => ({ name: s.name, color: s.color }))), { sub: `前 ${pkgs.length} 个，颜色为层` })}
      </div>`;
    }

    // Executed ------------------------------------------------------------
    html += sectionHead('CI 最近执行结果', `来自 Actions 产物 ${esc((snapConfig().artifact_names || []).join(', '))}`);
    if (!d.executed.length) html += `<div class="banner warn"><span class="icon">▲</span><div><div class="title">没有可解析的测试产物</div><div>本次采集范围内没有可用的 ${esc((snapConfig().artifact_names || []).join('/'))}。</div></div></div>`;
    const executedCards = d.executed.map((e) => {
      const t = e.totals || {};
      const head = kv([
        ['层 / 状态', `${badge(e.layer, 'info')} ${badge(e.status === 'incomplete' ? '不完整' : e.status || '未知', e.status === 'passed' ? 'good' : e.status === 'failed' ? 'bad' : e.status === 'incomplete' ? 'warn' : '')}${e.note ? ` <span class="muted">${esc(e.note)}</span>` : ''}`],
        ['来源', `${e.branch ? `<code>${esc(e.branch)}</code>` : ''} · run ${e.run_id ? link(`${STATE.snap.repo_url}/actions/runs/${e.run_id}`, e.run_id) : '—'} · ${ago(e.created_at)}`],
        ['用例', `${n(t.tests)} ${e.detail?.unit || ''} · <span class="ok">${n(t.passed)} 通过</span> · <span class="${t.failed ? 'bad' : ''}">${n(t.failed)} 失败</span> · ${n(t.skipped)} 跳过 · ${n(t.flaky)} 重试通过 · attempt ${e.attempt} · ${esc((e.sha || '').slice(0,12))}`],
      ]);
      let body = '';
      if (e.detail?.commands) {
        body += `<details open><summary>按命令 / 层（${e.detail.commands.length}）</summary>${table(`t-cmd-${e.artifact}`, [
          { key: 'label', label: '脚本', render: (c) => `<code>${esc(c.label)}</code><div class="sub mono">${esc(c.command)}</div>` },
          { key: 'framework', label: '框架' },
          { key: 'tests', label: '用例', num: true }, { key: 'passed', label: '通过', num: true },
          { key: 'failed', label: '失败', num: true, render: (c) => (c.failed ? `<span class="bad">${c.failed}</span>` : '0') }, { key: 'skipped', label: '跳过', num: true },
        ], e.detail.commands)}</details>`;
        body += `<details><summary>按包（${e.detail.packages.length}）</summary>${table(`t-pkg-${e.artifact}`, [
          { key: 'package', label: '包', render: (p) => `<code>${esc(p.package)}</code>` },
          { key: 'tests', label: '用例', num: true }, { key: 'passed', label: '通过', num: true },
          { key: 'failed', label: '失败', num: true, render: (p) => (p.failed ? `<span class="bad">${p.failed}</span>` : '0') }, { key: 'skipped', label: '跳过', num: true },
        ], e.detail.packages, { defaultSort: { key: 'tests', dir: 'desc' } })}</details>`;
      }
      if (e.detail?.files) {
        const st = e.detail.stats || {};
        body += `<div class="muted" style="margin:6px 0">测试项目 ${esc((e.detail.projects || []).join(', ') || '未提供')} · 通过 ${n(st.expected)} · 失败 ${n(st.unexpected)} · 重试通过 ${n(st.flaky)}</div>`;
        if (e.detail.failures.length) body += `<details open><summary class="bad">失败 / 超时用例（${e.detail.failures.length}）</summary><ul class="checks">${e.detail.failures.map((f) => `<li>${conclusionBadge(f.status === 'timedOut' ? 'timed_out' : 'failure')} <code>${esc(f.file)}</code> ${esc(f.title)}${f.error ? `<details><summary>错误</summary><pre class="mono" style="white-space:pre-wrap">${esc(f.error)}</pre></details>` : ''}</li>`).join('')}</ul></details>`;
        body += `<details><summary>按测试文件（${e.detail.files.length}）</summary>${table(`t-e2e-${e.artifact}`, [
          { key: 'file', label: '测试文件', render: (f) => `<code>${esc(f.file)}</code>` },
          { key: 'specs', label: '用例', num: true }, { key: 'passed', label: '通过', num: true },
          { key: 'failed', label: '失败', num: true, render: (f) => (f.failed + f.timedOut ? `<span class="bad">${f.failed + f.timedOut}</span>` : '0'), sort: (f) => f.failed + f.timedOut },
          { key: 'skipped', label: '跳过', num: true }, { key: 'flaky', label: '重试通过', num: true },
        ], e.detail.files)}</details>`;
      }
      if (e.detail?.outcomes) {
        body += `<details open><summary>命令结果（${e.detail.outcomes.length}）</summary><ul class="checks">${e.detail.outcomes.map((o) => `<li>${conclusionBadge(o.exit_code === 0 ? 'success' : 'failure')} <code>${esc(o.command)}</code> <span class="muted">${dur(o.duration_ms == null ? null : o.duration_ms / 1000)}</span></li>`).join('')}</ul></details>`;
      }
      if (e.detail?.junit) body += `<details open><summary>JUnit suites</summary><ul class="checks">${e.detail.junit.map((j) => `<li><code>${esc(j.file)}</code> ${n(j.totals.tests)} 用例 · ${n(j.totals.failed)} 失败</li>`).join('')}</ul></details>`;
      return { name: e.artifact, head, body };
    });
    // Summary cards side by side; drill-down tables get the full width below so commands are readable.
    html += `<div class="grid wide">${executedCards.map((c) => card(c.name, c.head)).join('')}</div>`;
    html += `<div class="grid one" style="margin-top:12px">${executedCards.filter((c) => c.body).map((c) => card(`${c.name} · 明细`, c.body)).join('')}</div>`;

    // Coverage ------------------------------------------------------------
    html += sectionHead('覆盖率', cov?.source ? `来源 ${esc(cov.source)}` : '报告覆盖率与测试文件分布分别展示');
    const steps = `<ul class="steps">${(cov?.attempts || []).map((a) => `<li><span class="mark ${a.ok ? 'ok' : 'no'}">${a.ok ? '✓' : '✗'}</span><span><b>${esc(a.step)}</b> <span class="muted">${esc(a.detail)}</span></span></li>`).join('')}</ul>`;
      const covLabels = {
      lines_pct: '行覆盖率', branches_pct: '分支覆盖率', functions_pct: '函数覆盖率', statements_pct: '语句覆盖率',
      lines_hit: '已覆盖行', lines_found: '总行数', branches_hit: '已覆盖分支', branches_found: '总分支数',
      functions_hit: '已覆盖函数', functions_found: '总函数数', file: '文件', summary: '摘要', url: '链接',
    };
    const covValue = cov?.value ? kv(Object.entries(cov.value).filter(([k, v]) => k !== 'format' && v != null).map(([k, v]) => [
      covLabels[k] || k,
      typeof v === 'number' ? (k.endsWith('_pct') ? pct(v) : n(v)) : esc(String(v)),
    ])) : '';
      const gap = cov && !cov.source ? `<div class="banner warn" style="margin:10px 0 0"><span class="icon">▲</span><div><div class="title">该仓库目前没有任何行覆盖率数据源</div><div>最近的 Actions 产物中没有可解析的 lcov / coverage-summary，也未从 Codecov 或 check-run 找到覆盖率。下方用「结构代理」降级：每个包的源文件数、测试文件数、比值，以及 CI 最近一次实际执行的用例数。它衡量的是「有没有测、测了多少」，<b>不是</b>行覆盖率。</div><div class="hint">补齐方式：让 CI 上传名称含 <code>coverage</code>、<code>lcov</code> 或 <code>codecov</code> 的 Actions 产物，并在其中提供 <code>lcov.info</code>、<code>coverage-summary.json</code>、Cobertura 或 Clover XML；看板会自动识别。</div></div></div>` : '';
    html += `<div class="card">${steps}${covValue}${gap}</div>`;
    html += `<div class="card" style="margin-top:12px"><h3>按包的测试文件与 CI 用例<span class="sub">源文件数不含测试与 .d.ts；CI 用例只显示可映射到包的报告数量</span></h3>${table('t-inv', [
      { key: 'package', label: '包', render: (p) => `<code>${esc(p.package)}</code>` },
      { key: 'tested', label: '状态', render: (p) => (p.tested ? badge('有测试', 'good') : badge('无测试', 'bad')), sort: (p) => (p.tested ? 1 : 0) },
      { key: 'source_files', label: '源文件', num: true },
      { key: 'test_files', label: '测试文件', num: true },
      { key: 'ratio', label: '测试/源 比', num: true, render: (p) => (p.ratio == null ? '—' : `${ratioBar(Math.min(p.ratio, 1) * 100, p.ratio >= 0.5 ? 'good' : p.ratio > 0 ? 'warn' : 'bad')}${p.ratio.toFixed(2)}`) },
      { key: 'ci_cases', label: 'CI 用例', num: true, render: (p) => (p.ci_cases == null ? '<span class="muted">—</span>' : `${n(p.ci_cases)}${p.ci_failed ? ` <span class="bad">(${p.ci_failed} 失败)</span>` : ''}`) },
      { key: 'layers', label: '层', render: (p) => Object.entries(p.layers).map(([k, v]) => `${k} ${v}`).join(' · '), sortable: false },
    ], d.inventory, { defaultSort: { key: 'ratio', dir: 'asc' } })}</div>`;
    if (Object.keys(d.test_scripts || {}).length) html += `<div class="card" style="margin-top:12px"><h3>根 package.json 测试脚本</h3>${kv(Object.entries(d.test_scripts).map(([k, v]) => [k, `<code>${esc(v)}</code>`]))}</div>`;
    return html;
  }

  function renderCoverage(sec) {
    const d = sec?.data;
    let html = sectionState(sec, 'Coverage');
    if (!d) return html;
    const cov = d.coverage || {};
    if (!cov.source) {
      const steps = `<ul class="steps">${(cov.attempts || []).map((a) => `<li><span class="mark ${a.ok ? 'ok' : 'no'}">${a.ok ? '✓' : '✗'}</span><span><b>${esc(a.step)}</b> <span class="muted">${esc(a.detail)}</span></span></li>`).join('')}</ul>`;
      return html + sectionHead('Coverage', '尚无可解析的覆盖率产物')
        + `<div class="banner warn"><span class="icon">▲</span><div><div class="title">等待 ScienceDiscovery 覆盖率工作流首次发布摘要</div><div>每日完整基线成功后，这里会显示整仓趋势和路径明细；PR 与 main 增量随后自动叠加。</div></div></div><div class="card" style="margin-top:12px">${steps}</div>`;
    }
    const languages = cov.languages || {};
    if (!Object.keys(languages).length) {
      const labels = { lines_pct: '行覆盖率', branches_pct: '分支覆盖率', functions_pct: '函数覆盖率', statements_pct: '语句覆盖率' };
      const rows = Object.entries(cov.value || {}).filter(([key, value]) => key !== 'format' && value != null)
        .map(([key, value]) => [labels[key] || key, typeof value === 'number' && key.endsWith('_pct') ? pct(value) : esc(String(value))]);
      return html + sectionHead('Coverage', `来源 ${esc(cov.source)}`) + `<div class="card">${kv(rows)}</div>`;
    }

    const overall = cov.current?.totals || {};
    const overallKind = cov.current?.kind === 'authoritative' ? '权威完整结果' : cov.current?.kind === 'incremental' ? '增量估算' : '部分结果';
    html += sectionHead('Coverage', `${overallKind} · Node.js 与 Python 分开采集，整仓行/分支按计数合并`);
    html += tiles([
      { label: '整仓行覆盖率', value: pct(overall.lines?.percentage), tone: 'good', sub: `${n(overall.lines?.covered)} / ${n(overall.lines?.total)}` },
      { label: '整仓分支覆盖率', value: pct(overall.branches?.percentage), sub: `${n(overall.branches?.covered)} / ${n(overall.branches?.total)}` },
      { label: '数据集', value: Object.keys(languages).length, tone: Object.keys(languages).length === 2 ? 'good' : 'warn', sub: Object.keys(languages).map((key) => key === 'node' ? 'Node.js' : 'Python').join(' + ') },
    ]);

    const selectedRange = coverageRange(languages);
    if (selectedRange) {
      html += `<div class="coverage-week-toolbar" aria-label="覆盖率趋势时间范围">
        <button class="btn small" data-coverage-week="older"${STATE.coverageWeekOffset >= selectedRange.maxOffset ? ' disabled' : ''}>‹ 上一周</button>
        <strong>${selectedRange.recent ? '最新 · ' : ''}${dayLabel(selectedRange.start)}–${dayLabel(selectedRange.end)}</strong>
        <button class="btn small" data-coverage-week="newer"${STATE.coverageWeekOffset === 0 ? ' disabled' : ''}>下一周 ›</button>
        <button class="btn small" data-coverage-week="latest"${STATE.coverageWeekOffset === 0 ? ' disabled' : ''}>最新</button>
      </div>`;
    }

    const query = (STATE.filters.coverageQ || '').trim().toLowerCase();
    const renderLanguage = (key, label) => {
      const dataset = languages[key];
      if (!dataset) return sectionHead(label, '没有可用摘要') + `<div class="card">${empty('尚未读取到该语言的覆盖率 artifact')}</div>`;
      const current = dataset.current || {};
      const baseline = dataset.baseline;
      const totals = current.totals || baseline?.totals || {};
      const kind = current.kind === 'authoritative' ? '权威完整结果' : current.kind === 'incremental' ? '增量估算' : '部分结果';
      const tone = current.kind === 'authoritative' ? 'good' : 'warn';
      const metricTiles = [
        { label: `${label} 行覆盖率`, value: pct(totals.lines?.percentage), tone: 'good', sub: `${n(totals.lines?.covered)} / ${n(totals.lines?.total)}` },
        { label: `${label} 分支覆盖率`, value: pct(totals.branches?.percentage), sub: `${n(totals.branches?.covered)} / ${n(totals.branches?.total)}` },
      ];
      if (key === 'node') metricTiles.push({ label: `${label} 函数覆盖率`, value: pct(totals.functions?.percentage), sub: `${n(totals.functions?.covered)} / ${n(totals.functions?.total)}` });
      let body = sectionHead(label, dataset.scope || dataset.source);
      if (current.kind !== 'authoritative') {
        body += `<div class="banner warn"><span class="icon">≈</span><div><div class="title">${esc(label)} 当前不是独立完整基线</div><div>${baseline ? `以 ${date(baseline.created_at)} 的完整结果为基线，叠加 ${(current.increments || []).length} 次 main 增量。` : '当前只拿到部分模块摘要；整仓结果会在完整运行后校准。'}</div></div></div>`;
      }
      body += tiles(metricTiles);
      const history = (dataset.history || []).filter((row) => row.totals?.lines?.percentage != null);
      body += `<div class="grid wide" style="margin-top:12px">
        ${card(`${label} 每日完整行覆盖率`, history.length ? coverageTrend(history, selectedRange?.start) : empty('下一次完整运行后会形成趋势'), { sub: '默认展示最新数据窗口；历史按自然周查看。每天取北京时间最后一个成功的 main push / nightly 完整结果；不混入 PR 结果' })}
        ${card(`${label} 数据身份`, kv([
          ['当前', `${badge(kind, tone)} ${esc(dataset.source)}`],
          ['完整基线', baseline ? `${date(baseline.created_at)} · <code>${esc((baseline.sha || '').slice(0, 12))}</code>` : '尚无'],
          ['main 增量', `${n(current.increments?.length || 0)} 次`],
          ['路径数', n(current.groups?.length || baseline?.groups?.length)],
        ]))}
      </div>`;
      const groupRows = (current.groups || baseline?.groups || []).map((group) => ({
        ...group,
        lines_pct: group.totals?.lines?.percentage,
        branches_pct: group.totals?.branches?.percentage,
        functions_pct: group.totals?.functions?.percentage,
      })).filter((group) => !query || group.name.toLowerCase().includes(query));
      const columns = [
        { key: 'name', label: '路径', render: (row) => `<code>${esc(row.name)}</code>${row.update_kind === 'main increment' ? ` ${badge('main 增量', 'warn')}` : ''}<div class="sub"><code>${esc((row.source_sha || '').slice(0, 10))}</code> · ${ago(row.updated_at)}</div>` },
        { key: 'lines_pct', label: '行', num: true, render: (row) => pct(row.lines_pct) },
        { key: 'branches_pct', label: '分支', num: true, render: (row) => pct(row.branches_pct) },
      ];
      if (key === 'node') columns.push({ key: 'functions_pct', label: '函数', num: true, render: (row) => pct(row.functions_pct) });
      columns.push({ key: 'files', label: '源文件', num: true });
      body += sectionHead(`${label} 路径覆盖率`, '可按路径过滤');
      body += `<div class="card"><label class="filter"><span>过滤路径</span><input type="search" data-filter="coverageQ" value="${esc(STATE.filters.coverageQ || '')}" placeholder="packages/schema 或 services/evolve"></label>${table(`cov-groups-${key}`, columns, groupRows, { defaultSort: { key: 'lines_pct', dir: 'asc' }, emptyText: '没有匹配的覆盖率路径' })}</div>`;
      const prs = (dataset.pull_requests || []).map((row) => ({
        ...row,
        lines_pct: row.totals?.lines?.percentage,
        group_names: (row.groups || []).map((group) => group.name).join(', '),
      }));
      body += sectionHead(`${label} 最近 PR 覆盖率`, '该 PR 的 UT/ST 门禁实测范围；不会更新 main 当前覆盖率');
      body += `<div class="card">${table(`cov-prs-${key}`, [
        { key: 'number', label: 'PR', render: (row) => link(`${STATE.snap.repo_url}/pull/${row.number}`, `#${row.number}`) },
        { key: 'branch', label: '分支', render: (row) => `<code>${esc(row.branch || '—')}</code>` },
        { key: 'lines_pct', label: '门禁实测行覆盖率', num: true, render: (row) => pct(row.lines_pct) },
        { key: 'group_names', label: '覆盖路径', render: (row) => `<span class="mono">${esc(row.group_names)}</span>` },
        { key: 'created_at', label: '时间', render: (row) => ago(row.created_at) },
      ], prs, { limit: 10, emptyText: '还没有 PR 覆盖率摘要' })}</div>`;
      return body;
    };
    html += renderLanguage('node', 'Node.js');
    html += renderLanguage('python', 'Python');
    return html;
  }

  function renderOps(sec) {
    const d = sec?.data;
    let html = sectionState(sec, '运维');
    if (!d) return html;
    const cards = [];
    // Releases
    const r = d.releases;
    cards.push(card('Release / Tag', r ? kv([
      ['最新', r.latest ? `${link(r.latest.url, esc(r.latest.tag))} ${r.latest.prerelease ? badge('预发布', 'warn') : ''} <span class="muted">${ago(r.latest.published_at)} · ${esc(r.latest.author)}</span>` : '无 release'],
      ['未发布提交', r.unreleased ? `${link(r.unreleased.url, n(r.unreleased.commits))} 个提交，${n(r.unreleased.files_changed)} 个文件` : '—'],
      ['发布节奏', r.cadence_days != null ? `平均 ${r.cadence_days} 天一次（${r.count} 个 release）` : `${r.count} 个 release，不足以计算节奏`],
      ['资产下载', n(r.total_downloads)],
      ['Tags', r.tags.map((t) => `<code>${esc(t.name)}</code>`).join(' ') || '—'],
    ]) + (r.items.length > 1 ? `<details><summary>全部 release</summary><ul class="checks">${r.items.map((x) => `<li>${link(x.url, esc(x.tag))} <span class="muted">${ago(x.published_at)} · 资产 ${x.assets.length}</span></li>`).join('')}</ul></details>` : '') : empty('Release 数据不可用')));
    // Branches
    const b = d.branches;
    cards.push(card('分支与保护', b ? `${kv([
      ['默认分支', `<code>${esc(b.default)}</code>`],
      ['分支保护', b.protection?.enabled ? badge('已启用', 'good') + (b.protection.readable === false ? ' <span class="muted">规则详情需 admin 权限</span>' : ` 需 ${b.protection.required_reviews ?? 0} 个批准 · 必需检查 ${(b.protection.required_checks || []).map(esc).join(', ') || '无'}`) : badge('未启用', 'bad') + ' <span class="muted">分支列表 protected=false</span>'],
      ['Rulesets', b.rulesets ? (b.rulesets.length ? b.rulesets.map((x) => `${esc(x.name)} (${esc(x.enforcement)})`).join('，') : '无') : '不可读'],
    ])}${table('ops-br', [
      { key: 'name', label: '分支', render: (x) => `<code>${esc(x.name)}</code>${x.is_default ? ' ' + badge('默认', 'info') : ''}${x.protected ? ' ' + badge('保护', 'good') : ''}` },
      { key: 'ahead', label: '领先', num: true, render: (x) => n(x.ahead) },
      { key: 'behind', label: '落后', num: true, render: (x) => (x.behind == null ? '—' : x.behind >= 100 ? `<span class="bad">${n(x.behind)}</span>` : n(x.behind)) },
      { key: 'idle_days', label: '最近提交', render: (x) => (x.is_default ? '—' : x.last_commit_at ? ago(x.last_commit_at) : '—') },
    ], b.items, { defaultSort: { key: 'behind', dir: 'desc' } })}` : empty('分支数据不可用'), { sub: `${b?.count ?? 0} 个分支` }));
    cards.push(card('安全', `${link(STATE.snap.repo_url+'/security', '在 GitHub 查看安全告警 ↗')}<p class="muted">私有告警由 GitHub 权限控制；此公开站点只列出已公开的安全公告。</p>${d.public_advisories?.length ? '<ul class="checks">'+d.public_advisories.map(a=>'<li>'+badge(a.severity||'未知')+' '+link(a.url,esc(a.summary))+'</li>').join('')+'</ul>' : empty(d.public_advisories ? '没有已公开的安全公告' : '公开安全公告暂不可读取')}`));
    // Community
    const c = d.community;
    cards.push(card('社区健康度', c ? `<div class="tile" style="display:inline-block;margin-bottom:8px"><div class="label">GitHub community profile</div><div class="value">${pct(c.health_percentage)}</div></div><ul class="checks" style="font-size:13px">${Object.entries(c.files).filter(([k]) => k !== 'code_of_conduct_file').map(([k, v]) => `<li>${badge(v ? '有' : '缺', v ? 'good' : 'bad')} ${esc(k)}</li>`).join('')}</ul>` : empty('不可用')));
    // Contributors
    const ct = d.contributors;
    cards.push(card('贡献者', ct ? `${kv([['贡献者数', n(ct.count)], ['提交总数', n(ct.total_commits)], ['前 50% 提交由', `${ct.bus_factor_50} 人完成 ${ct.bus_factor_50 === 1 ? badge('集中度高', 'warn') : ''}`]])}<div style="margin-top:8px">${bars(ct.top.map((x) => ({ label: x.login, value: x.contributions, valueText: `${n(x.contributions)} (${x.share}%)` })))}</div>` : empty('不可用'), { sub: '按提交数' }));
    // Activity
    const a = d.activity;
    cards.push(card('提交活跃度', `${a ? `${sparkline(a.weeks.map((w) => w.total), a.weeks.map((w) => new Date(w.week * 1000).toLocaleDateString('zh-CN')))}${kv([['近 4 周', `${n(a.commits_4w)} 次提交`], ['近 52 周', `${n(a.commits_52w)} 次提交`], ['近 7 天（默认分支）', `${n(d.commits_7d)} 次`]])}` : '<div class="muted">周统计暂不可读取</div>'}<details style="margin-top:6px"><summary>最近提交（${d.recent_commits.length}）</summary><ul class="checks">${d.recent_commits.slice(0, 15).map((x) => `<li><code>${link(x.url, esc(x.sha))}</code> ${esc(x.message)} <span class="muted">${esc(x.author)} · ${ago(x.date)}</span></li>`).join('')}</ul></details>`, { sub: '近 26 周，每周提交数' }));
    cards.push(card('流量与克隆', link(STATE.snap.repo_url+'/graphs/traffic', '在 GitHub Insights 查看流量 ↗')+'<p class="muted">访问量、独立访客和克隆统计由 GitHub 对有权限的成员提供，不写入公开快照。</p>'));
    // Stale automation & hygiene
    const iss = STATE.snap.sections.issues?.data, prs = STATE.snap.sections.prs?.data;
    cards.push(card('陈旧治理', kv([
      ['stale 自动化', d.stale_automation.workflow ? `${badge('已配置', 'good')} <code>${esc(d.stale_automation.workflow)}</code>` : `${badge('未配置', 'warn')} <span class="muted">没有 workflow 使用 actions/stale</span>`],
      ['陈旧 Issue', iss ? `${n(iss.stale_count)} 个 ≥${iss.stale_days_threshold} 天无更新，${n(iss.no_response_count)} 个零回复` : '—'],
      ['闲置 PR', prs ? `${prs.items.filter((p) => (p.idle_days || 0) >= (STATE.snap.config.pr_idle_days || 14)).length} 个 ≥14 天无更新` : '—'],
      ['陈旧分支', b ? (b.stale.length ? b.stale.map((x) => `<code>${esc(x.name)}</code>`).join(' ') : '无') : '—'],
    ])));
    html += `<div class="grid wide" style="margin-top:12px">${cards.join('')}</div>`;
    return html;
  }

  const snapConfig = () => STATE.snap?.config || {};

  // ------------------------------------------------------------ shell
  function renderShell() {
    const snap=STATE.snap, btn=$('#refresh-btn'), banner=$('#global-banner');
    document.body.classList.toggle('board-page', STATE.tab === 'board');
    btn.disabled=!!STATE.status?.refreshing;
    btn.textContent=btn.disabled?'读取中…':'刷新视图';
    if(snap){
      $('#repo-link').textContent=snap.repo;$('#repo-link').href=snap.repo_url;
      const label=snap.deployment?.label;
      $('.brand-title').textContent=label ? label+' · GitHub 状态看板' : 'GitHub 状态看板';
      document.title=snap.repo+' · '+$('.brand-title').textContent;
      $('#meta').textContent=date(snap.generated_at);
      $('#meta').dateTime=snap.generated_at;
      $('#meta').title='按浏览器时区显示';
      $('#repo-link').title=snap.repo;
    }
    const stale=snap && Date.now()-new Date(snap.generated_at)>7200000;
    const message=STATE.clientError || [...(snap?.notices||[]).map(n=>n.message).filter(message=>message !== '部分补充信息不可读取，请以 GitHub 原页面为准。'), ...(stale?['快照超过两小时未更新；当前显示最后一次发布的数据。']:[])].join(' ');
    banner.className='banner '+(message?'warn':'hidden');banner.textContent=message;
    document.querySelectorAll('#tabs a').forEach(a=>{
      const active=a.dataset.tab===STATE.tab;a.classList.toggle('active',active);
      if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');
    });
  }

  function renderTabs() {
    const snap = STATE.snap;
    const render = (id, fn) => { const el = $(`#tab-${id}`); if (el) el.innerHTML = fn(); };
    if (!snap) {
      ['overview', 'board', 'issues', 'prs', 'ci', 'tests', 'coverage', 'ops'].forEach((id) => render(id, () => `<div class="skeleton">${STATE.status?.refreshing ? '<span class="spinner"></span>采集中…' : '暂无数据'}</div>`));
      return;
    }
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${STATE.tab}`));
    // One tab's render bug must not blank the others: each tab is isolated and shows its own error.
    const safe = (id, fn) => { try { render(id, fn); } catch (err) { console.error(err); render(id, () => `<div class="banner error"><span class="icon">⛔</span><div><div class="title">该标签页渲染出错</div><div class="mono">${esc(err && err.stack ? err.stack.split('\n').slice(0, 2).join(' | ') : String(err))}</div><div class="hint">其他标签页不受影响；请把这行反馈给维护者。</div></div></div>`); } };
    safe('overview', () => renderOverview(snap));
    safe('issues', () => renderIssues(snap.sections.issues));
    safe('prs', () => renderPRs(snap.sections.prs));
    const lanes = $('#tab-ci .ci-lanes-scroll');
    const lanesKeep = lanes?.dataset.away ? lanes.scrollLeft : null;
    safe('ci', () => renderCI(snap.sections.ci));
    pinLanes(lanesKeep);
    safe('tests', () => renderTests(snap.sections.tests));
    safe('coverage', () => renderCoverage(snap.sections.tests));
    safe('ops', () => renderOps(snap.sections.ops));
    window.GSBQuality?.render();
    window.GSBHistory?.render();
    try { if (window.GSBBoard) window.GSBBoard.onSnapshot(snap); } catch (err) { console.error(err); }
  }

  function renderAll() { renderShell(); renderTabs(); }

  // ------------------------------------------------------------ data flow
  // Every request has a hard timeout and every code path ends in schedulePoll(), so a hung
  // request, a proxy that drops a response, or a render exception can never freeze the page
  // in the "采集中" state: the worst case is a visible error banner plus a retry a few seconds later.
  const FETCH_TIMEOUT_MS = 20000;
  async function fetchJson(url, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { cache: 'no-store', ...opts, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
  async function load() {
    try {
      const doc = await fetchJson('./data/snapshot.json?ts='+Date.now());
      if(!doc.sections || !doc.board)throw new Error('快照格式尚未更新，请稍后刷新');
      STATE.snap=doc;STATE.status={refreshing:false};
      window.GSBQuality?.setSnapshot(doc);
      window.GSBHistory?.setSnapshot(doc);
      window.GSBLocalBoard?.setSnapshot(doc);
      STATE.clientError = null;
    } catch (err) {
      STATE.clientError = err.name === 'AbortError'
        ? `读取静态快照超时（${FETCH_TIMEOUT_MS / 1000} 秒），已保留当前数据`
        : `无法读取快照：${err.message}，已保留当前数据`;
      STATE.status = { ...(STATE.status || {}), refreshing: false };
    }
    try {
      renderAll();
    } catch (err) {
      showRenderError(err);
    }
    schedulePoll();
  }
  function schedulePoll() {
    clearTimeout(STATE.pollTimer);
    const st = STATE.status || {};
    // Quick retry after a client-side failure; 3s while a refresh runs; otherwise 60s to pick up auto refreshes.
    const delay = STATE.clientError ? 5000 : st.refreshing ? 3000 : 60000;
    STATE.pollTimer = setTimeout(load, delay);
  }
  async function refresh() {
    if(STATE.status?.refreshing)return;
    STATE.status={refreshing:true};renderShell();
    await load();
  }
  function showRenderError(err) {
    const banner = $('#global-banner');
    const where = err && err.stack ? esc(err.stack.split('\n').slice(0, 3).join(' | ')) : esc(String(err));
    banner.className = 'banner error';
    banner.innerHTML = `<span class="icon">⛔</span><div><div class="title">页面渲染出错：数据已经拿到，但前端脚本在渲染时抛出异常</div><div class="mono">${where}</div><div class="hint">请把上面这行反馈给维护者；轮询仍在继续，点击「刷新」可重试。</div></div>`;
    console.error(err);
  }
  // ------------------------------------------------------------ events
  document.addEventListener('click', (ev) => {
    const coverageWeekButton = ev.target.closest('[data-coverage-week]');
    if (coverageWeekButton && !coverageWeekButton.disabled) {
      const direction = coverageWeekButton.dataset.coverageWeek;
      if (direction === 'older') STATE.coverageWeekOffset += 1;
      if (direction === 'newer') STATE.coverageWeekOffset = Math.max(0, STATE.coverageWeekOffset - 1);
      if (direction === 'latest') STATE.coverageWeekOffset = 0;
      renderTabs();
      return;
    }
    const th = ev.target.closest('th.sortable[data-table]');
    if (th) {
      const id = th.dataset.table, key = th.dataset.key;
      const cur = STATE.sort[id];
      STATE.sort[id] = cur && cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' };
      renderTabs();
      return;
    }
    const act = ev.target.closest('[data-action="refresh"]');
    if (act) { ev.preventDefault(); refresh(); }
  });
  document.addEventListener('input', (ev) => {
    const el = ev.target.closest('[data-filter]');
    if (!el) return;
    STATE.filters[el.dataset.filter] = el.value;
    const focusSel = `[data-filter="${el.dataset.filter}"]`;
    const pos = el.selectionStart;
    renderTabs();
    const again = document.querySelector(focusSel);
    if (again && again.tagName === 'INPUT') { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) { /* select elements */ } }
  });
  $('#refresh-btn').addEventListener('click', refresh);
  // Browsers throttle timers in background tabs; re-sync as soon as the tab is visible again.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { clearTimeout(STATE.pollTimer); load(); } });
  window.addEventListener('hashchange', () => { STATE.tab = location.hash.slice(1) || 'overview'; renderShell(); window.GSBHistory?.render(); document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${STATE.tab}`)); pinLanes(); });
  // Tooltip layer: any element with data-tip.
  const tipEl = $('#tooltip');
  document.addEventListener('mousemove', (ev) => {
    const el = ev.target.closest('[data-tip]');
    if (!el) { tipEl.classList.add('hidden'); return; }
    tipEl.textContent = el.dataset.tip;
    tipEl.classList.remove('hidden');
    const x = Math.min(ev.clientX + 14, window.innerWidth - tipEl.offsetWidth - 8);
    const y = Math.min(ev.clientY + 14, window.innerHeight - tipEl.offsetHeight - 8);
    tipEl.style.left = `${x}px`; tipEl.style.top = `${y}px`;
  });
  // Keyboard focus shows the same details beside the focused mark.
  document.addEventListener('focusin', (ev) => {
    const el = ev.target.closest?.('[data-tip]');
    if (!el) return;
    tipEl.textContent = el.dataset.tip;
    tipEl.classList.remove('hidden');
    const box = el.getBoundingClientRect();
    tipEl.style.left = `${Math.max(8, Math.min(box.right + 8, window.innerWidth - tipEl.offsetWidth - 8))}px`;
    tipEl.style.top = `${Math.max(8, Math.min(box.bottom + 6, window.innerHeight - tipEl.offsetHeight - 8))}px`;
  });
  document.addEventListener('focusout', () => tipEl.classList.add('hidden'));
  document.addEventListener('scroll', (ev) => {
    const el = ev.target;
    if (el.classList?.contains('ci-lanes-scroll')) el.dataset.away = el.scrollLeft + el.clientWidth < el.scrollWidth - 2 ? '1' : '';
  }, true);
  window.addEventListener('resize', () => pinLanes());

  // Shared helpers for the board module (static/board.js).
  window.GSB = { esc, ago, days, date, n, badge, labelChips, link, codeify, conclusionBadge, tip, empty, kv, CONCLUSION_NAME, refresh, snapshot:()=>STATE.snap };
  STATE.tab = location.hash.slice(1) || 'overview';
  load();
})();
