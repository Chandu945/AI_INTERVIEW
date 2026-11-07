import { expect, test, type Page } from '@playwright/test';
import { openApp, openInterview, sendQuestion, waitForAnswer } from './helpers';

// The answer panel shows one question and its answer at a time, as a page, and scrolling snaps
// from page to page. Answers are faked (see helpers.ts) so they stream at a known pace.

const panel = (page: Page) => page.locator('.conversation-body');

/** The questions and answers that can be seen in the answer panel, by their first three words. */
const inView = (page: Page) =>
  page.evaluate(() => {
    const area = document.querySelector('.conversation-body')!.getBoundingClientRect();
    return [...document.querySelectorAll('.message')]
      .filter(message => {
        const box = message.getBoundingClientRect();
        return box.bottom > area.top && box.top < area.bottom;
      })
      .map(message => message.querySelector('.message-text')!.textContent!.trim().split(/\s+/).slice(0, 3).join(' '));
  });

/** How far the newest question is from the top of the answer panel. */
const newestQuestionTop = (page: Page) =>
  page.evaluate(() => {
    const questions = document.querySelectorAll('.message.user');
    const top = document.querySelector('.conversation-body')!.getBoundingClientRect().top;
    return Math.round(questions[questions.length - 1].getBoundingClientRect().top - top);
  });

/** Turns the mouse wheel over the answer panel, then waits for it to settle on a page. */
async function wheel(page: Page, pixels: number) {
  const box = (await panel(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, pixels);
  await page.waitForTimeout(800);
}

// The last question and answer of the demo interview.
const DEMO_LAST = ['Explain FastAPI dependency', 'FastAPI lets an'];

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('an interview opens on its latest question and answer, alone at the top', async ({ page }) => {
  await openInterview(page, 'Demo interview');
  expect(await newestQuestionTop(page)).toBe(10); // just inside the panel's padding
  expect(await inView(page)).toEqual(DEMO_LAST);
});

test('a new question opens at the top, on its own, and stays there while its answer streams', async ({ page }) => {
  await openInterview(page, 'Demo interview');
  await page.evaluate(() => window.__streams(100, 6));
  await sendQuestion(page, 'What is a closure?');
  await expect.poll(() => newestQuestionTop(page)).toBe(10);
  const scrolled = await panel(page).evaluate(body => body.scrollTop);
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(150);
    expect(await newestQuestionTop(page)).toBe(10);
    expect(await panel(page).evaluate(body => body.scrollTop)).toBe(scrolled);
  }
  await waitForAnswer(page);
  expect(await inView(page)).toEqual(['What is a', 'Sentence 1 of']); // and nothing of the question before
});

test('scrolling up shows the previous question and answer on their own, and down comes back', async ({ page }) => {
  await openInterview(page, 'Demo interview');
  await page.evaluate(() => window.__streams(20, 3));
  await sendQuestion(page, 'What is a closure?');
  await waitForAnswer(page);
  await wheel(page, -600);
  expect(await inView(page)).toEqual(DEMO_LAST);
  await wheel(page, 600);
  expect(await inView(page)).toEqual(['What is a', 'Sentence 1 of']);
});

test('a long answer starts at its question, and scrolls on down for the rest', async ({ page }) => {
  await openInterview(page, 'Demo interview');
  await page.evaluate(() => window.__streams(10, 40));
  await sendQuestion(page, 'Explain Kubernetes networking');
  await waitForAnswer(page);
  expect(await newestQuestionTop(page)).toBe(10);
  await wheel(page, 300);
  expect(await newestQuestionTop(page)).toBe(10 - 300); // within the answer, the wheel scrolls freely
  expect(await inView(page)).toEqual(['Sentence 1 of']);
});

test('if a question fails, the question before it is shown again', async ({ page }) => {
  // No fake answer: the test backend has no Gemini key, so the request fails.
  await openInterview(page, 'Demo interview');
  await sendQuestion(page, 'This one fails');
  await expect(page.locator('.error-banner')).toContainText('GEMINI_API_KEY');
  await expect.poll(() => inView(page)).toEqual(DEMO_LAST);
  expect(await newestQuestionTop(page)).toBe(10);
});

test('on a phone, Send brings the new question to the top of the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openInterview(page, 'Demo interview');
  await page.evaluate(() => window.__streams(20, 3));
  await sendQuestion(page, 'A question on a phone');
  await waitForAnswer(page);
  const top = await page
    .locator('.message.user')
    .last()
    .evaluate(question => question.getBoundingClientRect().top);
  expect(Math.round(top)).toBe(10);
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
