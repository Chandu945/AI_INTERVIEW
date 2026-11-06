import { expect, test } from '@playwright/test';
import { chatRequests, forgetRequests, openApp, openInterview } from './helpers';

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

test('hands-free sending is off by default: a pause only stops the mic', async ({ page }) => {
  const autoSend = page.getByLabel(/send the question automatically/);
  await expect(autoSend).toBeDisabled();
  await expect(autoSend).not.toBeChecked();
  await page.getByLabel(/Stop listening after 2.2s/).check();
  await expect(autoSend).toBeEnabled();
  await forgetRequests(page);
  await page.locator('.mic-btn').click();
  await page.evaluate(() => window.__say('just a draft'));
  await expect(page.locator('.mic-btn')).toContainText('Start speaking', { timeout: 4_000 });
  await expect(page.getByLabel('Your message')).toHaveValue('just a draft');
  expect(await chatRequests(page)).toBe(0);
});

test('with hands-free sending on, a pause sends the question', async ({ page }) => {
  await page.evaluate(() => window.__streams(50, 5)); // a short fake answer, so the question stays on screen
  await page.getByLabel(/Stop listening after 2.2s/).check();
  await page.getByLabel(/send the question automatically/).check();
  await forgetRequests(page);
  await page.locator('.mic-btn').click();
  await page.evaluate(() => window.__say('what is a closure'));
  await expect(page.locator('.message.user').last()).toContainText('what is a closure', { timeout: 5_000 });
  await expect(page.locator('.mic-btn')).toContainText('Start speaking');
  expect(await chatRequests(page)).toBe(1);
});
