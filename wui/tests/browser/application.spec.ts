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
  await page.waitForLoadState('networkidle');
  for (const block of ['Market chart', 'Performance analytics', 'Watchlist']) {
    const expand = page.getByRole('button', { name: `Expand ${block}` });
    if (await expand.isVisible()) await expand.click();
  }
  const catalogFilter = page.getByLabel(/filter catalog table/i);
  const watchlistPanel = page.locator('#market-asset-catalog');
  await expect(catalogFilter).toBeVisible();
  await expect(page.getByText('Visible chart assets', { exact: true })).toHaveCount(0);
  const backfillButton = watchlistPanel.getByRole('button', {
    name: 'Queue backfill',
    exact: true
  });
  const sourceControl = watchlistPanel.getByLabel('Price source', { exact: true });
  const refreshCatalogButton = watchlistPanel.getByRole('button', {
    name: 'Refresh catalog',
    exact: true
  });
  await expect(backfillButton).toBeVisible();
  await expect(sourceControl).toBeVisible();
  const [sourceBounds, backfillBounds, filterBounds, refreshBounds] = await Promise.all([
    sourceControl.boundingBox(),
    backfillButton.boundingBox(),
    catalogFilter.boundingBox(),
    refreshCatalogButton.boundingBox()
  ]);
  expect([sourceBounds, backfillBounds, filterBounds, refreshBounds].every(Boolean)).toBe(true);
  expect(Math.abs(
    sourceBounds!.y + sourceBounds!.height
    - (backfillBounds!.y + backfillBounds!.height)
  )).toBeLessThanOrEqual(1);
  expect(sourceBounds!.y).toBeLessThan(filterBounds!.y);
  expect(Math.abs(
    filterBounds!.y + filterBounds!.height
    - (refreshBounds!.y + refreshBounds!.height)
  )).toBeLessThanOrEqual(1);
  await catalogFilter.fill('ethereum');
  await expect(page.getByRole('cell', { name: /ETH.*Ethereum/i })).toBeVisible();
  await page.getByRole('button', { name: /refresh catalog/i }).click();
  await expect(catalogFilter).toHaveValue('');
  await expect(page.getByRole('button', { name: /save table to dashboard/i })).toBeVisible();
  const marketPerformance = page.locator('#market-performance-chart .performance-panel');
  const marketPerformanceOptions = marketPerformance.locator('details.performance-options');
  const marketPerformanceOptionsSummary = marketPerformance.getByText(
    'Performance range, display, and dashboard options',
    { exact: true }
  );
  const performanceRange = page.locator('#market-performance-range');
  await expect(marketPerformanceOptionsSummary).toBeVisible();
  if (await marketPerformanceOptions.getAttribute('open') !== null) {
    await marketPerformanceOptionsSummary.click();
  }
  await expect(performanceRange).toBeHidden();
  await marketPerformanceOptionsSummary.click();
  await expect(performanceRange).toBeVisible();
  await expect(page.getByRole('button', { name: /save chart to dashboard/i })).toBeVisible();
  for (const label of [
    'Left Y-Axis',
    'Left displayed lines',
    'Left horizontal line color',
    'Right Y-Axis',
    'Right displayed lines',
    'Right horizontal line color',
    'Popup units',
    'Minimum',
    'Maximum'
  ]) {
    await expect(marketPerformance.getByLabel(label, { exact: true })).toBeVisible();
  }
  const [
    performanceLeftBounds,
    performanceRightBounds,
    performancePopupBounds
  ] = await Promise.all([
    marketPerformance.getByLabel('Left Y-Axis', { exact: true }).boundingBox(),
    marketPerformance.getByLabel('Right Y-Axis', { exact: true }).boundingBox(),
    marketPerformance.getByLabel('Popup units', { exact: true }).boundingBox()
  ]);
  expect(performanceLeftBounds).not.toBeNull();
  expect(performanceRightBounds).not.toBeNull();
  expect(performancePopupBounds).not.toBeNull();
  expect(performanceRightBounds!.y).toBeGreaterThan(performanceLeftBounds!.y);
  expect(performancePopupBounds!.y).toBeGreaterThan(performanceRightBounds!.y);
  await performanceRange.selectOption('custom');
  await expect(page.locator('#market-performance-ago-value')).toBeVisible();
  await expect(page.locator('#market-performance-ago-unit')).toBeVisible();
  await performanceRange.selectOption('30d');
  const marketPerformanceChart = marketPerformance.locator('.chart-panel');
  await expect(marketPerformanceChart).toHaveAttribute(
    'data-visible-series-count',
    /^[1-9]\d*$/
  );
  await expect(marketPerformanceChart.locator('.chart-empty')).toHaveCount(0);
  const marketChart = page.locator('#market-price-chart .chart-panel');
  const marketChartOptions = marketChart.locator('details.chart-options');
  if (await marketChartOptions.getAttribute('open') === null) {
    await marketChart.getByText(/scale bounds, display, events, and exports/i).click();
  }
  const yAxisUnit = marketChart.getByLabel(/left y-axis/i);
  await expect(yAxisUnit).toBeVisible();
  await yAxisUnit.click();
  const yAxisSearch = page.getByLabel(/search left y-axis currencies or crypto assets/i);
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
  const yAxisPopover = marketChart.locator('.select-popover');
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
  const popupUnits = marketChart.getByLabel(/popup units/i);
  await popupUnits.click();
  const popupUnitPopover = marketChart.locator('.searchable-multi-select .select-popover');
  for (const asset of expectedAxisOptions.assets) {
    await expect(popupUnitPopover.getByRole('option', { name: asset, exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(marketChart.getByLabel(/y scale/i).getByRole('option', { name: /logarithmic/i })).toBeEnabled();
  for (const label of [
    'Left displayed lines',
    'Left horizontal line color',
    'Right displayed lines',
    'Right horizontal line color'
  ]) {
    await expect(marketChart.getByLabel(label, { exact: true })).toBeVisible();
  }
  const visibleSeriesCount = await marketChart.getAttribute('data-visible-series-count');
  expect(Number(visibleSeriesCount)).toBeGreaterThan(0);
  const visibleLineStyles = marketChart.getByText(
    `Visible line styles (${visibleSeriesCount})`,
    { exact: true }
  );
  await expect(visibleLineStyles).toBeVisible();
  await visibleLineStyles.click();
  await expect(marketChart.getByLabel('Line type', { exact: true }).first()).toBeVisible();
  await expect(marketChart.getByLabel('Color', { exact: true }).first()).toBeVisible();
  await expect(marketChart.getByLabel('Thickness', { exact: true }).first()).toBeVisible();

  const inspector = marketChart.getByRole('button', { name: /keyboard chart inspector/i });
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
  await page.waitForLoadState('networkidle');
  await expect(page.getByText(/known portfolio value, watched markets/i)).toHaveCount(0);
  await expect(page.getByText(/latest successful check/i)).toHaveCount(0);
  await expect(page.getByLabel(/enable refresh/i)).toBeVisible();
  await page.getByLabel(/enable refresh/i).check();
  await page.getByLabel(/refresh interval/i).selectOption('120');
  await expect(page.getByLabel(/refresh interval/i)).toHaveValue('120');
  const minimalToggle = page.getByLabel(/minimal mode/i);
  await expect(minimalToggle).toBeVisible();
  if (await minimalToggle.isChecked()) await minimalToggle.uncheck();
  const fluffToggle = page.getByRole('button', { name: /hide fluff|show fluff/i });
  if (await fluffToggle.getAttribute('aria-pressed') === 'true') await fluffToggle.click();
  const optionsToggle = page.getByRole('button', { name: /show options|hide options/i });
  if (await optionsToggle.getAttribute('aria-pressed') === 'false') await optionsToggle.click();
  await minimalToggle.check();
  await expect(page.getByText(/each row has its own one-to-four-column layout/i)).toHaveCount(0);
  await expect(fluffToggle).toHaveCount(0);
  await expect(optionsToggle).toHaveCount(0);
  await expect(page.getByRole('button', { name: /move summary (up|down)/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /collapse summary/i })).toHaveCount(0);
  const topbar = page.locator('header.topbar');
  const dashboardControls = page.locator('[data-dashboard-top-controls]');
  const dashboardControlsBox = await dashboardControls.boundingBox();
  expect(dashboardControlsBox).not.toBeNull();
  const revealBoundary = dashboardControlsBox!.y + dashboardControlsBox!.height + 100;
  await page.mouse.move(10, revealBoundary + 20);
  await expect(topbar).toHaveAttribute('aria-hidden', 'true');
  const hiddenMinimalBox = await minimalToggle.boundingBox();
  await page.mouse.move(10, revealBoundary - 50);
  await expect(topbar).toHaveAttribute('aria-hidden', 'false');
  const revealedMinimalBox = await minimalToggle.boundingBox();
  expect(hiddenMinimalBox).not.toBeNull();
  expect(revealedMinimalBox).not.toBeNull();
  expect(revealedMinimalBox!.y).toBeGreaterThan(hiddenMinimalBox!.y);
  await page.keyboard.press('Escape');
  await expect(minimalToggle).not.toBeChecked();
  await expect(topbar).toHaveAttribute('aria-hidden', 'false');
  const restoredOptionsToggle = page.getByRole('button', { name: /show options|hide options/i });
  if (await restoredOptionsToggle.getAttribute('aria-pressed') === 'false') {
    await restoredOptionsToggle.click();
  }
  await page.getByRole('button', { name: /add dashboard row/i }).click();
  const rowColumns = page.getByLabel(/items per row/i).last();
  await rowColumns.selectOption('4');
  await expect(rowColumns).toHaveValue('4');

  await page.getByRole('link', { name: 'Kraken', exact: true }).click();
  await expect(page.getByRole('heading', { name: /staked value, rewards, and activity/i })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const expandKrakenChart = page.getByRole('button', { name: /expand chart/i });
  if (await expandKrakenChart.isVisible()) await expandKrakenChart.click();
  await expect(page.getByRole('heading', { name: /payout distribution/i })).toBeVisible();
  const krakenChart = page.locator(
    'section.chart-panel[aria-label="Kraken portfolio history"]'
  );
  await expect(krakenChart).toHaveAttribute(
    'data-effective-axis-option-count',
    String(expectedAxisOptions.assets.length)
  );
  const krakenChartOptions = krakenChart.locator('details.chart-options');
  if (await krakenChartOptions.getAttribute('open') === null) {
    await krakenChart.getByText(/scale bounds, display, events, and exports/i).click();
  }
  for (const label of [
    'Left displayed lines',
    'Left horizontal line color',
    'Right displayed lines',
    'Right horizontal line color'
  ]) {
    await expect(krakenChart.getByLabel(label, { exact: true })).toBeVisible();
  }
  for (const axisLabel of [/left y-axis/i, /right y-axis/i]) {
    await krakenChart.getByLabel(axisLabel).click();
    for (const asset of expectedAxisOptions.assets) {
      await expect(krakenChart.getByRole('option', { name: asset, exact: true })).toBeVisible();
    }
    await page.keyboard.press('Escape');
  }
  await krakenChart.getByLabel(/popup units/i).click();
  for (const asset of expectedAxisOptions.assets) {
    await expect(krakenChart.getByRole('option', { name: asset, exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: 'Addresses', exact: true }).click();
  await page.waitForLoadState('networkidle');
  const expandAddressChart = page.getByRole('button', { name: /expand chart/i });
  if (await expandAddressChart.isVisible()) await expandAddressChart.click();
  const addressNetwork = page.locator('#network');
  await expect(addressNetwork).toBeVisible();
  await expect(addressNetwork.getByRole('option', { name: /bitcoin mainnet/i })).toHaveCount(1);
  const addressChart = page.locator(
    'section.chart-panel[aria-label="Address portfolio history"]'
  );
  await expect(addressChart).toHaveAttribute(
    'data-effective-axis-option-count',
    String(expectedAxisOptions.assets.length)
  );
  const addressChartOptions = addressChart.locator('details.chart-options');
  if (await addressChartOptions.getAttribute('open') === null) {
    await addressChart.getByText(/scale bounds, display, events, and exports/i).click();
  }
  for (const label of [
    'Left displayed lines',
    'Left horizontal line color',
    'Right displayed lines',
    'Right horizontal line color'
  ]) {
    await expect(addressChart.getByLabel(label, { exact: true })).toBeVisible();
  }
  for (const axisLabel of [/left y-axis/i, /right y-axis/i]) {
    await addressChart.getByLabel(axisLabel).click();
    for (const asset of expectedAxisOptions.assets) {
      await expect(addressChart.getByRole('option', { name: asset, exact: true })).toBeVisible();
    }
    await page.keyboard.press('Escape');
  }
  await addressChart.getByLabel(/popup units/i).click();
  for (const asset of expectedAxisOptions.assets) {
    await expect(addressChart.getByRole('option', { name: asset, exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: /how far back each source has reached/i })).toBeVisible();
  await expect(page.getByRole('option', { name: /Forever \(default\)/i })).toHaveCount(1);
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
