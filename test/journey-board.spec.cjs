const { test, expect } = require('../.e2e/node_modules/@playwright/test');
const { resolve } = require('node:path');
const shot = name => resolve(__dirname, '../.e2e/' + name + '.png');

test('all existing pages render; only static requests and no promotional copy', async ({ page }) => {
  const requests = [], errors = [];
  page.on('request', r => requests.push(r.url()));
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/github-status-board/');
  await expect(page.locator('#tab-overview .lane')).toHaveCount(3);
  await expect(page.locator('#tab-overview .lane').first()).toContainText('7 / 10');
  await expect(page.locator('#tab-overview .lane').first()).toContainText('70.0%');
  await expect(page.locator('#meta')).toContainText('20:00');
  await expect(page.locator('#global-banner')).toContainText('超过两小时');
  await expect(page.locator('body')).not.toContainText('把进展与风险放在同一页');
  await page.screenshot({path:shot('overview-desktop'),fullPage:true});
  await expect(page.locator('.topbar #tabs a')).toHaveCount(11);
  await expect(page.locator('body > footer')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('GitHub Pages 静态看板 · GitHub 数据只读');
  await expect(page.locator('#global-banner')).not.toContainText('部分补充信息不可读取');
  const tabsBox=await page.locator('#tabs').boundingBox(), timeBox=await page.locator('#meta').boundingBox();
  expect(timeBox.x).toBeGreaterThan(tabsBox.x+tabsBox.width);
  expect(timeBox.y).toBeLessThan(tabsBox.y+tabsBox.height);
  for (const id of ['board','issues','prs','ci','tests','coverage','ops','quality','releases','history']) {
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

test('board grouping, drawer edits and reload retain browser fields', async ({page})=>{
  await page.goto('/github-status-board/#board');
  await expect(page.locator('.bcard')).toHaveCount(2);
  await page.locator('[data-open="issue:1"]').click();
  await expect(page.locator('#drawer')).toContainText('Reproduction');
  await expect(page.locator('#drawer')).toContainText('<script>alert(2)</script>');
  await page.locator('[data-dfield="priority"]').selectOption('P1');
  await page.locator('[data-dfield="iteration"]').fill('Sprint 8');
  await page.locator('[data-dfield="iteration"]').press('Tab');
  await page.locator('[data-dfield="note"]').fill('本地记录');
  await page.locator('[data-dfield="note"]').press('Tab');
  await page.locator('[data-baction="close-drawer"]').click();
  await page.locator('[data-bpref="group"] [data-val="priority"]').click();
  await expect(page.locator('.bcard[data-id="issue:1"]')).toContainText('P1');
  await page.reload();
  await page.locator('[data-open="issue:1"]').click();
  await expect(page.locator('[data-dfield="priority"]')).toHaveValue('P1');
  await expect(page.locator('[data-dfield="iteration"]')).toHaveValue('Sprint 8');
  await expect(page.locator('[data-dfield="note"]')).toHaveValue('本地记录');
  await page.locator('[data-baction="close-drawer"]').click();
  await page.screenshot({path:shot('project-board'),fullPage:true});
});

test('drag a card, configure renamed column and WIP, preserve manual status',async({page})=>{
  await page.goto('/github-status-board/#board');
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

test('table edits, sorting, field import/export stay local',async({page})=>{
  const writes=[];page.on('request',r=>{if(r.method()!=='GET')writes.push(r.url())});
  await page.goto('/github-status-board/#board');
  await page.locator('[data-bpref="view"] [data-val="table"]').click();
  await page.locator('[data-field="priority"][data-id="pr:3"]').selectOption('P0');
  await page.locator('[data-bsort="number"]').click();
  await expect(page.locator('[data-field="priority"][data-id="pr:3"]')).toHaveValue('P0');
  const download=page.waitForEvent('download');
  await page.locator('[data-local-export]').click();
  expect((await download).suggestedFilename()).toBe('board-fields.json');
  const state=await page.evaluate(()=>JSON.parse(window.GSBLocalBoard.export()));
  state.items['pr:3'].priority='P2';state.items['pr:3'].note='导入的记录';
  await page.locator('[data-local-import]').setInputFiles({name:'fields.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(state))});
  await expect(page.locator('[data-field="priority"][data-id="pr:3"]')).toHaveValue('P2');
  await expect(page.locator('.board-table')).toContainText('导入的记录');
  state.repo='example/other';
  await page.locator('[data-local-import]').setInputFiles({name:'wrong.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(state))});
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
  await expect(page.locator('#tab-coverage')).toContainText('不会更新 main 当前覆盖率');
  await expect(page.locator('#tab-coverage')).toContainText('门禁实测行覆盖率');
  await expect(page.locator('#tab-coverage .coverage-trend')).toHaveCount(2);
  await expect(page.locator('#tab-coverage .coverage-trend').first().locator('.coverage-dot')).toHaveCount(4);
  await expect(page.locator('#tab-coverage .coverage-trend').first().locator('.coverage-y-label')).toHaveCount(5);
  await expect(page.locator('#tab-coverage .coverage-trend').first()).toContainText('9/17');
  await expect(page.locator('#tab-coverage .coverage-trend').first()).not.toContainText('2026');
  await page.locator('#tab-coverage .coverage-trend').first().locator('.coverage-hit').last().hover();
  await expect(page.locator('#tooltip')).toContainText('83.0%');
  await page.screenshot({path:shot('coverage-desktop'),fullPage:true});
  await page.locator('[data-tab="ops"]').click();
  await expect(page.locator('#tab-ops')).toContainText('贡献者');
  await expect(page.locator('#tab-ops')).toContainText('分支与保护');
  await expect(page.locator('#tab-ops a[href$="/graphs/traffic"]')).toHaveCount(1);
});

test('E2E retries, stage filter and case evidence',async({page})=>{
  await page.goto('/github-status-board/#quality');
  await page.getByLabel('阶段',{exact:true}).selectOption('daily');
  await expect(page.locator('.run-card')).toHaveCount(1);
  await expect(page.locator('.run-card')).toContainText('attempt 2');
  await page.getByRole('button',{name:'e2e-results →'}).click();
  await expect(page.locator('#test-detail')).toContainText('恢复会话');
  await expect(page.locator('#test-detail')).toContainText('重试后通过');
  await expect(page.locator('#test-detail')).toContainText('7 / 10 通过');
  await page.screenshot({path:shot('e2e-detail'),fullPage:true});
  await page.locator('#close-detail').click();
  await expect(page.locator('#test-detail')).not.toBeVisible();
});

test('release evidence matches SHA; no evidence remains unknown',async({page})=>{
  await page.goto('/github-status-board/#releases');
  await expect(page.locator('.release-row').first()).toContainText('10 / 10 通过');
  await expect(page.locator('.release-row').last()).toContainText('尚无匹配的版本验证');
});

test('unavailable data is not zero or a passing build',async({page})=>{
  await page.goto('/empty/');
  await expect(page.locator('#tab-overview .tile .value').first()).toHaveText('—');
  await expect(page.locator('#tab-overview .lane .empty')).toHaveCount(3);
  await expect(page.locator('#global-banner')).toContainText('结果未知');
  await page.locator('[data-tab="quality"]').click();
  await expect(page.locator('#tab-quality')).toContainText('尚无 Actions 运行记录');
});

test('mobile layout and failed refresh preserve snapshot',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('/github-status-board/');
  await expect(page.locator('#tab-overview .lane')).toHaveCount(3);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:shot('overview-mobile'),fullPage:true});
  await page.route('**/data/snapshot.json*',r=>r.fulfill({status:503,body:'unavailable'}));
  await page.getByRole('button',{name:'刷新视图',exact:true}).click();
  await expect(page.locator('#global-banner')).toContainText('无法读取快照');
  await expect(page.locator('#tab-overview .lane')).toHaveCount(3);
});


test('board fits viewport while columns and table scroll independently',async({page})=>{
  await page.setViewportSize({width:1280,height:720});
  await page.route('**/data/snapshot.json*',async route=>{
    const response=await route.fetch(), doc=await response.json();
    const item=doc.board.items.find(i=>i.kind==='issue');
    doc.board.items=Array.from({length:60},(_,i)=>({...item,id:'issue:'+(100+i),number:100+i,title:'待处理工作项 '+i,linked:[]}));
    await route.fulfill({response,json:doc});
  });
  await page.goto('/github-status-board/#board');
  const column=page.locator('.bcol[data-key="待处理"] .bcol-body');
  await expect(column.locator('.bcard')).toHaveCount(60);
  const viewportFits=()=>page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight && document.documentElement.scrollWidth<=innerWidth);
  expect(await viewportFits()).toBeTruthy();
  const head=await page.locator('.bcol[data-key="待处理"] .bcol-head').boundingBox();
  await column.hover();await page.mouse.wheel(0,700);
  await expect.poll(()=>column.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
  expect((await page.locator('.bcol[data-key="待处理"] .bcol-head').boundingBox()).y).toBe(head.y);
  expect(await page.evaluate(()=>scrollY)).toBe(0);
  const scroll=await column.evaluate(el=>el.scrollTop);
  await page.getByRole('button',{name:'刷新视图',exact:true}).click();
  await expect.poll(()=>column.evaluate(el=>el.scrollTop)).toBe(scroll);
  await page.locator('[data-bpref="equal"]').uncheck();
  expect(await viewportFits()).toBeTruthy();
  await expect.poll(()=>column.evaluate(el=>el.scrollHeight>el.clientHeight)).toBeTruthy();
  await page.locator('[data-bpref="view"] [data-val="table"]').click();
  const table=page.locator('.board-table');
  await expect(table.locator('tbody tr')).toHaveCount(60);
  await table.hover();await page.mouse.wheel(0,700);
  await expect.poll(()=>table.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
  expect(await viewportFits()).toBeTruthy();
  await page.locator('[data-bpref="view"] [data-val="board"]').click();
  await page.setViewportSize({width:390,height:640});
  expect(await viewportFits()).toBeTruthy();
  const group=page.locator('[data-bpref="group"]');
  expect(await group.locator('button').evaluateAll(buttons=>buttons.every(b=>b.clientHeight<40))).toBeTruthy();
  await group.locator('[data-val="author"]').click();
  await expect(group.locator('[data-val="author"]')).toHaveClass('on');
  await page.setViewportSize({width:1280,height:720});
  await page.locator('[data-tab="tests"]').click();
  await expect(page.locator('#tab-tests')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollHeight>innerHeight)).toBeTruthy();
  await page.mouse.move(900,650);await page.mouse.wheel(0,500);
  await expect.poll(()=>page.evaluate(()=>scrollY)).toBeGreaterThan(0);
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
  await page.goto('/github-status-board/#board');
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
