import { expect, test } from '@playwright/test';
import { API, chatRequests, forgetRequests, interviewId, openApp, openInterview } from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await openInterview(page, 'Demo interview');
});

test('Cmd+Enter sends from the interview page only, never a leftover draft from History', async ({ page }) => {
  await page.getByLabel('Your message').fill('leftover draft that should not be sent');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByPlaceholder(/Search interview titles/).click();
  await forgetRequests(page);
  await page.keyboard.press('Meta+Enter');
  await page.waitForTimeout(500);
  expect(await chatRequests(page)).toBe(0);

  await page.locator('.history-card-open', { hasText: 'Demo interview' }).click();
  await page.getByLabel('Your message').fill('A short question');
  await page.keyboard.press('Meta+Enter');
  await expect.poll(() => chatRequests(page)).toBe(1); // the test backend has no key, so it then fails with 503
});

test('a question over 10,000 characters gets a clear error and is not sent', async ({ page }) => {
  await page.getByLabel('Your message').fill('x'.repeat(10001));
  const counter = page.locator('.editor-foot span').first();
  await expect(counter).toHaveText('10,001 / 10,000 characters');
  await expect(counter).toHaveClass(/over-limit/);
  await forgetRequests(page);
  await page.getByRole('button', { name: /Send/ }).click();
  await expect(page.locator('.error-banner')).toContainText('Your question is 10,001 characters. The limit is 10,000.');
  expect(await chatRequests(page)).toBe(0);
});

test('the answer length chosen during an interview is remembered', async ({ page, request }) => {
  const selected = page.locator('.answer-mode-button.selected');
  await expect(selected).toHaveText('Balanced');
  await Promise.all([
    page.waitForResponse(response => response.request().method() === 'PATCH'),
    page.getByRole('button', { name: 'Detailed', exact: true }).click(),
  ]);
  await openInterview(page, 'Demo interview');
  await expect(selected).toHaveText('Detailed');
  // Put it back for the other tests.
  await request.patch(`${API}/api/conversations/${await interviewId(request, 'Demo interview')}`, {
    data: { mode: 'balanced' },
  });
});

test('Focus Mode hides the settings, widens the answers and fades older questions', async ({ page }) => {
  const answersWidth = async () => (await page.locator('.conversation-panel').boundingBox())!.width;
  const before = await answersWidth();
  await page.getByRole('button', { name: 'Focus Mode' }).click();
  await expect(page.getByRole('button', { name: 'Exit Focus' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.answer-mode-wrap')).toBeHidden();
  expect(await answersWidth()).toBeGreaterThan(before);
  await expect
    .poll(() => page.locator('.message').evaluateAll(messages => messages.map(m => getComputedStyle(m).opacity)))
    .toEqual(['0.45', '0.45', '0.45', '0.45', '1', '1']);
  const send = (await page.getByRole('button', { name: /Send/ }).boundingBox())!;
  expect(send.y + send.height).toBeLessThanOrEqual(900);
});

test('Focus Mode on a phone keeps the answers near the top', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Focus Mode' }).click();
  const answersTop = await page
    .locator('.conversation-panel')
    .evaluate(panel => panel.getBoundingClientRect().top + window.scrollY);
  expect(answersTop).toBeLessThan(560);
});
