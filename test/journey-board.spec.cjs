const { test, expect } = require('../.e2e/node_modules/@playwright/test');
const { resolve } = require('node:path');
const shot = name => resolve(__dirname, '../.e2e/' + name + '.png');

test('all existing pages render; only static requests and no promotional copy', async ({ page }) => {
  const requests = [], errors = [];
  page.on('request', r => requests.push(r.url()));
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/github-status-board/');
  // Problems first: the red main CI and overdue PR work lead the overview.
  const health=page.locator('#tab-overview .health');
  await expect(health).toContainText('1 个流水线问题需要处理');
  await expect(health.locator('.attention').first()).toContainText('主干 CI 连续失败 1 次');
  await expect(health).toContainText('1 个 PR 超过 3 天无人评审');
  await expect(page.locator('#tab-overview .tile').filter({hasText:'PR 门禁'})).toContainText('近 30 天成功率');
  await expect(page.locator('#tab-overview .tile').filter({hasText:'主干门禁用例'})).toContainText('324');
  await expect(page.locator('#tab-overview .tile').filter({hasText:'整仓行覆盖率'})).toContainText('80.7%');
  await expect(page.locator('#tab-overview .ci-lane-row:not(.ci-axis)')).toHaveCount(4);
  await expect(page.locator('#tab-overview .ci-lane-row[data-lane="pr"] .ci-lane-day')).toHaveCount(14);
  await expect(page.locator('#tab-overview')).toContainText('v1.0');
  await expect(page.locator('#meta')).toContainText('20:00');
  await expect(page.locator('#global-banner')).toContainText('超过两小时');
  await expect(page.locator('body')).not.toContainText('把进展与风险放在同一页');
  await page.screenshot({path:shot('overview-desktop'),fullPage:true});
  await expect(page.locator('.topbar #tabs a')).toHaveCount(8);
  await expect(page.locator('.topbar #tabs')).not.toContainText('构建报告');
  await expect(page.locator('.topbar #tabs')).not.toContainText('历史数据');
  await expect(page.locator('body > footer')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('GitHub Pages 静态看板 · GitHub 数据只读');
  await expect(page.locator('#global-banner')).not.toContainText('部分补充信息不可读取');
  const tabsBox=await page.locator('#tabs').boundingBox(), timeBox=await page.locator('#meta').boundingBox();
  expect(timeBox.x).toBeGreaterThan(tabsBox.x+tabsBox.width);
  expect(timeBox.y).toBeLessThan(tabsBox.y+tabsBox.height);
  for (const id of ['issues','prs','ci','tests','coverage','releases','ops']) {
    await page.locator(`[data-tab="${id}"]`).click();
    await expect(page.locator(`#tab-${id}`)).toBeVisible();
    await expect(page.locator(`#tab-${id}`)).not.toContainText('渲染出错');
  }
  expect(errors).toEqual([]);
  expect(requests.every(url => url.startsWith('http://127.0.0.1:18890/github-status-board/'))).toBeTruthy();
  expect(requests.some(url => url.includes('/api/'))).toBeFalsy();
});

test('issue distribution and filters; PR reviews and current commit checks', async ({page})=>{
  await page.goto('/github-status-board/#issues');
  await expect(page.locator('#tab-issues')).toContainText('年龄分布');
  await expect(page.locator('#tab-issues')).toContainText('<script>alert(1)</script>');
  expect(await page.locator('#tab-issues script').count()).toBe(0);
  await page.locator('[data-filter="issueQ"]').fill('不存在');
  await expect(page.locator('#tab-issues')).toContainText('0 / 1');
  await page.locator('[data-filter="issueQ"]').fill('超时');
  await expect(page.locator('#tab-issues')).toContainText('1 / 1');
  await page.locator('[data-tab="prs"]').click();
  await expect(page.locator('#tab-prs')).toContainText('需修改');
  await expect(page.locator('#tab-prs')).toContainText('评审负载');
  await page.locator('#tab-prs summary').click();
  await expect(page.locator('#tab-prs details')).toContainText('E2E');
});

// Issue and PR lists switch between the table and the local board.
const showBoard = async (page, tab) => { await page.locator(`[data-work-view="${tab}"] [data-val="board"]`).click(); await expect(page.locator(`#tab-${tab} .work-board .board`)).toBeVisible(); };
test('board grouping, drawer edits and reload retain browser fields', async ({page})=>{
  await page.goto('/github-status-board/#issues');
  await expect(page.locator('#tab-issues .work-table')).toContainText('处理超时问题');
  await showBoard(page, 'issues');
  // Each page shows only its own kind; statistics stay above the list.
  await expect(page.locator('#tab-issues .bcard')).toHaveCount(1);
  await expect(page.locator('#tab-issues')).toContainText('年龄分布');
  await page.locator('[data-open="issue:1"]').click();
  await expect(page.locator('#drawer')).toContainText('Reproduction');
  await expect(page.locator('#drawer')).toContainText('<script>alert(2)</script>');
  await page.locator('[data-dfield="priority"]').selectOption('P1');
  await page.locator('[data-dfield="iteration"]').fill('Sprint 8');
  await page.locator('[data-dfield="iteration"]').press('Tab');
  await page.locator('[data-dfield="note"]').fill('本地记录');
  await page.locator('[data-dfield="note"]').press('Tab');
  await page.locator('[data-baction="close-drawer"]').click();
  await page.locator('#tab-issues [data-bpref="group"] [data-val="priority"]').click();
  await expect(page.locator('.bcard[data-id="issue:1"]')).toContainText('P1');
  await page.locator('[data-tab="prs"]').click();
  await expect(page.locator('#tab-prs .work-table')).toContainText('修复工作流');
  await showBoard(page, 'prs');
  await expect(page.locator('#tab-prs .bcard')).toHaveCount(1);
  await expect(page.locator('#tab-prs .bcard[data-id="pr:3"]')).toBeVisible();
  // PR filters and grouping are kept apart from the Issue board.
  await expect(page.locator('#tab-prs [data-bpref="group"] [data-val="status"]')).toHaveClass('on');
  await page.reload();
  await expect(page.locator('#tab-prs .bcard[data-id="pr:3"]')).toBeVisible();
  await page.locator('[data-tab="issues"]').click();
  await page.locator('[data-open="issue:1"]').click();
  await expect(page.locator('[data-dfield="priority"]')).toHaveValue('P1');
  await expect(page.locator('[data-dfield="iteration"]')).toHaveValue('Sprint 8');
  await expect(page.locator('[data-dfield="note"]')).toHaveValue('本地记录');
  await page.locator('[data-baction="close-drawer"]').click();
  await page.screenshot({path:shot('issue-board'),fullPage:true});
  await page.locator('[data-work-view="issues"] [data-val="table"]').click();
  await expect(page.locator('#tab-issues .work-board')).toHaveCount(0);
  await expect(page.locator('#tab-issues .work-table')).toContainText('处理超时问题');
});

test('drag a card, configure renamed column and WIP, preserve manual status',async({page})=>{
  await page.goto('/github-status-board/#issues');
  await showBoard(page, 'issues');
  // Use the same native drag/drop events as the board; no server mutation occurs.
  const transfer=await page.evaluateHandle(()=>new DataTransfer());
  await page.locator('.bcard[data-id="issue:1"]').dispatchEvent('dragstart',{dataTransfer:transfer});
  await page.locator('.bcol[data-key="进行中"]').dispatchEvent('drop',{dataTransfer:transfer});
  await page.locator('.bcard[data-id="issue:1"]').dispatchEvent('dragend',{dataTransfer:transfer});
  await page.locator('[data-open="issue:1"]').click();
  await expect(page.locator('[data-dfield="status"]')).toHaveValue('进行中');
  await page.locator('[data-baction="close-drawer"]').click();
  await page.locator('[data-baction="settings"]').click();
  const row=page.locator('#status-rows tr').nth(1);
  await row.locator('[name="name"]').fill('处理中');
  await row.locator('[name="limit"]').fill('1');
  await page.locator('[data-baction="add-status"]').click();
  await page.locator('#status-rows tr').last().locator('[name="name"]').fill('临时列');
  await page.locator('#status-rows tr').last().locator('[data-srow="up"]').click();
  await expect(page.locator('#status-rows tr').nth(3).locator('[name="name"]')).toHaveValue('临时列');
  await page.locator('#status-rows tr').nth(3).locator('[data-srow="del"]').click();
  await expect(page.locator('#status-rows tr')).toHaveCount(4);
  await page.locator('#settings-form').getByRole('button',{name:'保存',exact:true}).click();
  await expect(page.locator('#board-settings')).not.toBeVisible();
  await page.getByRole('button',{name:'刷新视图',exact:true}).click();
  await page.locator('[data-open="issue:1"]').click();
  await expect(page.locator('[data-dfield="status"]')).toHaveValue('处理中');
  await page.locator('[data-baction="close-drawer"]').click();
  await page.locator('[data-baction="history"]').click();
  await expect(page.locator('.board-history')).toContainText('手动');
});

test('drawer edits and field import/export stay local',async({page})=>{
  const writes=[];page.on('request',r=>{if(r.method()!=='GET')writes.push(r.url())});
  await page.goto('/github-status-board/#prs');
  await showBoard(page, 'prs');
  await page.locator('[data-open="pr:3"]').click();
  await page.locator('[data-dfield="priority"]').selectOption('P0');
  await page.locator('[data-baction="close-drawer"]').click();
  await expect(page.locator('.bcard[data-id="pr:3"]')).toContainText('P0');
  const download=page.waitForEvent('download');
  await page.locator('#tab-prs [data-local-export]').click();
  expect((await download).suggestedFilename()).toBe('board-fields.json');
  const state=await page.evaluate(()=>JSON.parse(window.GSBLocalBoard.export()));
  state.items['pr:3'].priority='P2';state.items['pr:3'].note='导入的记录';
  await page.locator('#tab-prs [data-local-import]').setInputFiles({name:'fields.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(state))});
  await expect(page.locator('.bcard[data-id="pr:3"]')).toContainText('P2');
  await expect(page.locator('.bcard[data-id="pr:3"]')).toContainText('导入的记录');
  state.repo='example/other';
  await page.locator('#tab-prs [data-local-import]').setInputFiles({name:'wrong.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(state))});
  await expect(page.locator('#board-flash')).toContainText('文件不属于当前仓库');
  expect(writes).toEqual([]);
});

test('CI trends, failed job steps, test distribution, coverage and operations',async({page})=>{
  await page.goto('/github-status-board/#ci');
  await expect(page.locator('#tab-ci')).toContainText('Workflow 健康');
  await expect(page.locator('#tab-ci')).toContainText('Run browser journeys');
  await expect(page.locator('#tab-ci')).toContainText('Coverage');
  const lanes = page.locator('#tab-ci .ci-lanes');
  const lane = (key) => lanes.locator(`.ci-lane-row[data-lane="${key}"]`);
  await expect(lanes.locator('.ci-lane-row:not(.ci-axis)')).toHaveCount(4);
  for (const key of ['pr','main','daily','release']) await expect(lane(key).locator('.ci-lane-day')).toHaveCount(30);
  // One shared day axis: the newest column starts at the same x in every lane.
  const newestX = await Promise.all(['pr','main','daily','release'].map(async (key) => Math.round((await lane(key).locator('.ci-lane-day').last().boundingBox()).x)));
  expect(new Set(newestX).size).toBe(1);
  const today = lane('pr').locator('.ci-lane-day').last().locator('.ci-run');
  await expect(today).toHaveCount(13);
  expect((await today.nth(1).boundingBox()).y).toBeGreaterThan((await today.nth(0).boundingBox()).y);
  await expect(today.first()).toHaveAttribute('aria-label', /00:10（UTC\+8）/);
  await expect(today.first()).toHaveAttribute('href', /\/actions\/runs\/500$/);
  await expect(today.nth(1)).toHaveClass(/failure/);
  await expect(lane('pr').locator('.ci-day-more')).toHaveText('13');
  await today.nth(1).hover();
  await expect(page.locator('#tooltip')).toContainText('CI · pull_request · PR #3');
  await expect(page.locator('#tooltip')).toContainText('分支 fix-timeout');
  await expect(lane('main').locator('.ci-run').last()).toHaveAttribute('aria-label', /workflow_dispatch · 手动/);
  await expect(lane('daily').locator('.ci-run')).toHaveCount(8);
  await expect(lane('release').locator('.ci-run')).toHaveCount(0);
  await expect(lane('release')).toContainText('窗口内没有 run');
  await expect(lane('release')).not.toContainText('失败 1');
  await expect(page.locator('#tab-ci .ci-lane-notes')).toContainText('1 次由其他工作流调用的 CI 子 run 已并入调用方');
  await page.mouse.move(0, 0);
  await page.locator('#tab-ci .card:has(.ci-lanes)').screenshot({path:shot('ci-lanes-desktop')});
  await page.setViewportSize({width:390,height:844});
  const scroller = page.locator('#tab-ci .ci-lanes-scroll');
  // The day axis scrolls inside the card and opens on the newest day.
  await expect.poll(() => scroller.evaluate((el) => el.scrollWidth > el.clientWidth && el.scrollLeft + el.clientWidth >= el.scrollWidth - 2)).toBeTruthy();
  const heads = await Promise.all(['pr','main','daily','release'].map(async (key) => (await lane(key).locator('.ci-lane-head').boundingBox())));
  for (const [i, box] of heads.entries()) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    if (i) expect(box.y).toBeGreaterThan(heads[i - 1].y + 20);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.locator('#tab-ci .card:has(.ci-lanes)').screenshot({path:shot('ci-lanes-narrow')});
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('[data-tab="tests"]').click();
  await expect(page.locator('#tab-tests')).toContainText('按包 / 目录分布');
  await expect(page.locator('#tab-tests')).toContainText('services/core');
  await expect(page.locator('#tab-tests')).not.toContainText('200.0%');
  await expect(page.locator('#tab-tests')).not.toContainText('undefined');
  await page.screenshot({path:shot('tests-desktop'),fullPage:true});
  await page.locator('[data-tab="coverage"]').click();
  await expect(page.locator('#tab-coverage')).toContainText('整仓行覆盖率');
  await expect(page.locator('#tab-coverage .tiles').first().locator('.tile')).toHaveCount(3);
  await expect(page.locator('#tab-coverage .tiles').first()).not.toContainText('Node.js 函数覆盖率');
  await expect(page.locator('#tab-coverage')).toContainText('80.7%');
  await expect(page.locator('#tab-coverage')).toContainText('Node.js');
  await expect(page.locator('#tab-coverage')).toContainText('83.0%');
  await expect(page.locator('#tab-coverage')).toContainText('Python');
  await expect(page.locator('#tab-coverage')).toContainText('65.4%');
  await expect(page.locator('#tab-coverage')).not.toContainText('口径');
  await expect(page.locator('#tab-coverage')).toContainText('目标为 main 的 PR 的 UT/ST 门禁实测范围');
  await expect(page.locator('#tab-coverage')).toContainText('门禁实测行覆盖率');
  const nodePrCoverage = page.locator('th[data-table="cov-prs-node"]').locator('xpath=ancestor::table');
  await expect(nodePrCoverage).toContainText('来源分支');
  await expect(nodePrCoverage).toContainText('目标分支');
  await expect(nodePrCoverage.getByRole('row').filter({ hasText: '#3' })).toContainText('fix-timeout');
  await expect(nodePrCoverage.getByRole('row').filter({ hasText: '#3' })).toContainText('feat/jiuwenswarm');
  await expect(page.locator('#tab-coverage .coverage-trend')).toHaveCount(2);
  await expect(page.locator('#tab-coverage .coverage-trend').first().locator('.coverage-dot')).toHaveCount(5);
  await expect(page.locator('#tab-coverage .coverage-trend').first().locator('.coverage-x-label')).toHaveCount(7);
  await expect(page.locator('#tab-coverage .coverage-trend').first().locator('.coverage-y-label')).toHaveCount(5);
  await expect(page.locator('#tab-coverage .coverage-trend').first()).toContainText('9/17');
  await expect(page.locator('#tab-coverage .coverage-week-toolbar')).toContainText('最新 · 9/15–9/21');
  await expect(page.locator('#tab-coverage .coverage-trend').first()).not.toContainText('2026');
  await page.locator('#tab-coverage .coverage-trend').first().locator('.coverage-hit').last().hover();
  await expect(page.locator('#tooltip')).toContainText('83.0%');
  await expect(page.locator('#tooltip')).toContainText('nightly');
  await page.locator('[data-coverage-week="older"]').click();
  await expect(page.locator('#tab-coverage .coverage-trend').first().locator('.coverage-dot')).toHaveCount(4);
  await expect(page.locator('#tab-coverage .coverage-week-toolbar')).toContainText('9/14–9/20');
  await page.locator('[data-coverage-week="older"]').click();
  await expect(page.locator('#tab-coverage .coverage-trend').first().locator('.coverage-dot')).toHaveCount(2);
  await expect(page.locator('#tab-coverage .coverage-week-toolbar')).toContainText('9/7–9/13');
  await page.locator('[data-coverage-week="latest"]').click();
  await expect(page.locator('#tab-coverage .coverage-week-toolbar')).toContainText('最新 · 9/15–9/21');
  const tree=page.locator('#tab-coverage .cov-tree[data-language="node"]');
  await expect(tree.locator('.cov-dir').first()).toContainText('packages/core/src/');
  await expect(tree.locator('.cov-dir').first()).toContainText('62.3%');
  await page.locator('[data-cov-expand="node"]').click();
  await expect(tree.locator('.cov-file', {hasText:'strings.ts'})).toContainText('90.0%');
  await expect(tree.locator('.cov-dir[data-cov-path="node:packages/core/src/util"] > summary')).toContainText('11 / 20 · 2 个文件');
  await page.locator('[data-cov-collapse="node"]').click();
  await expect(tree.locator('.cov-file', {hasText:'strings.ts'})).toBeHidden();
  await page.locator('[data-filter="coverageQ"]').first().fill('numbers');
  await expect(tree.locator('.cov-file')).toHaveCount(1);
  await expect(tree.locator('.cov-file')).toContainText('20.0%');
  await page.locator('[data-filter="coverageQ"]').first().fill('');
  await page.screenshot({path:shot('coverage-desktop'),fullPage:true});
  await page.locator('[data-tab="ops"]').click();
  await expect(page.locator('#tab-ops')).toContainText('贡献者');
  await expect(page.locator('#tab-ops')).toContainText('分支与保护');
  await expect(page.locator('#tab-ops a[href$="/graphs/traffic"]')).toHaveCount(1);
});

test('tagged dimensions, profile combinations and never-covered cases', async ({ page }) => {
  await page.goto('/github-status-board/#tests');
  const tab = page.locator('#tab-tests');
  await expect(tab).toContainText('标签化测试');
  await expect(tab).toContainText('349 个用例 · 8 个标签维度 · 10 种标签组合');
  await expect(tab.locator('.tile', { hasText: '从未覆盖' })).toContainText('25');
  await expect(tab.locator('.tile', { hasText: 'PR 选中' })).toContainText('324');
  await expect(tab.locator('.tile', { hasText: 'Release 选中' })).toContainText('暂无运行');
  const rulesText = tab.locator('.rule-list');
  await expect(rulesText).toContainText('PR：category ∈ {ut, st, e2e} 且 os = linux 且 arch = amd64');
  await expect(rulesText).toContainText('Daily：与 PR 规则相同');
  await expect(rulesText).toContainText('Release：暂无运行，无法读取组合');
  const matrix = tab.locator('.tag-matrix');
  await expect(matrix.locator('.dim-row')).toHaveCount(8);
  await expect(matrix.locator('.dim-row').first()).toContainText('category 单选 · 词表 3 个 · 使用 3 个');
  const takes = (tag) => matrix.locator(`tr[data-tag="${tag}"] .take`);
  await expect(takes('status:reviewed').first()).toHaveText('✓');
  await expect(takes('os:macos').first()).toHaveText('✗');
  await expect(takes('sandbox:seatbelt').first()).toHaveText('不限');
  await expect(takes('os:macos')).toHaveCount(2); // Release has no run, so its column stays empty
  await expect(matrix.locator('tr[data-tag="os:windows"]')).toHaveClass(/unused/);
  await expect(matrix.locator('tr[data-tag="status:external"]')).toContainText('未覆盖 12');
  await matrix.locator('tr[data-tag="status:external"] .tag-bar').hover();
  await expect(page.locator('#tooltip')).toContainText('从未覆盖 12');
  const uncovered = tab.locator('.card', { hasText: '从未覆盖的用例' });
  await expect(uncovered.locator('.bars')).toContainText('status=external');
  await expect(uncovered.locator('.bars')).toContainText('os=macos；arch=arm64');
  await uncovered.locator('summary').click();
  await expect(uncovered).toContainText('services/paper/tests/test_external.py::case 1');
  const combos = tab.locator('.card', { hasText: '标签组合' }).locator('tbody tr');
  await expect(combos).toHaveCount(10);
  await expect(combos.first()).toContainText('280');
  await page.mouse.move(0, 0);
  await tab.locator('.card:has(.tag-matrix)').screenshot({ path: shot('tagged-matrix-desktop') });
  await tab.locator('.grid.wide:has(.tag-chip)').screenshot({ path: shot('tagged-uncovered-desktop') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  const wrap = matrix.locator('xpath=..');
  expect(await wrap.evaluate((el) => el.scrollWidth >= el.clientWidth)).toBeTruthy();
  await tab.locator('.card:has(.tag-matrix)').screenshot({ path: shot('tagged-matrix-narrow') });
});

test('CI, tests and coverage switch between main and the jiuwen branch line without mixing', async ({ page }) => {
  await page.goto('/github-status-board/#ci');
  const ci = page.locator('#tab-ci'), rows = ci.locator('.ci-lanes .ci-lane-row:not(.ci-axis)');
  const switchOf = (tab) => page.locator(`#tab-${tab} .line-switch`);
  await expect(switchOf('ci').locator('button')).toHaveText(['main', 'feat/jiuwenswarm']);
  await expect(switchOf('ci').locator('button.on')).toHaveText('main');
  await expect(rows).toHaveCount(4);
  await expect(ci.locator('.ci-lanes')).not.toContainText('feat/jiuwenswarm');
  await expect(ci.locator('.ci-lanes .ci-run[href$="/runs/602"]')).toHaveCount(0);
  await switchOf('ci').getByRole('button', { name: 'feat/jiuwenswarm' }).click();
  // The jiuwen line has PR and branch lanes only: no Nightly or Release runs there.
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1).locator('.ci-lane-head b')).toHaveText('feat/jiuwenswarm');
  await expect(rows.nth(1).locator('.ci-lane-head')).toContainText('CI · feat/jiuwenswarm push / 手动');
  await expect(rows.first().locator('.ci-run')).toHaveCount(2);
  await expect(rows.nth(1).locator('.ci-run.failure')).toHaveAttribute('href', /\/runs\/602$/);
  await expect(ci.locator('.ci-lanes .ci-run[href$="/runs/500"]')).toHaveCount(0);
  await expect(ci.locator('.tile').first()).toContainText('feat/jiuwenswarm 分支成功率');
  await expect(ci).toContainText('Run unit tests');
  await expect(ci.locator('.ci-lane-notes')).not.toContainText('Nightly');
  const recent = ci.locator('th[data-table="ci-runs"]').first().locator('xpath=ancestor::table').locator('tbody tr');
  await expect(recent).toHaveCount(3);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: shot('line-ci-jiuwen-desktop') });
  // The choice holds on the test and coverage pages and across a reload.
  await page.locator('[data-tab="tests"]').click();
  const tests = page.locator('#tab-tests');
  await expect(switchOf('tests').locator('button.on')).toHaveText('feat/jiuwenswarm');
  await expect(tests).toContainText('feat/jiuwenswarm 最新 CI 冻结的用例目录 · 323 个用例');
  await expect(tests.locator('.tile', { hasText: 'Daily 选中' })).toHaveCount(0);
  await expect(tests.locator('.tag-matrix thead th.take-col')).toHaveCount(1);
  await page.locator('[data-tab="coverage"]').click();
  await expect(page.locator('#tab-coverage')).toContainText('feat/jiuwenswarm 还没有覆盖率摘要');
  await expect(page.locator('#tab-coverage')).not.toContainText('80.7%');
  await page.reload();
  await expect(switchOf('coverage').locator('button.on')).toHaveText('feat/jiuwenswarm');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.locator('[data-tab="ci"]').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.locator('#tab-ci .line-bar').screenshot({ path: shot('line-switch-narrow') });
  // The full branch name fits the narrow lane header instead of being clipped.
  const branchHead = rows.nth(1).locator('.ci-lane-head b');
  await expect(branchHead).toHaveText('feat/jiuwenswarm');
  expect(await branchHead.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= el.closest('.ci-lane-head').getBoundingClientRect().right + 1)).toBeTruthy();
  await page.locator('#tab-ci .card:has(.ci-lanes)').screenshot({ path: shot('line-ci-jiuwen-narrow') });
  await switchOf('ci').getByRole('button', { name: 'main' }).click();
  await expect(rows).toHaveCount(4);
  await page.locator('[data-tab="tests"]').click();
  await expect(page.locator('#tab-tests')).toContainText('349 个用例');
  // The overview stays on main and still surfaces the failing jiuwen run.
  await page.locator('[data-tab="overview"]').click();
  await expect(page.locator('#tab-overview .health')).toContainText('feat/jiuwenswarm 分支最近一次运行失败');
  await expect(page.locator('#tab-overview .ci-lane-row:not(.ci-axis)')).toHaveCount(4);
});

test('release evidence matches SHA; no evidence remains unknown',async({page})=>{
  await page.goto('/github-status-board/#releases');
  await expect(page.locator('.release-row').first()).toContainText('10 / 10 通过');
  await expect(page.locator('.release-row').last()).toContainText('尚无匹配的版本验证');
});

test('unavailable data is not zero or a passing build',async({page})=>{
  await page.goto('/empty/');
  const health=page.locator('#tab-overview .health');
  await expect(health).toContainText('CI 数据暂不可读取，状态未知');
  await expect(health).not.toContainText('正常');
  await expect(page.locator('#tab-overview .tile').filter({hasText:'主干门禁用例'}).locator('.value')).toHaveText('—');
  await expect(page.locator('#global-banner')).toContainText('结果未知');
  await page.locator('[data-tab="releases"]').click();
  await expect(page.locator('#tab-releases')).toContainText('仓库尚无 Release');
});

test('mobile layout and failed refresh preserve snapshot',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('/github-status-board/');
  await expect(page.locator('#tab-overview .health')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:shot('overview-mobile'),fullPage:true});
  await page.route('**/data/snapshot.json*',r=>r.fulfill({status:503,body:'unavailable'}));
  await page.getByRole('button',{name:'刷新视图',exact:true}).click();
  await expect(page.locator('#global-banner')).toContainText('无法读取快照');
  await expect(page.locator('#tab-overview .health')).toContainText('流水线问题');
});

test('board columns scroll independently inside the Issue page',async({page})=>{
  await page.setViewportSize({width:1280,height:720});
  await page.route('**/data/snapshot.json*',async route=>{
    const response=await route.fetch(), doc=await response.json();
    const item=doc.board.items.find(i=>i.kind==='issue');
    doc.board.items=Array.from({length:60},(_,i)=>({...item,id:'issue:'+(100+i),number:100+i,title:'待处理工作项 '+i,linked:[]}));
    await route.fulfill({response,json:doc});
  });
  await page.goto('/github-status-board/#issues');
  await showBoard(page, 'issues');
  const column=page.locator('.bcol[data-key="待处理"] .bcol-body');
  await expect(column.locator('.bcard')).toHaveCount(60);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await expect.poll(()=>column.evaluate(el=>el.scrollHeight>el.clientHeight)).toBeTruthy();
  await column.hover();await page.mouse.wheel(0,700);
  await expect.poll(()=>column.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
  const scroll=await column.evaluate(el=>el.scrollTop);
  await page.getByRole('button',{name:'刷新视图',exact:true}).click();
  await expect.poll(()=>column.evaluate(el=>el.scrollTop)).toBe(scroll);
  await page.setViewportSize({width:390,height:640});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  const group=page.locator('#tab-issues [data-bpref="group"]');
  expect(await group.locator('button').evaluateAll(buttons=>buttons.every(b=>b.clientHeight<40))).toBeTruthy();
  await group.locator('[data-val="author"]').click();
  await expect(group.locator('[data-val="author"]')).toHaveClass('on');
});

test('production and test sites show their source and isolate browser fields', async ({page}) => {
  let repo='openJiuwen-ai/sciencediscovery', label='正式';
  await page.route('**/data/snapshot.json*', async route => {
    const response=await route.fetch(), snapshot=await response.json();
    snapshot.repo=repo; snapshot.repo_url='https://github.com/'+repo;
    snapshot.deployment={label};
    await route.fulfill({response,json:snapshot});
  });
  async function note(value) {
    await page.locator('[data-open="issue:1"]').click();
    if(value!==undefined) {
      await page.locator('[data-dfield="note"]').fill(value);
      await page.locator('[data-dfield="note"]').press('Tab');
    }
  }
  await page.goto('/github-status-board/#issues');
  await showBoard(page, 'issues');
  await expect(page.locator('.brand-title')).toHaveText('正式 · GitHub 状态看板');
  await note('正式项目备注');
  await page.locator('[data-baction="close-drawer"]').click();
  repo='ScienceDiscovery/sciencediscovery'; label='测试';
  await page.reload();
  await expect(page.locator('.brand-title')).toHaveText('测试 · GitHub 状态看板');
  await expect(page.locator('#repo-link')).toHaveText(repo);
  await note();
  await expect(page.locator('[data-dfield="note"]')).toHaveValue('');
  await page.locator('[data-baction="close-drawer"]').click();
  repo='openJiuwen-ai/sciencediscovery'; label='正式';
  await page.reload(); await note();
  await expect(page.locator('[data-dfield="note"]')).toHaveValue('正式项目备注');
});
