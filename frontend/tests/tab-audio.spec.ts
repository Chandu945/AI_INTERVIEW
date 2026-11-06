import { expect, test, type Page } from '@playwright/test';
import { forgetRequests, openApp, openInterview, transcribeRequests } from './helpers';

// Listening to a browser tab instead of the mic. Chrome's share picker and speech recognition
// are faked (see helpers.ts): the shared tab's sound is a test tone, and window.__say() stands
// in for what the tab says.

const shares = (page: Page) => page.evaluate(() => window.__tabShares);
const sharedSound = (page: Page) =>
  page.evaluate(() => window.__sharedTracks.find(track => track.kind === 'audio')?.readyState);

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await openInterview(page, 'Demo interview');
  await page.getByLabel('Listen to', { exact: true }).selectOption('tab');
});

test("a tab's sound is listened to instead of the mic, and the tab stays shared", async ({ page }) => {
  await page.evaluate(() => {
    window.__transcript = 'What is a pod in Kubernetes?';
  });
  const listen = page.locator('.mic-btn');
  await expect(listen).toContainText('Listen to tab');
  await listen.click();
  await expect(listen).toContainText('Stop listening');
  await expect(page.locator('.editor-top')).toContainText('Listening to the tab');
  // Recognition hears the shared tab's sound, and the tab's picture is dropped at once.
  expect(
    await page.evaluate(() => {
      const sound = window.__sharedTracks.find(track => track.kind === 'audio');
      const picture = window.__sharedTracks.find(track => track.kind === 'video');
      return { heard: window.__recognitionTrack === sound, picture: picture?.readyState };
    }),
  ).toEqual({ heard: true, picture: 'ended' });
  await page.evaluate(() => window.__say('what is a pod in cuba net is'));
  await page.waitForTimeout(500); // let the recorder capture some audio
  await listen.click();
  await expect(page.getByLabel('Your message')).toHaveValue('What is a pod in Kubernetes?');
  await expect(page.locator('.editor-top')).toContainText('Transcript improved by Gemini');
  // Listening again uses the same tab, without asking again.
  expect(await sharedSound(page)).toBe('live');
  await listen.click();
  await expect(listen).toContainText('Stop listening');
  expect(await shares(page)).toBe(1);
});

test('a tab is transcribed by Gemini once, when listening stops, not at every pause', async ({ page }) => {
  await page.evaluate(() => {
    window.__transcript = 'First sentence. Second sentence.';
  });
  await forgetRequests(page);
  const listen = page.locator('.mic-btn');
  await listen.click();
  await page.waitForTimeout(300); // the recorder is running
  await page.evaluate(() => window.__say('first sentence')); // a pause
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__say('second sentence')); // another pause
  await page.waitForTimeout(500);
  expect(await transcribeRequests(page)).toBe(0);
  await listen.click();
  await expect(page.getByLabel('Your message')).toHaveValue('First sentence. Second sentence.');
  expect(await transcribeRequests(page)).toBe(1);
});

test("Chrome's Stop sharing stops listening and keeps the words; the next start asks again", async ({ page }) => {
  await page.evaluate(() => {
    window.__transcript = 'Explain blue-green deployments.';
  });
  const listen = page.locator('.mic-btn');
  await listen.click();
  await page.evaluate(() => window.__say('explain blue green deployments'));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__stopSharing());
  await expect(listen).toContainText('Listen to tab');
  await expect(page.getByLabel('Your message')).toHaveValue('Explain blue-green deployments.');
  await expect(page.getByRole('button', { name: 'Stop sharing' })).toHaveCount(0);
  await listen.click();
  await expect(listen).toContainText('Stop listening');
  expect(await shares(page)).toBe(2);
});

test('closing the picker without sharing says what to do', async ({ page }) => {
  await page.evaluate(() => {
    window.__tabShare = 'cancel';
  });
  const listen = page.locator('.mic-btn');
  await listen.click();
  await expect(page.locator('.error-banner')).toContainText('No tab was shared');
  await expect(listen).toContainText('Listen to tab');
});

test('a tab shared without its sound asks for "Also share tab audio"', async ({ page }) => {
  await page.evaluate(() => {
    window.__tabShare = 'no-audio';
  });
  const listen = page.locator('.mic-btn');
  await listen.click();
  await expect(page.locator('.error-banner')).toContainText('keep "Also share tab audio" on');
  await expect(listen).toContainText('Listen to tab');
  expect(await page.evaluate(() => window.__sharedTracks.map(track => track.readyState))).toEqual(['ended']);
});

test('Stop sharing, or switching back to the microphone, stops sharing the tab', async ({ page }) => {
  const listen = page.locator('.mic-btn');
  const stopSharing = page.getByRole('button', { name: 'Stop sharing' });
  await listen.click();
  await expect(listen).toContainText('Stop listening');
  await expect(stopSharing).toHaveCount(0); // not while listening
  await listen.click();
  await stopSharing.click();
  expect(await sharedSound(page)).toBe('ended');
  await expect(stopSharing).toHaveCount(0);

  await listen.click(); // asks for a tab again
  await expect(listen).toContainText('Stop listening');
  expect(await shares(page)).toBe(2);
  await listen.click();
  await page.getByLabel('Listen to', { exact: true }).selectOption('mic');
  expect(await sharedSound(page)).toBe('ended');
  await expect(listen).toContainText('Start speaking');
});

test('a tab recording over 2 minutes keeps the live text', async ({ page }) => {
  await page.evaluate(() => {
    window.__transcript = 'This should not appear.';
    // Make every recording look 5 minutes long (16 kHz 16-bit audio is 32,000 bytes a second).
    const size = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!;
    Object.defineProperty(Blob.prototype, 'size', {
      configurable: true,
      get(this: Blob) {
        return this.type === 'audio/wav' ? 300 * 32_000 : size.call(this);
      },
    });
  });
  await forgetRequests(page);
  const listen = page.locator('.mic-btn');
  await listen.click();
  await page.evaluate(() => window.__say('a long lecture about networking'));
  await page.waitForTimeout(500);
  await listen.click();
  await expect(page.locator('.editor-top')).toContainText('Long recording, so the live text was kept');
  await expect(page.getByLabel('Your message')).toHaveValue('a long lecture about networking');
  expect(await transcribeRequests(page)).toBe(0);
});

test('the choice to listen to a tab is remembered', async ({ page }) => {
  await page.reload();
  await page.waitForFunction(() => window.__requests.some(url => url.endsWith('/api/conversations')));
  await openInterview(page, 'Demo interview');
  await expect(page.getByLabel('Listen to', { exact: true })).toHaveValue('tab');
  await expect(page.locator('.mic-btn')).toContainText('Listen to tab');
});
