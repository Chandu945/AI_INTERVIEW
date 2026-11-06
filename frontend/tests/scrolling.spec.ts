import { expect, test, type Page } from '@playwright/test';
import { openApp, openInterview, sendQuestion, waitForAnswer } from './helpers';

// Answers are faked (see helpers.ts) so they stream at a known pace without Gemini.

const panel = (page: Page) => page.locator('.conversation-body');
const panelScroll = (page: Page) =>
  panel(page).evaluate(body => ({
    top: Math.round(body.scrollTop),
    fromBottom: Math.round(body.scrollHeight - body.scrollTop - body.clientHeight),
  }));
// Scrolls the answer panel and fires its scroll event right away, as a real scroll would.
const scrollPanelTo = (page: Page, where: 'top' | 'bottom') =>
  panel(page).evaluate((body, to) => {
    body.scrollTop = to === 'top' ? 0 : body.scrollHeight;
    body.dispatchEvent(new Event('scroll'));
  }, where);

// Best of several samples, since one can land between a chunk appearing and the scroll that follows it.
async function closestToBottom(page: Page) {
  let best = Infinity;
  for (let i = 0; i < 6; i++) {
    best = Math.min(best, (await panelScroll(page)).fromBottom);
    await page.waitForTimeout(40);
  }
  return best;
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('the answer panel follows a streaming answer only while you are at the bottom', async ({ page }) => {
  await openInterview(page, 'Demo interview');
  await page.evaluate(() => window.__streams());
  await sendQuestion(page, 'Streaming question one');
  await page.waitForTimeout(700);
  expect(await closestToBottom(page)).toBeLessThanOrEqual(12);

  await scrollPanelTo(page, 'top');
  await page.waitForTimeout(1_000);
  expect((await panelScroll(page)).top).toBeLessThanOrEqual(5);

  await scrollPanelTo(page, 'bottom');
  await page.waitForTimeout(500);
  expect(await closestToBottom(page)).toBeLessThanOrEqual(12);
  await waitForAnswer(page);

  // Asking a new question while scrolled up jumps to it.
  await scrollPanelTo(page, 'top');
  await sendQuestion(page, 'Streaming question two');
  await page.waitForTimeout(400);
  expect(await closestToBottom(page)).toBeLessThanOrEqual(12);
  await waitForAnswer(page);
});

test('a fast, bursty answer is followed all the way to the end', async ({ page }) => {
  await openInterview(page, 'Demo interview');
  await page.evaluate(() => window.__streams(4, 80));
  await sendQuestion(page, 'A bursty question');
  await page.waitForTimeout(800);
  await waitForAnswer(page);
  await page.waitForTimeout(300);
  expect((await panelScroll(page)).fromBottom).toBeLessThanOrEqual(12);
});

test('on a phone, the page stays where you scrolled while an answer streams', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openInterview(page, 'Demo interview');
  await page.evaluate(() => window.__streams());
  await sendQuestion(page, 'A question on a phone');
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    window.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(1_000);
  expect(await page.evaluate(() => Math.round(window.scrollY))).toBeLessThanOrEqual(5);
  await waitForAnswer(page);
});
