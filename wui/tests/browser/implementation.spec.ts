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
  const combinedAddressLabel = page.getByText('Combined addresses', { exact: true });
  await expect(combinedAddressLabel).toHaveCount(1);
  const chartTooltip = combinedAddressLabel.locator(
    'xpath=ancestor::div[contains(@style,"position: absolute")][1]'
  );
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
  ).toBeDisabled();
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
