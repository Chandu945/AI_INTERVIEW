import { expect, test } from '@playwright/test';
import {
  API,
  chatRequests,
  chatUrls,
  forgetRequests,
  interviewId,
  openApp,
  openInterview,
  sendQuestion,
  waitForAnswer,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await openInterview(page, 'Demo interview');
});

test('Cmd+Enter sends from the interview page only, never a leftover draft from another page', async ({ page }) => {
  await page.getByLabel('Your message').fill('leftover draft that should not be sent');
  await page.getByRole('button', { name: 'Back to interviews' }).click();
  await page.getByLabel('Search interviews').click();
  await forgetRequests(page);
  await page.keyboard.press('Meta+Enter');
  await page.waitForTimeout(500);
  expect(await chatRequests(page)).toBe(0);

  await page.locator('.interview-open', { hasText: 'Demo interview' }).click();
  await page.getByLabel('Your message').fill('A short question');
  await page.keyboard.press('Meta+Enter');
  await expect.poll(() => chatRequests(page)).toBe(1); // the test backend has no key, so it then fails with 503
});

test('Enter sends the question, and Shift+Enter starts a new line', async ({ page }) => {
  const box = page.getByLabel('Your message');
  await box.click();
  await page.keyboard.type('First line');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('second line');
  await expect(box).toHaveValue('First line\nsecond line');
  await forgetRequests(page);
  await page.keyboard.press('Enter');
  await expect.poll(() => chatRequests(page)).toBe(1); // the test backend has no key, so it then fails with 503
});

test('Enter with nothing to send does nothing', async ({ page }) => {
  await page.getByLabel('Your message').click();
  await forgetRequests(page);
  await page.keyboard.press('Enter');
  await page.locator('.conversation-head').click(); // away from the box
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  expect(await chatRequests(page)).toBe(0);
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await expect(page.getByLabel('Your message')).toHaveValue('');
});

test('Enter sends after clicking away from the box, but a focused button keeps its own Enter', async ({ page }) => {
  await page.getByLabel('Your message').fill('A question');
  await page.getByRole('button', { name: 'Focus Mode' }).focus();
  await forgetRequests(page);
  await page.keyboard.press('Enter'); // presses Focus Mode, as Enter on a button does
  await expect(page.getByRole('button', { name: 'Exit Focus' })).toBeVisible();
  expect(await chatRequests(page)).toBe(0);
  await page.locator('.conversation-head').click(); // nothing in particular focused
  await page.keyboard.press('Enter');
  await expect.poll(() => chatRequests(page)).toBe(1);
});

test('clicking the microphone leaves the cursor in the question box', async ({ page }) => {
  await page.locator('.mic-btn').click();
  await expect(page.locator('.mic-btn')).toContainText('Stop listening');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Your message');
  await page.locator('.mic-btn').click();
  await expect(page.locator('.mic-btn')).not.toContainText('Stop listening');
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
  const selected = page.getByRole('group', { name: 'Interview answer length' }).locator('.answer-mode-button.selected');
  await expect(selected).toHaveText('Medium');
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

test('the answer style chosen during an interview is remembered and sent with questions', async ({ page, request }) => {
  const selected = page.getByRole('group', { name: 'Answer style' }).locator('.answer-mode-button.selected');
  await expect(selected).toHaveText('Simple');
  await Promise.all([
    page.waitForResponse(response => response.request().method() === 'PATCH'),
    page.getByRole('group', { name: 'Answer style' }).getByRole('button', { name: 'Balanced' }).click(),
  ]);
  await page.evaluate(() => window.__streams(50, 3));
  await page.getByLabel('Your message').fill('What is a service mesh?');
  await page.getByRole('button', { name: /Send/ }).click();
  await waitForAnswer(page);
  expect(await page.evaluate(() => window.__chatBodies[0])).toMatchObject({ style: 'balanced' });
  await openInterview(page, 'Demo interview');
  await expect(selected).toHaveText('Balanced');
  // Put it back for the other tests.
  await request.patch(`${API}/api/conversations/${await interviewId(request, 'Demo interview')}`, {
    data: { style: 'simple' },
  });
});

test('Focus Mode hides the settings, widens the answers and fades older questions', async ({ page }) => {
  const answersWidth = async () => (await page.locator('.conversation-panel').boundingBox())!.width;
  const before = await answersWidth();
  await page.getByRole('button', { name: 'Focus Mode' }).click();
  await expect(page.getByRole('button', { name: 'Exit Focus' })).toHaveAttribute('aria-pressed', 'true');
  for (const settings of await page.locator('.answer-mode-wrap').all()) await expect(settings).toBeHidden();
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

test('an answer that Gemini restarts partway is shown afresh, without an error', async ({ page }) => {
  await page.evaluate(() =>
    window.__replay([
      { type: 'start' },
      { type: 'delta', text: 'A half-written answer that broke ' },
      { type: 'restart' },
      { type: 'delta', text: 'The whole answer, ' },
      { type: 'delta', text: 'from the start.' },
      { type: 'done', first_token_ms: 900, total_ms: 2500 },
    ]),
  );
  await sendQuestion(page, 'What is a pod?');
  await waitForAnswer(page);
  await expect(page.locator('.message.assistant').last()).toHaveText(/The whole answer, from the start\./);
  await expect(page.locator('.message.assistant').last()).not.toContainText('half-written');
  await expect(page.locator('.error-banner')).toHaveCount(0);
});

test('the latest answer can be said again shorter, simpler or in more detail, in its place', async ({ page }) => {
  const rewrites = page.getByRole('group', { name: 'Say this answer again' });
  await expect(rewrites).toHaveCount(1); // under the latest answer only
  await expect(page.locator('.message.assistant').last().getByRole('group')).toBeVisible();
  await expect(rewrites.getByRole('button')).toHaveText(['Shorter', 'Simpler', 'More detail']);
  const answers = page.locator('.message.assistant .message-text');
  await page.evaluate(() =>
    window.__replay(
      [
        { type: 'start' },
        { type: 'delta', text: 'Dependency injection hands an endpoint ' },
        { type: 'delta', text: 'what it needs.' },
        { type: 'done', first_token_ms: 400, total_ms: 900 },
      ],
      150,
    ),
  );
  await forgetRequests(page);
  await rewrites.getByRole('button', { name: 'Shorter' }).click();
  await expect(rewrites).toHaveCount(0); // not while it's being said again
  await expect(answers.last()).toHaveText('Dependency injection hands an endpoint what it needs.');
  await expect(rewrites).toHaveCount(1);
  await expect(page.locator('.message')).toHaveCount(6); // in the old one's place
  await expect(answers.nth(1)).toContainText('recall@k'); // the earlier answers as they were
  expect(await chatUrls(page)).toEqual([`${API}/api/chat/rewrite`]);
  expect(await page.evaluate(() => window.__chatBodies[0])).toEqual({
    conversation_id: await interviewId(page.request, 'Demo interview'),
    how: 'shorter',
    style: 'simple',
  });
  await expect(page.locator('.conversation-bottom')).toContainText('First text 400 ms · Total 900 ms');
});

test('an answer that could not be said again is put back, with the reason', async ({ page }) => {
  // No fake answer: the test backend has no Gemini key.
  const last = page.locator('.message.assistant .message-text').last();
  const before = await last.innerText();
  await page.getByRole('button', { name: 'More detail' }).click();
  await expect(page.locator('.error-banner')).toContainText('GEMINI_API_KEY is not configured');
  await expect(last).toHaveText(before);
  await expect(page.getByRole('group', { name: 'Say this answer again' })).toHaveCount(1);
});

test("an answer's opening sentence stands out", async ({ page }) => {
  const paragraphs = page.locator('.message.assistant').first().locator('.message-text p');
  const weight = (n: number) => paragraphs.nth(n).evaluate(p => getComputedStyle(p).fontWeight);
  expect([await weight(0), await weight(1)]).toEqual(['650', '400']);
});
