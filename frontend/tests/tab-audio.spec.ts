import { expect, test, type Page } from '@playwright/test';
import {
  chatUrls,
  cutPiece,
  forgetRequests,
  openApp,
  openInterview,
  transcribeRequests,
  waitForAnswer,
} from './helpers';

// Listening to a browser tab instead of the mic. Chrome's share picker and speech recognition
// are faked (see helpers.ts): the shared tab's sound is a test tone, and window.__say() stands
// in for what the tab says. window.__transcripts gives the text Gemini writes for each piece of
// the recording, in turn (window.__transcript, any further piece's).

const shares = (page: Page) => page.evaluate(() => window.__tabShares);
// The tab keeps talking: Chrome hears words all along.
const keepTalking = (page: Page) => page.evaluate(() => setInterval(() => window.__sayInterim('words'), 100));
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
  await page.waitForTimeout(1_000); // let the recorder capture some audio
  await listen.click();
  await expect(page.getByLabel('Your message')).toHaveValue('What is a pod in Kubernetes?');
  await expect(page.locator('.editor-top')).toContainText('Transcript improved by Gemini');
  // Listening again uses the same tab, without asking again.
  expect(await sharedSound(page)).toBe('live');
  await listen.click();
  await expect(listen).toContainText('Stop listening');
  expect(await shares(page)).toBe(1);
});

test("a tab's sound is cut into pieces at its pauses, each written down as it comes", async ({ page }) => {
  await page.evaluate(() => {
    window.__tabPauses = true; // 0.6 s of sound, then 0.4 s of quiet, over and over
    window.__pieceTimings = { min: 0.5, max: 5, quiet: 0.2, silence: 0 };
    window.__transcripts = ['One.', 'Two.', 'Three.'];
    window.__transcript = '';
  });
  const listen = page.locator('.mic-btn');
  await listen.click();
  await keepTalking(page);
  // Cut at the pauses, about a second apart (cut only at the 5 s limit, they'd take 15 s).
  await expect(page.getByLabel('Your message')).toHaveValue('One. Two. Three.', { timeout: 6_000 });
  await expect(listen).toContainText('Stop listening'); // all while listening
  // Each went with the text so far.
  expect(await page.evaluate(() => window.__contexts.slice(0, 3))).toEqual(['', 'One.', 'One. Two.']);
});

test("a tab's sound with no pause in it is cut every so often", async ({ page }) => {
  await page.evaluate(() => {
    window.__pieceTimings = { min: 0.5, max: 1, quiet: 0.2, silence: 0 };
    window.__transcripts = ['One.', 'Two.'];
    window.__transcript = '';
  });
  const listen = page.locator('.mic-btn');
  await listen.click();
  await keepTalking(page);
  await expect(page.getByLabel('Your message')).toHaveValue('One. Two.', { timeout: 5_000 });
  await expect(listen).toContainText('Stop listening');
});

test("a piece with a steady sound and no words in it isn't sent, as Gemini would make words up", async ({ page }) => {
  await page.evaluate(() => {
    window.__transcripts = ['One.'];
    window.__transcript = '';
  });
  await forgetRequests(page);
  const listen = page.locator('.mic-btn');
  await listen.click();
  await page.waitForTimeout(500); // the tab's steady tone: sound, but nothing like speech
  await cutPiece(page);
  await page.evaluate(() => window.__say('one'));
  await cutPiece(page);
  await expect(page.getByLabel('Your message')).toHaveValue('One.');
  await page.waitForTimeout(300); // nor the last piece
  await listen.click();
  await page.waitForTimeout(300);
  expect(await transcribeRequests(page)).toBe(1); // only the piece with words
});

test('a piece that sounds like speech goes even if Chrome heard no words in it', async ({ page }) => {
  await page.evaluate(() => {
    window.__tabPauses = true; // sound that comes and goes, as speech does
    window.__transcripts = ['Words Chrome missed.'];
    window.__transcript = '';
  });
  await page.locator('.mic-btn').click();
  await page.waitForTimeout(1_200);
  await cutPiece(page);
  await expect(page.getByLabel('Your message')).toHaveValue('Words Chrome missed.');
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

test('a recording over 2 minutes is not sent with the question: its text is', async ({ page }) => {
  await page.evaluate(() => {
    window.__streams(50, 5);
    window.__transcript = 'A long lecture.';
    window.__transcriptDelayMs = 1_000; // still being written down at Send
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
  await page.evaluate(() => window.__say('a long lecture'));
  await page.waitForTimeout(500);
  await listen.click();
  await page.getByRole('button', { name: /Send/ }).click();
  await expect(page.locator('.message.user').last()).toContainText('A long lecture.');
  await waitForAnswer(page);
  expect(await chatUrls(page)).toEqual([expect.stringMatching(/\/api\/chat\/stream$/)]);
});

test('the choice to listen to a tab is remembered', async ({ page }) => {
  await page.reload();
  await page.waitForFunction(() => window.__requests.some(url => url.endsWith('/api/conversations')));
  await openInterview(page, 'Demo interview');
  await expect(page.getByLabel('Listen to', { exact: true })).toHaveValue('tab');
  await expect(page.locator('.mic-btn')).toContainText('Listen to tab');
});
