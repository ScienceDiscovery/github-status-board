const { test, expect } = require("../.e2e/node_modules/@playwright/test");
const { resolve } = require("node:path");
const screenshot = (name) => resolve(__dirname, "../.e2e/" + name + ".png");

test("manager sees stages and risk; only same-site static requests", async ({
  page,
}) => {
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto("/github-status-board/");
  await expect(page.locator(".lane")).toHaveCount(3);
  await expect(page.locator(".attention")).toContainText(
    "开放 PR 存在失败检查",
  );
  await expect(page.locator(".lane").first()).toContainText("7 / 10");
  await expect(page.locator(".lane").first()).toContainText("70.0%");
  await expect(page.locator("#updated-at")).toContainText("20:00:00");
  await expect(page.locator("#freshness-badge")).toContainText("超过 2 小时");
  await page.screenshot({
    path: screenshot("overview-desktop"),
    fullPage: true,
  });
  expect(
    requests.every((url) =>
      url.startsWith("http://127.0.0.1:18890/github-status-board/"),
    ),
  ).toBeTruthy();
  expect(requests.some((url) => url.includes("/api/"))).toBeFalsy();
});

test("find issue or PR and inspect current commit checks safely", async ({
  page,
}) => {
  await page.goto("/github-status-board/#work");
  await expect(page.locator("#work-table tbody tr")).toHaveCount(2);
  await expect(page.locator("#work-table")).toContainText(
    "<script>alert(1)</script>",
  );
  expect(await page.locator("#work-table script").count()).toBe(0);
  await page.getByLabel("类型", { exact: true }).selectOption("pr");
  await expect(page.locator("#work-table tbody tr")).toHaveCount(1);
  await expect(page.locator("#work-table")).toContainText("需修改");
  await page.getByText("查看检查", { exact: true }).click();
  await expect(page.locator("details")).toContainText("E2E");
  await page.getByLabel("搜索", { exact: true }).fill("不存在");
  await expect(page.locator("#work-table")).toContainText("没有匹配");
});

test("E2E counts, retries, stage filters and case evidence", async ({
  page,
}) => {
  await page.goto("/github-status-board/#quality");
  await page.getByLabel("阶段", { exact: true }).selectOption("daily");
  await expect(page.locator(".run-card")).toHaveCount(1);
  await expect(page.locator(".run-card")).toContainText("attempt 2");
  await page.getByRole("button", { name: "e2e-results →" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("恢复会话");
  await expect(page.getByRole("dialog")).toContainText("重试后通过");
  await expect(page.getByRole("dialog")).toContainText("7 / 10 通过");
  await page.screenshot({ path: screenshot("e2e-detail"), fullPage: true });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("release without matching SHA evidence stays unknown", async ({
  page,
}) => {
  await page.goto("/github-status-board/#releases");
  await expect(page.locator(".release-row").first()).toContainText(
    "10 / 10 通过",
  );
  await expect(page.locator(".release-row").last()).toContainText(
    "尚无匹配的版本验证",
  );
});

test("missing data does not become zero or a passing build", async ({
  page,
}) => {
  await page.goto("/empty/");
  await expect(page.locator(".metric .value").first()).toHaveText("—");
  await expect(page.locator(".lane .empty")).toHaveCount(3);
  await expect(page.locator("#banner")).toContainText("结果未知");
  await page.getByRole("link", { name: "构建与测试", exact: true }).click();
  await expect(page.locator("#content")).toContainText("尚无 Actions 运行记录");
});

test("narrow viewport and failed refresh preserve loaded snapshot", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/github-status-board/");
  await expect(page.locator(".lane")).toHaveCount(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: screenshot("overview-mobile"),
    fullPage: true,
  });
  await page.route("**/data/snapshot.json*", (route) =>
    route.fulfill({ status: 503, body: "unavailable" }),
  );
  await page.getByRole("button", { name: "刷新视图 ↻" }).click();
  await expect(page.locator("#banner")).toContainText("读取失败");
  await expect(page.locator(".lane")).toHaveCount(3);
});
