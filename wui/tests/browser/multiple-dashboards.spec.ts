import { expect, test, type Page } from '@playwright/test';

test.skip(!process.env.PLAYWRIGHT_BASE_URL, 'Set PLAYWRIGHT_BASE_URL to run against the application.');

const signIn = async (page: Page) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByLabel('Username').fill(process.env.PLAYWRIGHT_USERNAME ?? 'admin');
  await page.getByLabel('Password').fill(process.env.PLAYWRIGHT_PASSWORD ?? 'test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
};

test('manages, loads, and safely cycles numbered dashboards', async ({ page }) => {
  await signIn(page);
  await page.goto('/dashboard?dashboard=99', { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/[?&]dashboard=1(?:&|$)/);

  const minimal = page.getByLabel('Minimal mode', { exact: true });
  if (await minimal.isChecked()) await minimal.uncheck();

  const sectionLabels = page.locator('.reorderable-block > .block-order > span');
  const dashboard1Order = await sectionLabels.allTextContents();
  const dashboardButtons = page.getByRole('button', { name: /open dashboard \d+/i });
  const initialCount = await dashboardButtons.count();
  await page.getByRole('button', { name: 'Add dashboard', exact: true }).click();
  await expect(dashboardButtons).toHaveCount(initialCount + 1);
  await expect(page).toHaveURL(new RegExp(`[?&]dashboard=${initialCount + 1}(?:&|$)`));

  const graphsIndex = dashboard1Order.indexOf('graphs');
  expect(graphsIndex).toBeGreaterThan(0);
  const dashboard2Order = [...dashboard1Order];
  [dashboard2Order[graphsIndex - 1], dashboard2Order[graphsIndex]] = [
    dashboard2Order[graphsIndex]!,
    dashboard2Order[graphsIndex - 1]!
  ];
  const layoutSaved = page.waitForResponse((response) => (
    response.url().endsWith('/api/settings')
      && response.request().method() === 'PATCH'
      && response.ok()
  ));
  await page.getByRole('button', { name: 'Move graphs up', exact: true }).click();
  await layoutSaved;
  await expect(sectionLabels).toHaveText(dashboard2Order);
  await dashboardButtons.first().click();
  await expect(sectionLabels).toHaveText(dashboard1Order);
  await dashboardButtons.nth(initialCount).click();
  await expect(sectionLabels).toHaveText(dashboard2Order);
  await page.reload({ waitUntil: 'networkidle' });
  await expect(sectionLabels).toHaveText(dashboard2Order);

  await minimal.check();
  await expect(page.getByLabel('Cycle', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Cycle interval', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add dashboard', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove dashboard', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await dashboardButtons.first().click();
  await page.clock.install();
  await page.getByLabel('Cycle', { exact: true }).check();
  await page.getByLabel('Cycle interval', { exact: true }).selectOption('10');
  await page.clock.fastForward(9_500);
  await page.mouse.move(40, 40);
  await page.clock.fastForward(5_000);
  await expect(page).toHaveURL(/[?&]dashboard=1(?:&|$)/);
  await page.clock.fastForward(5_100);
  await expect(page).toHaveURL(/[?&]dashboard=2(?:&|$)/);

  await page.getByLabel('Cycle', { exact: true }).uncheck();
  await page.goto(`/dashboard?dashboard=${initialCount + 1}`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('button', {
    name: `Open dashboard ${initialCount + 1}`,
    exact: true
  }))
    .toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Move dashboard left', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]dashboard=${initialCount}(?:&|$)`));
  await page.getByRole('button', { name: 'Move dashboard right', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]dashboard=${initialCount + 1}(?:&|$)`));

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Remove dashboard', exact: true }).click();
  await expect(dashboardButtons).toHaveCount(initialCount);
  await expect(page).toHaveURL(new RegExp(`[?&]dashboard=${initialCount}(?:&|$)`));
});
