import { expect, test } from '@playwright/test';

test.skip(!process.env.PLAYWRIGHT_BASE_URL, 'Set PLAYWRIGHT_BASE_URL to run against the production fixture.');

test('local login, navigation, theme, chart controls, and keyboard inspection', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Username').fill(process.env.PLAYWRIGHT_USERNAME ?? 'admin');
  await page.getByLabel('Password').fill(process.env.PLAYWRIGHT_PASSWORD ?? 'test-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('navigation')).toBeVisible();

  await page.getByRole('link', { name: 'Markets', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Markets', exact: true })).toBeVisible();
  const catalogFilter = page.getByLabel(/filter catalog table/i);
  await expect(catalogFilter).toBeVisible();
  await catalogFilter.fill('ethereum');
  await expect(page.getByRole('cell', { name: /ETH.*Ethereum/i })).toBeVisible();
  await page.getByRole('button', { name: /refresh catalog/i }).click();
  await expect(catalogFilter).toHaveValue('');
  await expect(page.getByRole('button', { name: /save table to dashboard/i })).toBeVisible();
  const performanceRange = page.locator('#market-performance-range');
  await expect(performanceRange).toBeVisible();
  await expect(page.getByRole('button', { name: /save chart to dashboard/i })).toBeVisible();
  await performanceRange.selectOption('custom');
  await expect(page.locator('#market-performance-ago-value')).toBeVisible();
  await expect(page.locator('#market-performance-ago-unit')).toBeVisible();
  await performanceRange.selectOption('30d');
  await page.getByText(/scale bounds, display, events, and exports/i).click();
  const yAxisUnit = page.getByLabel(/y-axis unit/i);
  await expect(yAxisUnit).toBeVisible();
  await yAxisUnit.click();
  const yAxisSearch = page.getByLabel(/search y-axis currencies or crypto assets/i);
  await expect(yAxisSearch).toBeVisible();
  const expectedAxisOptions = await page.evaluate(async () => {
    const [settingsResponse, watchlistResponse] = await Promise.all([
      fetch('/api/settings'),
      fetch('/api/watchlist/assets')
    ]);
    const settings = (await settingsResponse.json()).settings as {
      primaryCurrency: string;
      tooltipCurrencies: string[];
    };
    const assets = (await watchlistResponse.json()).assets as Array<{
      symbol: string;
      name: string;
      enabled: boolean;
    }>;
    return {
      currencies: [...new Set([
        settings.primaryCurrency,
        ...settings.tooltipCurrencies
      ].map((currency) => currency.toUpperCase()))],
      assets: assets.filter((asset) => asset.enabled)
        .map((asset) => `${asset.symbol.toUpperCase()} · ${asset.name}`)
    };
  });
  const yAxisPopover = page.locator('.select-popover');
  for (const currency of expectedAxisOptions.currencies) {
    await expect(yAxisPopover.getByRole('option', {
      name: new RegExp(`^${currency} ·`)
    })).toBeVisible();
  }
  for (const asset of expectedAxisOptions.assets) {
    await expect(yAxisPopover.getByRole('option', { name: asset, exact: true })).toBeVisible();
  }
  await yAxisSearch.fill('primary');
  await expect(page.getByRole('option', { name: /primary currency/i })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(yAxisSearch).toBeHidden();
  const popupUnits = page.getByLabel(/popup units/i).first();
  await popupUnits.click();
  const popupUnitPopover = page.locator('.searchable-multi-select .select-popover').first();
  for (const asset of expectedAxisOptions.assets) {
    await expect(popupUnitPopover.getByRole('option', { name: asset, exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(page.getByLabel(/y scale/i).getByRole('option', { name: /logarithmic/i })).toBeEnabled();

  const inspector = page.getByRole('button', { name: /keyboard chart inspector/i });
  await expect(inspector).toBeVisible();
  await inspector.click();
  await expect(page.getByText(/keyboard inspection active/i)).toBeVisible();
  const scrollBeforeInspection = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('End');
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBeforeInspection);
  await inspector.click();
  await expect(page.getByText(/keyboard inspection active/i)).toBeHidden();
  await expect(inspector).toHaveAttribute('aria-expanded', 'false');
  await inspector.click();
  await expect(page.getByText(/keyboard inspection active/i)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText(/keyboard inspection active/i)).toBeHidden();

  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByText(/known portfolio value, watched markets/i)).toHaveCount(0);
  await expect(page.getByText(/latest successful check/i)).toHaveCount(0);
  await expect(page.getByLabel(/enable refresh/i)).toBeVisible();
  await page.getByLabel(/enable refresh/i).check();
  await page.getByLabel(/refresh interval/i).selectOption('120');
  await expect(page.getByLabel(/refresh interval/i)).toHaveValue('120');
  const fluffToggle = page.getByRole('button', { name: /remove fluff|show fluff/i });
  if (await fluffToggle.getAttribute('aria-pressed') === 'false') await fluffToggle.click();
  await expect(page.getByText(/each row has its own one-to-four-column layout/i)).toHaveCount(0);
  const optionsToggle = page.getByRole('button', { name: /show options|hide options/i });
  if (await optionsToggle.getAttribute('aria-pressed') === 'false') await optionsToggle.click();
  await page.getByRole('button', { name: /add dashboard row/i }).click();
  const rowColumns = page.getByLabel(/items per row/i).last();
  await rowColumns.selectOption('4');
  await expect(rowColumns).toHaveValue('4');

  await page.getByRole('link', { name: 'Kraken', exact: true }).click();
  await expect(page.getByRole('heading', { name: /staked value, rewards, and activity/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /payout distribution/i })).toBeVisible();
  const krakenChart = page.locator('section.chart-panel').filter({
    has: page.getByText('Kraken portfolio history', { exact: true })
  });
  await expect(krakenChart).toHaveAttribute(
    'data-effective-axis-option-count',
    String(expectedAxisOptions.assets.length)
  );
  await krakenChart.getByText(/scale bounds, display, events, and exports/i).click();
  await krakenChart.getByLabel(/y-axis unit/i).click();
  for (const asset of expectedAxisOptions.assets) {
    await expect(krakenChart.getByRole('option', { name: asset, exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await krakenChart.getByLabel(/popup units/i).click();
  for (const asset of expectedAxisOptions.assets) {
    await expect(krakenChart.getByRole('option', { name: asset, exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: 'Addresses', exact: true }).click();
  const addressNetwork = page.locator('#network');
  await expect(addressNetwork).toBeVisible();
  await expect(addressNetwork.getByRole('option', { name: /bitcoin mainnet/i })).toHaveCount(1);
  const addressChart = page.locator('section.chart-panel').filter({
    has: page.getByText('Address portfolio history', { exact: true })
  });
  await expect(addressChart).toHaveAttribute(
    'data-effective-axis-option-count',
    String(expectedAxisOptions.assets.length)
  );
  await addressChart.getByText(/scale bounds, display, events, and exports/i).click();
  await addressChart.getByLabel(/y-axis unit/i).click();
  for (const asset of expectedAxisOptions.assets) {
    await expect(addressChart.getByRole('option', { name: asset, exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await addressChart.getByLabel(/popup units/i).click();
  for (const asset of expectedAxisOptions.assets) {
    await expect(addressChart.getByRole('option', { name: asset, exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: /how far back each source has reached/i })).toBeVisible();
  await expect(page.getByText(/Forever \(default\)/i)).toBeVisible();
  await page.getByRole('button', { name: /collapse sync/i }).click();
  await expect(page.getByRole('heading', { name: /how far back each source has reached/i })).toBeHidden();
  await page.reload();
  const expandSync = page.getByRole('button', { name: /expand sync/i });
  await expect(expandSync).toBeVisible();
  await expect(page.getByRole('heading', { name: /how far back each source has reached/i })).toBeHidden();
  await expandSync.click();
  await expect(page.getByRole('heading', { name: /how far back each source has reached/i })).toBeVisible();

  const theme = page.getByLabel(/theme/i);
  await theme.selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
