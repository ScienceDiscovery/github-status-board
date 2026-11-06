const { test, expect } = require('../.e2e/node_modules/@playwright/test');
const { resolve } = require('node:path');

for (const [width, height] of [[1440, 1000], [900, 600], [390, 844]]) {
  test(`generic producer table renders for another repository at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/generic-summary/#tests');
    await expect(page.locator('#repo-link')).toHaveText('acme/weather-service');
    const section = page.locator('#tab-tests .summary-table');
    await expect(section).toHaveCount(1);
    await expect(section.getByRole('heading')).toHaveText('case execution');
    await expect(section.locator('th')).toHaveText(['#', 'case', 'status', 'score', 'peak memory GB',
      'generated tokens', 'judge tokens', 'total tokens', 'tool calls', 'duration min']);
    await expect(section.locator('tbody tr').first().locator('td')).toHaveText([
      '1', 'probe-b', 'failed', 'n/a', 'n/a', 'n/a', 'n/a', '34.2K', 'n/a', '1.5']);
    await expect(section.locator('tbody tr').nth(1).locator('td')).toHaveText([
      '2', '<script>window.injected=true</script> probe-a', 'passed', '0', '2.50', '900', '14.5M', 'n/a', '7', 'n/a']);
    expect(await page.evaluate(() => window.injected)).toBeUndefined();
    await expect(section.locator('script')).toHaveCount(0);
    expect(errors).toEqual([]);
    const region = section.getByRole('region', { name: 'case execution' });
    await region.focus();
    await expect(region).toBeFocused();
    const geometry = await region.evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth,
      page: document.documentElement.scrollWidth, viewport: window.innerWidth }));
    expect(geometry.page).toBeLessThanOrEqual(geometry.viewport + 1);
    if (width === 390) {
      expect(geometry.content).toBeGreaterThan(geometry.width);
      await page.keyboard.press('End');
      await region.evaluate(el => { el.scrollLeft = el.scrollWidth; });
      expect(await region.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
      await expect(section.locator('th').last()).toBeInViewport();
    }
    await region.evaluate(el => { el.scrollLeft = 0; });
    await section.evaluate(el => window.scrollTo(0, Math.max(0, window.scrollY + el.getBoundingClientRect().top - 150)));
    await section.screenshot({ path: resolve(__dirname, `../.e2e/summary-table-${width}.png`) });
  });
}

test('arbitrary column keys and order remain producer-controlled', async ({ page }) => {
  await page.route('**/generic-summary/data/snapshot.json*', async route => {
    const response = await route.fetch(), doc = await response.json();
    doc.sections.tests.data.executed[0].table = {
      title: 'Sensor readings', columns: [{ key: 'opaque', label: 'Reading' }, { key: 'id', label: 'Sensor' }],
      rows: [{ id: 'sensor-z', opaque: '34.2K' }, { id: 'sensor-a', opaque: 'n/a' }],
    };
    await route.fulfill({ response, json: doc });
  });
  await page.goto('/generic-summary/#tests');
  const section = page.locator('.summary-table');
  await expect(section.locator('th')).toHaveText(['Reading', 'Sensor']);
  await expect(section.locator('tbody td')).toHaveText(['34.2K', 'sensor-z', 'n/a', 'sensor-a']);
});

test('legacy counts-only summary keeps its existing view', async ({ page }) => {
  await page.route('**/generic-summary/data/snapshot.json*', async route => {
    const response = await route.fetch(), doc = await response.json();
    delete doc.sections.tests.data.executed[0].table;
    await route.fulfill({ response, json: doc });
  });
  await page.goto('/generic-summary/#tests');
  await expect(page.locator('#tab-tests .summary-table')).toHaveCount(0);
  await expect(page.locator('#tab-tests')).toContainText('CI 最近 E2E 用例');
  await expect(page.locator('#tab-tests .tile').filter({ hasText: 'CI 最近 E2E 用例' })).toContainText('2');
});
