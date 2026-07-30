import { expect, test, type Page } from '@playwright/test';

test.skip(!process.env.PLAYWRIGHT_BASE_URL, 'Set PLAYWRIGHT_BASE_URL to run against the running application.');

const signIn = async (page: Page) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  if (await page.getByLabel('Username').isVisible()) {
    await page.getByLabel('Username').fill(process.env.PLAYWRIGHT_USERNAME ?? 'admin');
    await page.getByLabel('Password').fill(process.env.PLAYWRIGHT_PASSWORD ?? 'test-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await expect(page.getByRole('navigation')).toBeVisible();
};

test('chart warnings and selector edge styling render above the chart controls', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Markets', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Markets', exact: true })).toBeVisible();
  const expandMarketChart = page.getByRole('button', { name: 'Expand Market chart' });
  const wasCollapsed = await expandMarketChart.isVisible();
  if (wasCollapsed) await expandMarketChart.click();

  const dataWarning = page.getByRole('button', { name: 'Partial data notice' }).first();
  await expect(dataWarning).toBeVisible();
  expect(await dataWarning.evaluate((element) => (
    element.parentElement?.classList.contains('chart-toolbar')
    && element.parentElement.lastElementChild === element
  ))).toBe(true);
  const rangeControl = dataWarning.locator(
    'xpath=../div[./label[normalize-space()="Range"]]/select'
  );
  const [warningBounds, rangeBounds] = await Promise.all([
    dataWarning.boundingBox(),
    rangeControl.boundingBox()
  ]);
  expect(warningBounds).not.toBeNull();
  expect(rangeBounds).not.toBeNull();
  expect(Math.abs(
    warningBounds!.y + warningBounds!.height
    - (rangeBounds!.y + rangeBounds!.height)
  )).toBeLessThanOrEqual(1);
  await dataWarning.hover();
  const dataWarningTooltip = dataWarning.getByRole('tooltip');
  await expect(dataWarningTooltip).toBeVisible();
  expect(await dataWarningTooltip.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2
    ) === element;
  })).toBe(true);

  const chartPanel = dataWarning.locator('xpath=ancestor::section[contains(@class,"chart-panel")]');
  await chartPanel.getByText('Scale bounds, display, events, and exports', { exact: true }).click();
  for (const label of ['Left Y-Axis', 'Right Y-Axis', 'Popup units']) {
    expect(await chartPanel.getByLabel(label, { exact: true }).evaluate((element) => ({
      topGlint: getComputedStyle(element, '::before').display,
      bottomShade: getComputedStyle(element, '::after').display
    }))).toEqual({ topGlint: 'none', bottomShade: 'block' });
  }
  for (const label of ['Minimum', 'Maximum']) {
    expect(await chartPanel.getByLabel(label, { exact: true }).evaluate((element) => (
      getComputedStyle(element).boxShadow.includes('inset')
    ))).toBe(true);
  }

  if (wasCollapsed) {
    await page.getByRole('button', { name: 'Collapse Market chart' }).click();
  }
});

test('currency popup, refresh state, SHIB holdings, and Earn coverage work on real pages', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();

  const settings = await page.evaluate(async () => {
    const response = await fetch('/api/settings');
    return (await response.json()).settings as {
      primaryCurrency: string;
      tooltipCurrencies: string[];
    };
  });
  const expectedCurrencies = [...new Set([
    settings.primaryCurrency.toUpperCase(),
    ...settings.tooltipCurrencies.map((currency) => currency.toUpperCase())
  ])];

  const knownValue = page.getByRole('group', { name: /known portfolio:/i });
  await expect(knownValue).toBeVisible();
  await expect(page.getByRole('button', { name: /known portfolio:/i })).toHaveCount(0);
  await knownValue.focus();
  const popup = knownValue.getByRole('tooltip');
  await expect(popup).toBeVisible();
  await expect(popup.locator(':scope > span')).toHaveText(expectedCurrencies);
  await expect(popup).not.toContainText('unavailable');
  expect(await knownValue.evaluate((element) => getComputedStyle(element).userSelect)).toBe('text');
  expect(await popup.evaluate((element) => getComputedStyle(element).userSelect)).toBe('text');

  const knownCard = page.locator('article.card').filter({ hasText: 'Known portfolio' });
  const statusLine = knownCard.locator('.portfolio-value-status');
  await expect(statusLine).toContainText('priced known value');
  await expect(statusLine).toContainText(settings.primaryCurrency.toUpperCase());
  expect(await statusLine.evaluate((element) => getComputedStyle(element).display)).toBe('flex');

  const refreshToggle = page.getByLabel(/enable refresh/i);
  const refreshInterval = page.getByLabel(/refresh interval/i);
  const originalEnabled = await refreshToggle.isChecked();
  const originalInterval = await refreshInterval.inputValue();
  if (originalEnabled) await refreshToggle.uncheck();
  await expect(refreshInterval).toBeDisabled();
  const disabledStyle = await refreshInterval.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.backgroundColor, style.borderColor, style.boxShadow, style.transform];
  });
  await refreshInterval.dispatchEvent('mouseover');
  expect(await refreshInterval.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.backgroundColor, style.borderColor, style.boxShadow, style.transform];
  })).toEqual(disabledStyle);
  await refreshToggle.check();
  await expect(refreshInterval).toBeEnabled();
  await expect(refreshInterval.locator('option')).toHaveCount(7);
  await refreshInterval.selectOption('120');
  await page.reload();
  await expect(refreshToggle).toBeChecked();
  await expect(refreshInterval).toHaveValue('120');
  if (originalInterval !== '120') await refreshInterval.selectOption(originalInterval);
  if (!originalEnabled) await refreshToggle.uncheck();

  await page.getByRole('link', { name: 'Addresses', exact: true }).click();
  const shibRow = page.getByRole('row', { name: /ethereum SHIB Shiba Inu/i });
  await expect(shibRow).toBeVisible();
  await expect(shibRow).toContainText(/552[,\s]?733[,\s]?073/);
  await expect(shibRow).not.toContainText(`unpriced (${settings.primaryCurrency.toUpperCase()})`);
  const holdingsPanel = page.locator('section.panel').filter({
    has: page.getByRole('heading', { name: 'Quantity, priced value, and coverage' })
  });
  await expect(holdingsPanel.getByRole('columnheader', {
    name: `Current value (${settings.primaryCurrency.toUpperCase()})`
  })).toBeVisible();
  for (const currency of expectedCurrencies) {
    await expect(holdingsPanel.getByLabel(`Current value (${currency})`, {
      exact: true
    })).toHaveCount(1);
  }
  const addressHoldings = await page.evaluate(async () => {
    const response = await fetch('/api/addresses/holdings');
    return (await response.json()).holdings as Array<{ addressId: string; label: string }>;
  });
  const duplicateAddress = addressHoldings.find((holding, index, all) => (
    all.findIndex((candidate) => candidate.addressId === holding.addressId) !== index
  ));
  if (duplicateAddress) {
    await expect(holdingsPanel.getByText(duplicateAddress.label, { exact: true })).toHaveCount(1);
  }

  const chart = page.locator('.chart canvas').first();
  await expect(chart).toBeVisible();
  await page.getByRole('button', {
    name: /address portfolio history keyboard chart inspector/i
  }).click();
  await expect(page.getByText('Exact asset amounts', { exact: true })).toHaveCount(0);
  const addressChartSurface = page.locator('.chart[aria-label^="Address portfolio history"]');
  const chartTooltip = addressChartSurface.locator(
    ':scope > div[style*="position: absolute"]'
  );
  await expect(chartTooltip).toBeVisible();
  await expect(chartTooltip.getByText('Combined addresses', { exact: true })).toHaveCount(1);
  const tooltipText = await chartTooltip.innerText();
  expect(tooltipText.match(/Combined addresses/g)).toHaveLength(1);
  expect(tooltipText).not.toContain('native');
  for (const currency of expectedCurrencies) expect(tooltipText).toContain(currency);

  await page.getByRole('link', { name: 'Kraken', exact: true }).click();
  await expect(page.getByRole('heading', { name: /staked value, rewards, and activity/i })).toBeVisible();
  await expect(page.getByText(/balances are reconstructed|balance remains unknown|ledger is incomplete/i).first()).toBeVisible();
});

test('failed-job count has a visible unfiltered page of matching records', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  const expandSync = page.getByRole('button', { name: /expand sync/i });
  if (await expandSync.isVisible()) await expandSync.click();
  const progress = await page.evaluate(async () => {
    const response = await fetch('/api/sync/progress');
    return (await response.json()).progress as {
      failedJobs: { total: number; items: unknown[] };
    };
  });
  const summary = page.locator('details.failed-jobs > summary');
  await expect(summary).toContainText(`(${progress.failedJobs.total})`);
  if (progress.failedJobs.total > 0) {
    expect(progress.failedJobs.items.length).toBeGreaterThan(0);
    await expect(page.locator('details.failed-jobs tbody tr')).toHaveCount(
      progress.failedJobs.items.length
    );
    await expect(page.locator('details.failed-jobs .empty-table-cell')).toHaveCount(0);
  }
});

test('Kraken Earn rates, configured currencies, and chart inspection controls are visible', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Kraken', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Estimated APY history' })).toBeVisible();

  const settings = await page.evaluate(async () => {
    const response = await fetch('/api/settings');
    return (await response.json()).settings as {
      primaryCurrency: string;
      tooltipCurrencies: string[];
    };
  });
  const expectedCurrencies = [...new Set([
    settings.primaryCurrency,
    ...settings.tooltipCurrencies
  ].map((currency) => currency.toUpperCase()))];

  await expect(page.getByRole('columnheader', { name: 'Estimated APY' })).toBeVisible();
  for (const currency of expectedCurrencies) {
    await expect(page.getByRole('columnheader', {
      name: `Current value (${currency})`
    })).toBeVisible();
  }

  for (const label of [
    /Current known value:/i,
    /Currently staked value:/i,
    /Lifetime Earn rewards:/i
  ]) {
    const value = page.getByRole('group', { name: label });
    await value.focus();
    await expect(value.getByRole('tooltip').locator(':scope > span')).toHaveText(expectedCurrencies);
  }

  const portfolioPanel = page.locator('.chart-panel').filter({
    has: page.getByRole('button', {
      name: 'Kraken portfolio history keyboard chart inspector'
    })
  });
  const earnPanel = page.locator('.chart-panel').filter({
    has: page.locator('.chart[aria-label^="Kraken Earn history."]')
  });
  const assertRenderedWindow = async (panel: typeof portfolioPanel) => {
    await expect(panel).toHaveAttribute('data-chart-axis', 'time');
    await expect(panel).not.toHaveAttribute('data-rendered-range-from-ms', '');
    await expect(panel).not.toHaveAttribute('data-rendered-range-to-ms', '');
    const renderedDays = await panel.evaluate((element) => (
      (
        Number(element.getAttribute('data-rendered-range-to-ms'))
        - Number(element.getAttribute('data-rendered-range-from-ms'))
      ) / 86_400_000
    ));
    const selectedRange = await panel.getByLabel('Range', { exact: true }).inputValue();
    const expectedDays = new Map([
      ['24h', 1],
      ['7d', 7],
      ['30d', 30],
      ['90d', 90],
      ['1y', 365],
      ['4y', 4 * 365]
    ]).get(selectedRange);
    if (expectedDays === undefined) expect(renderedDays).toBeGreaterThan(0);
    else expect(renderedDays).toBeCloseTo(expectedDays, 3);
  };
  await assertRenderedWindow(portfolioPanel);
  await assertRenderedWindow(earnPanel);
  const showAll = portfolioPanel.getByLabel(
    'Show all, including disabled/inactive, in popup'
  );
  await expect(showAll).toBeVisible();
  await expect(showAll).not.toBeChecked();
  const totalToggle = page.getByRole('button', {
    name: 'Toggle Kraken total on the Kraken chart'
  });
  const totalWasSelected = await totalToggle.getAttribute('aria-pressed') === 'true';
  if (!totalWasSelected) {
    await totalToggle.click();
    await expect(totalToggle).toHaveAttribute('aria-pressed', 'true');
  }
  await page.getByRole('button', {
    name: 'Kraken portfolio history keyboard chart inspector'
  }).click();
  const chartSurface = page.locator('.chart[aria-label^="Kraken portfolio history"]');
  const tooltip = chartSurface.locator(':scope > div[style*="position: absolute"]');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('Kraken total');
  await expect(tooltip).not.toContainText('Exact asset amounts');
  await expect(tooltip).not.toContainText('native');
  const [chartBox, tooltipBox] = await Promise.all([
    chartSurface.boundingBox(),
    tooltip.boundingBox()
  ]);
  expect(chartBox).not.toBeNull();
  expect(tooltipBox).not.toBeNull();
  expect(tooltipBox!.x).toBeGreaterThanOrEqual(chartBox!.x + 80);
  expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(chartBox!.x + chartBox!.width - 20);

  await expect(
    page.locator('#kraken-earn-history-granularity option[value="3600"]')
  ).toBeEnabled();
  await expect(page.locator('.chart[aria-label*="Click or focus to enable horizontal time navigation"]').first())
    .toBeVisible();
  if (!totalWasSelected) {
    await totalToggle.click();
    await expect(totalToggle).toHaveAttribute('aria-pressed', 'false');
  }
});

test('saving failed-job retention omits unrelated legacy dashboard data', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  const expandPreferences = page.getByRole('button', { name: /expand preferences/i });
  if (await expandPreferences.isVisible()) await expandPreferences.click();

  const currentSettings = await page.evaluate(async () => {
    const response = await fetch('/api/settings');
    return (await response.json()).settings as Record<string, unknown>;
  });
  let submitted: Record<string, unknown> | null = null;
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.continue();
      return;
    }
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        settings: { ...currentSettings, ...submitted }
      })
    });
  });
  page.on('dialog', (dialog) => void dialog.accept());

  const retention = page.getByLabel('Remove failed synchronization jobs after');
  await expect(retention).toBeVisible();
  await retention.selectOption('168');
  await expect(retention).toHaveValue('168');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText(/Settings saved/)).toBeVisible();

  expect(submitted).not.toBeNull();
  expect(submitted!.failedJobRetentionHours).toBe(168);
  expect(submitted).not.toHaveProperty('savedGraphs');
  expect(submitted).not.toHaveProperty('dashboardRows');
});

test('dashboard graph editing restores display state and replacement keeps its identity', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const fixture = await page.evaluate(async () => {
    const [settingsResponse, assetsResponse, meResponse] = await Promise.all([
      fetch('/api/settings'),
      fetch('/api/watchlist/assets'),
      fetch('/api/me')
    ]);
    const settings = (await settingsResponse.json()).settings as {
      primaryCurrency: string;
      tooltipCurrencies: string[];
      timezone: string;
      savedGraphs: Array<Record<string, unknown>>;
      dashboardRows: Array<Record<string, unknown>>;
      graphDefaults: Record<string, unknown>;
    };
    const assets = (await assetsResponse.json()).assets as Array<{
      canonicalId: string;
      enabled: boolean;
    }>;
    const csrfToken = String((await meResponse.json()).csrfToken);
    const assetIds = assets.filter((asset) => asset.enabled)
      .map((asset) => asset.canonicalId)
      .slice(0, 2);
    const id = `browser-chart-edit-${Date.now()}`;
    const name = `Browser chart edit ${Date.now()}`;
    const original = {
      savedGraphs: settings.savedGraphs,
      dashboardRows: settings.dashboardRows,
      graphDefaults: settings.graphDefaults
    };
    if (assetIds.length < 2) {
      return {
        id,
        name,
        assetIds,
        rightYAxisUnit: settings.primaryCurrency,
        original,
        created: false
      };
    }
    const graph = {
      id,
      name,
      type: 'market',
      hidden: false,
      config: {
        assetIds,
        source: 'combined',
        primaryCurrency: settings.primaryCurrency,
        tooltipCurrencies: settings.tooltipCurrencies,
        timezone: settings.timezone,
        range: '30d',
        granularity: '86400',
        chartMode: 'candlestick',
        scale: 'linear',
        normalized: false,
        showEvents: true,
        showVolume: false,
        yAxisUnit: settings.primaryCurrency,
        tooltipUnits: [settings.primaryCurrency],
        visibleSeriesIds: assetIds,
        leftYAxisSeriesIds: [assetIds[0]],
        rightYAxisUnit: settings.primaryCurrency,
        rightYAxisSeriesIds: [assetIds[1]],
        leftYAxisLineColor: '#112233',
        rightYAxisLineColor: '#445566'
      }
    };
    const response = await fetch('/api/settings', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrfToken
      },
      body: JSON.stringify({
        savedGraphs: [...settings.savedGraphs, graph]
      })
    });
    if (!response.ok) throw new Error(`Fixture save failed: ${response.status}`);
    return {
      id,
      name,
      assetIds,
      rightYAxisUnit: settings.primaryCurrency,
      original,
      created: true
    };
  });
  test.skip(!fixture.created, 'Two enabled market assets are required.');

  try {
    await page.goto('/dashboard', { waitUntil: 'networkidle' });
    const expandGraphs = page.getByRole('button', { name: 'Expand graphs' });
    if (await expandGraphs.isVisible()) await expandGraphs.click();
    const showFluff = page.getByRole('button', { name: 'Show fluff', exact: true });
    if (await showFluff.isVisible()) await showFluff.click();
    await expect(page.getByRole('button', { name: 'Hide fluff', exact: true })).toBeVisible();

    const card = page.locator('article.saved-chart').filter({
      has: page.getByRole('heading', { name: fixture.name, exact: true })
    });
    await expect(card).toBeVisible();
    await expect(card.getByRole('link', { name: 'Edit', exact: true })).toBeVisible();
    await card.getByRole('link', { name: 'Edit', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/markets\\?[^#]*editGraph=${fixture.id}#market-price-chart`));

    const chartPanel = page.locator('#market-price-chart .chart-panel');
    await expect(chartPanel).toBeVisible();
    await expect(chartPanel.getByLabel('Mode', { exact: true })).toHaveValue('candlestick');
    await expect(chartPanel).toHaveAttribute('data-visible-series-count', '2');
    await expect(chartPanel).toHaveAttribute('data-left-y-axis-series-count', '1');
    await expect(chartPanel).toHaveAttribute('data-right-y-axis-series-count', '1');
    await expect(chartPanel).toHaveAttribute('data-rendered-candlestick-series-count', '2');
    await expect(chartPanel).toHaveAttribute(
      'data-right-y-axis-unit',
      fixture.rightYAxisUnit
    );

    const chartOptions = chartPanel.locator('details.chart-options');
    if (await chartOptions.getAttribute('open') === null) {
      await chartPanel.getByText('Scale bounds, display, events, and exports', {
        exact: true
      }).click();
    }
    const leftAxisControl = chartPanel.getByLabel('Left Y-Axis', { exact: true });
    const rightAxisControl = chartPanel.getByLabel('Right Y-Axis', { exact: true });
    const leftLinesControl = chartPanel.getByLabel('Left displayed lines', { exact: true });
    const rightLinesControl = chartPanel.getByLabel('Right displayed lines', { exact: true });
    const leftLineColorControl = chartPanel.getByLabel(
      'Left horizontal line color',
      { exact: true }
    );
    const rightLineColorControl = chartPanel.getByLabel(
      'Right horizontal line color',
      { exact: true }
    );
    const popupUnitsControl = chartPanel.getByLabel('Popup units', { exact: true });
    const minimumControl = chartPanel.getByLabel('Minimum', { exact: true });
    const maximumControl = chartPanel.getByLabel('Maximum', { exact: true });
    const leftAxisBoxes = await Promise.all([
      leftAxisControl.boundingBox(),
      leftLinesControl.boundingBox(),
      leftLineColorControl.boundingBox()
    ]);
    const rightAxisBoxes = await Promise.all([
      rightAxisControl.boundingBox(),
      rightLinesControl.boundingBox(),
      rightLineColorControl.boundingBox()
    ]);
    const lowerControlBoxes = await Promise.all([
      popupUnitsControl.boundingBox(),
      minimumControl.boundingBox(),
      maximumControl.boundingBox()
    ]);
    expect(leftAxisBoxes.every(Boolean)).toBe(true);
    expect(rightAxisBoxes.every(Boolean)).toBe(true);
    expect(lowerControlBoxes.every(Boolean)).toBe(true);
    expect(Math.max(...leftAxisBoxes.map((box) => box!.y))
      - Math.min(...leftAxisBoxes.map((box) => box!.y))).toBeLessThan(3);
    expect(Math.min(...rightAxisBoxes.map((box) => box!.y)))
      .toBeGreaterThan(Math.max(...leftAxisBoxes.map((box) => box!.y)));
    expect(Math.max(...rightAxisBoxes.map((box) => box!.y))
      - Math.min(...rightAxisBoxes.map((box) => box!.y))).toBeLessThan(3);
    expect(Math.min(...lowerControlBoxes.map((box) => box!.y)))
      .toBeGreaterThan(Math.max(...rightAxisBoxes.map((box) => box!.y)));
    await expect(leftLineColorControl).toHaveValue('#112233');
    await expect(rightLineColorControl).toHaveValue('#445566');

    await leftAxisControl.click();
    const leftAxisOptions = await chartPanel.locator(
      '#watched-market-prices-left-y-axis-unit-listbox [role="option"]'
    ).allTextContents();
    await leftAxisControl.click();
    await rightAxisControl.click();
    const rightAxisOptions = await chartPanel.locator(
      '#watched-market-prices-right-y-axis-unit-listbox [role="option"]'
    ).allTextContents();
    await rightAxisControl.click();
    expect(rightAxisOptions.slice(1)).toEqual(leftAxisOptions);

    await leftAxisControl.click();
    const selectedCandlestickUnit = fixture.assetIds[0]!;
    const selectedCandlestickUnitOptionId = selectedCandlestickUnit
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-');
    await chartPanel.locator(
      `#watched-market-prices-left-y-axis-unit-option-${selectedCandlestickUnitOptionId}`
    ).click();
    await expect(chartPanel).toHaveAttribute(
      'data-left-y-axis-unit',
      selectedCandlestickUnit
    );
    await expect(chartPanel).toHaveAttribute('data-rendered-candlestick-series-count', '2');

    await leftLinesControl.click();
    await chartPanel.locator(
      `#watched-market-prices-left-displayed-series-option-${fixture.assetIds[0]}`
    ).click();
    await leftLinesControl.click();
    await expect(chartPanel).toHaveAttribute('data-visible-series-count', '1');
    await expect(chartPanel).toHaveAttribute('data-left-y-axis-series-count', '0');
    await expect(chartPanel).toHaveAttribute('data-right-y-axis-series-count', '1');
    await expect(chartPanel).toHaveAttribute(
      'data-right-y-axis-unit',
      fixture.rightYAxisUnit
    );
    await expect(chartPanel.locator('.chart')).toHaveAttribute('aria-busy', 'false');

    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('already exists');
      await dialog.accept();
    });
    const saveButton = chartPanel.getByRole('button', { name: 'Save to dashboard' });
    await expect(saveButton).toBeVisible();
    await saveButton.click();
    await expect(page.getByText(`Saved “${fixture.name}” to the dashboard.`)).toBeVisible();
    const replaced = await page.evaluate(async (id) => {
      const response = await fetch('/api/settings');
      const settings = (await response.json()).settings as {
        savedGraphs: Array<{
          id: string;
          config: Record<string, unknown>;
        }>;
      };
      return settings.savedGraphs.find((graph) => graph.id === id) ?? null;
    }, fixture.id);
    expect(replaced).not.toBeNull();
    expect(replaced!.config.yAxisUnit).toBe(fixture.assetIds[0]);
    expect(replaced!.config.visibleSeriesIds).toEqual([fixture.assetIds[1]]);
    expect(replaced!.config.leftYAxisSeriesIds).toEqual([]);
    expect(replaced!.config.rightYAxisUnit).toBe(fixture.rightYAxisUnit);
    expect(replaced!.config.rightYAxisSeriesIds).toEqual([fixture.assetIds[1]]);
    expect(replaced!.config.leftYAxisLineColor).toBe('#112233');
    expect(replaced!.config.rightYAxisLineColor).toBe('#445566');

    await page.goto('/dashboard', { waitUntil: 'networkidle' });
    const expandGraphsAgain = page.getByRole('button', { name: 'Expand graphs' });
    if (await expandGraphsAgain.isVisible()) await expandGraphsAgain.click();
    const showFluffAgain = page.getByRole('button', { name: 'Show fluff', exact: true });
    if (await showFluffAgain.isVisible()) await showFluffAgain.click();
    await expect(page.getByRole('button', { name: 'Hide fluff', exact: true })).toBeVisible();
    const replacedCard = page.locator('article.saved-chart').filter({
      has: page.getByRole('heading', { name: fixture.name, exact: true })
    });
    page.once('dialog', async (dialog) => {
      await dialog.dismiss();
    });
    await replacedCard.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(replacedCard).toBeVisible();
    page.once('dialog', async (dialog) => {
      await dialog.accept();
    });
    await replacedCard.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(replacedCard).toBeHidden();
  } finally {
    if (!page.isClosed()) await page.evaluate(async (original) => {
      const meResponse = await fetch('/api/me');
      const csrfToken = String((await meResponse.json()).csrfToken);
      await fetch('/api/settings', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrfToken
        },
        body: JSON.stringify(original)
      });
    }, fixture.original);
  }
});
