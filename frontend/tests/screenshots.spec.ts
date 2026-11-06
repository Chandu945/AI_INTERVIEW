import { expect, test } from '@playwright/test';
import { openApp, openInterview } from './helpers';

// Compares the main screens with saved screenshots, to catch unintended visual changes.
// After an intended change, refresh the saved images with: npm run test:update-screenshots

const SIZES = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };

for (const [name, size] of Object.entries(SIZES)) {
  test(`main screens look as expected (${name})`, async ({ page }) => {
    await page.setViewportSize(size);
    await openApp(page);
    // Cover the "last updated" dates, which change from day to day.
    const mask = [page.locator('.history-card-open small')];

    await expect(page).toHaveScreenshot(`${name}-new-interview.png`, { fullPage: true, mask });

    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.locator('.history-card')).toHaveCount(2);
    await expect(page).toHaveScreenshot(`${name}-history.png`, { fullPage: true, mask });

    await openInterview(page, 'Markdown showcase');
    await expect(page).toHaveScreenshot(`${name}-interview.png`, { mask });

    await page.getByRole('button', { name: 'Focus Mode' }).click();
    await expect(page).toHaveScreenshot(`${name}-focus-mode.png`, { mask });
  });
}
