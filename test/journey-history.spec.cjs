const {test,expect}=require('../.e2e/node_modules/@playwright/test');
const {resolve}=require('node:path');

test('all-history pagination, search, safe body and metrics-only drilldown', async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/github-status-board/#history');
  await expect(page.locator('#history-count')).toContainText('625 条');
  await expect(page.locator('.history-record')).toHaveCount(25);
  await expect(page.locator('#tab-history')).toContainText('历史回填中');
  await page.getByRole('button',{name:'下一页',exact:true}).click();
  await expect(page.locator('#history-count')).toContainText('第 2 / 25 页');
  await page.getByLabel('搜索',{exact:true}).fill('历史 Issue 625');
  await page.getByRole('button',{name:'查询',exact:true}).click();
  await expect(page.locator('#history-count')).toContainText('1 条');
  await expect(page.locator('.history-record h3')).toContainText('#625');
  await page.getByText('查看内容',{exact:true}).click();
  await expect(page.locator('.history-body')).toContainText('<script>unsafe()</script>');
  await expect(page.locator('#tab-history script')).toHaveCount(0);
  await page.screenshot({path:resolve(__dirname,'../.e2e/history-desktop.png'),fullPage:true});
  await page.getByLabel('搜索',{exact:true}).fill('');
  await page.getByRole('button',{name:'查询',exact:true}).click();
  await page.getByLabel('类型',{exact:true}).selectOption('runs');
  await expect(page.locator('#history-count')).toContainText('3 条');
  await expect(page.locator('#tab-history')).toContainText('用例 10 · 通过 7 · 失败 1');
  await expect(page.locator('#tab-history')).not.toContainText('恢复会话');
  await expect(page.getByRole('link',{name:'GitHub 报告'}).first()).toHaveAttribute('href',/github\.com\/.*actions\/runs/);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:resolve(__dirname,'../.e2e/history-mobile.png'),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  expect(errors).toEqual([]);
});

test('history is lazy and a failed shard can be retried', async({page})=>{
  let historyRequests=0;page.on('request',r=>{if(r.url().includes('/history/'))historyRequests++;});
  await page.goto('/github-status-board/');
  await expect(page.locator('#tab-overview .lane')).toHaveCount(3);
  expect(historyRequests).toBe(0);
  let fail=true;
  await page.route('**/history/index/**',route=>fail?route.fulfill({status:503,body:'unavailable'}):route.continue());
  await page.getByRole('link',{name:'历史数据',exact:true}).click();
  await expect(page.locator('#history-result')).toContainText('历史数据读取失败');
  fail=false;await page.getByRole('button',{name:'重试',exact:true}).click();
  await expect(page.locator('#history-count')).toContainText('625 条');
});
