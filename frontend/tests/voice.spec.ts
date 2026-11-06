import { expect, test } from '@playwright/test';
import { openApp, openInterview } from './helpers';

// Speech recognition is faked (see helpers.ts), so window.__say() stands in for speaking.

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await openInterview(page, 'Demo interview');
});

test('turning auto-stop on while the mic is on stops it after the pause', async ({ page }) => {
  const mic = page.locator('.mic-btn');
  await mic.click();
  await expect(mic).toContainText('Stop listening');
  await page.evaluate(() => window.__say('hello there'));
  await page.getByLabel(/Stop listening after 2.2s/).check();
  await expect(mic).toContainText('Start speaking', { timeout: 4_000 });
  await expect(page.getByLabel('Your message')).toHaveValue('hello there');
});

test('turning auto-stop off while the mic is on keeps it listening', async ({ page }) => {
  const mic = page.locator('.mic-btn');
  const autoStop = page.getByLabel(/Stop listening after 2.2s/);
  await autoStop.check();
  await mic.click();
  await page.evaluate(() => window.__say('second part')); // starts the 2.2 s countdown
  await page.waitForTimeout(500);
  await autoStop.uncheck();
  await page.waitForTimeout(3_000);
  await expect(mic).toContainText('Stop listening');
  await mic.click();
  await expect(mic).toContainText('Start speaking');
});
