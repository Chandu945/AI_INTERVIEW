import { expect, test } from '@playwright/test';
import { openApp, openInterview } from './helpers';

// Compares the main screens with saved screenshots, to catch unintended visual changes.
// After an intended change, refresh the saved images with: npm run test:update-screenshots

const SIZES = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };

for (const [name, size] of Object.entries(SIZES)) {
  test(`main screens look as expected (${name})`, async ({ page }) => {
    await page.setViewportSize(size);
    await openApp(page);
    // Whole-page shots, so they don't depend on scroll position. Cover the times ("5 min ago"), which change.
    const mask = [page.locator('.interview-time')];

    await expect(page.locator('.interview-row')).toHaveCount(2);
    await expect(page).toHaveScreenshot(`${name}-interviews.png`, { fullPage: true, mask });

    await page.getByRole('button', { name: '+ New interview' }).click();
    await expect(page).toHaveScreenshot(`${name}-new-interview.png`, { fullPage: true, mask });

    await page.getByRole('button', { name: 'Interviews', exact: true }).click();
    await openInterview(page, 'Markdown showcase');
    await expect(page).toHaveScreenshot(`${name}-interview.png`, { fullPage: true, mask });

    await page.getByRole('button', { name: 'Focus Mode' }).click();
    await expect(page).toHaveScreenshot(`${name}-focus-mode.png`, { fullPage: true, mask });
  });
}
