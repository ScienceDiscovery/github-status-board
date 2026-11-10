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
    delete doc.sections.tests.data.summary_tables; // Older snapshots use the same renderer.
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
    delete doc.sections.tests.data.summary_tables;
    await route.fulfill({ response, json: doc });
  });
  await page.goto('/generic-summary/#tests');
  await expect(page.locator('#tab-tests .summary-table')).toHaveCount(0);
  await expect(page.locator('#tab-tests')).toContainText('CI 最近 E2E 用例');
  await expect(page.locator('#tab-tests .tile').filter({ hasText: 'CI 最近 E2E 用例' })).toContainText('2');
});

for (const width of [1440, 390]) {
  test(`producer groups keep separate counts and can be selected at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/tiered-summary/#tests');
    await expect(page.locator('#repo-link')).toHaveText('acme/weather-service');
    const sections = page.locator('#tab-tests .summary-table');
    await expect(sections).toHaveCount(3);
    const picker = page.getByRole('combobox', { name: '表格分组' });
    for (const [key, label, count, run] of [['smoke', 'L3 · smoke', 2, 101], ['regression', 'L4 · regression', 3, 102], ['full', 'L5 · full', 4, 103]]) {
      await picker.selectOption({ label });
      await expect(sections).toHaveCount(1);
      await expect(sections.first()).toHaveAttribute('data-summary-group', key);
      await expect(sections.locator('tbody tr')).toHaveCount(count);
      await expect(sections.getByRole('cell', { name: 'failed', exact: true })).toHaveCount(1);
      await expect(sections.getByRole('cell', { name: 'passed', exact: true })).toHaveCount(count - 1);
      await expect(sections.locator('.summary-counts')).toHaveText(`用例 ${count} · 通过 ${count - 1} · 失败 1 · 跳过 0 · 重试通过 0`);
      await expect(sections).toContainText(`run #${run} / attempt 1`);
      await expect(sections.getByRole('link', { name: 'service-test-results', exact: true })).toHaveAttribute('href',
        `https://github.com/acme/weather-service/actions/runs/${run}/artifacts/${run}`);
      await expect(sections.locator('tbody tr').first()).toContainText(`${key}-probe`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
      await sections.scrollIntoViewIfNeeded();
      await sections.screenshot({ path: resolve(__dirname, `../.e2e/summary-${key}-${width}.png`) });
    }
    await picker.selectOption('');
    await expect(sections).toHaveCount(3);
  });
}
