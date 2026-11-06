import { expect, test } from '@playwright/test';
import { chatRequests, forgetRequests, openApp, openInterview, transcribeRequests, waitForAnswer } from './helpers';

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

test('the buttons stay put while live words come and go', async ({ page }) => {
  // Narrow enough for the longer status messages to need cutting short.
  await page.setViewportSize({ width: 1280, height: 800 });
  const strip = page.locator('.interim');
  // Where Start/Stop and Send are on the page, and whether the newest live words are in view.
  const layout = () =>
    page.evaluate(() => {
      const top = (selector: string) =>
        Math.round(document.querySelector(selector)!.getBoundingClientRect().top + scrollY);
      return { mic: top('.mic-btn'), send: top('.btn.primary') };
    });
  const newestWordsShown = () =>
    page.evaluate(() => {
      const box = document.querySelector('.interim-words')!.getBoundingClientRect();
      const words = document.querySelector('.interim-words > span')!.getBoundingClientRect();
      return Math.abs(words.bottom - box.bottom) <= 1;
    });
  await expect(strip).toContainText('Live words show here');
  const before = await layout();
  const mic = page.locator('.mic-btn');
  await mic.click();
  await expect(page.getByRole('button', { name: /Send/ })).toBeEnabled(); // even before any words
  await page.evaluate(() => window.__sayInterim('so like this'));
  expect(await layout()).toEqual(before);
  await page.evaluate(() =>
    window.__sayInterim(
      'so like this with those I mean on the other hand when you use the rest operator in a function you collect the remaining arguments into an array and loop over them',
    ),
  );
  expect(await layout()).toEqual(before);
  expect(await newestWordsShown()).toBe(true);
  await page.evaluate(() => window.__say('so I come with a name'));
  expect(await layout()).toEqual(before);
  await page.waitForTimeout(500); // let the recorder capture some audio
  await mic.click(); // the test backend has no Gemini key, so this ends with a long message
  await expect(page.locator('.editor-top')).toContainText("Couldn't improve the transcript");
  expect(await layout()).toEqual(before);
});

// Polishing: the recording is transcribed again by Gemini when dictation stops.

test("when you stop, Gemini's transcript replaces the live words", async ({ page }) => {
  await page.evaluate(() => {
    window.__transcript = 'What is RAG in LangChain?';
  });
  const mic = page.locator('.mic-btn');
  await mic.click();
  await page.evaluate(() => window.__say('what is rag in lang chain'));
  await page.waitForTimeout(500); // let the recorder capture some audio
  await mic.click();
  await expect(page.getByLabel('Your message')).toHaveValue('What is RAG in LangChain?');
  await expect(page.locator('.editor-top')).toContainText('Transcript improved by Gemini');
});

test('after a pause, the improved transcript is ready as soon as you stop', async ({ page }) => {
  await page.evaluate(() => {
    window.__transcript = 'What is RAG in LangChain?';
    window.__transcriptDelayMs = 1_500;
  });
  const mic = page.locator('.mic-btn');
  await mic.click();
  await page.waitForTimeout(300); // the recorder is running
  await page.evaluate(() => window.__say('what is rag in lang chain')); // the pause sends the recording
  await page.waitForTimeout(1_800);
  await mic.click();
  await expect(page.getByLabel('Your message')).toHaveValue('What is RAG in LangChain?', { timeout: 700 });
  expect(await transcribeRequests(page)).toBe(1);
});

test('words still being recognized when you stop get a fresh transcript', async ({ page }) => {
  await page.evaluate(() => {
    window.__transcript = 'First part.';
  });
  const mic = page.locator('.mic-btn');
  await mic.click();
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__say('first part'));
  await expect.poll(() => transcribeRequests(page)).toBe(1); // sent at the pause
  await page.evaluate(() => {
    window.__transcript = 'First part, and more.';
    window.__sayInterim('and more');
  });
  await mic.click();
  await expect(page.getByLabel('Your message')).toHaveValue('First part, and more.');
  expect(await transcribeRequests(page)).toBe(2);
});

test('text typed during dictation is never overwritten', async ({ page }) => {
  await page.evaluate(() => {
    window.__transcript = 'This should not appear.';
  });
  const mic = page.locator('.mic-btn');
  const box = page.getByLabel('Your message');
  await mic.click();
  await box.focus();
  // Something typed the instant the words arrive must not wipe them out.
  await page.evaluate(() => {
    window.__say('first words');
    document.execCommand('insertText', false, ' and');
  });
  await box.pressSequentially(' typed words');
  await page.waitForTimeout(500);
  await mic.click();
  await expect(page.locator('.editor-top')).toContainText('Kept your edits');
  await expect(box).toHaveValue('first words and typed words');
});

test('a transcript far longer than the live words is not used', async ({ page }) => {
  await page.evaluate(() => {
    // Gemini answering the question instead of writing it down.
    window.__transcript =
      'A closure is a function that remembers the variables of the scope it was created in, even after that scope has finished running.';
  });
  const mic = page.locator('.mic-btn');
  await mic.click();
  await page.evaluate(() => window.__say('what is a closure'));
  await page.waitForTimeout(500);
  await mic.click();
  await expect(page.locator('.editor-top')).toContainText("Couldn't improve the transcript");
  await expect(page.getByLabel('Your message')).toHaveValue('what is a closure');
});

test('a slow transcript is dropped once you start speaking again', async ({ page }) => {
  await page.evaluate(() => {
    window.__transcript = 'First question.';
    window.__transcriptDelayMs = 1_500;
  });
  const mic = page.locator('.mic-btn');
  const box = page.getByLabel('Your message');
  await mic.click();
  await page.evaluate(() => window.__say('first question'));
  await page.waitForTimeout(500);
  await mic.click(); // its transcript arrives 1.5 s later, during the next dictation
  await expect.poll(() => transcribeRequests(page)).toBe(1);
  await page.evaluate(() => {
    window.__transcript = 'Second part.';
    window.__transcriptDelayMs = 0;
  });
  await mic.click();
  await page.evaluate(() => window.__say('second part'));
  await page.waitForTimeout(2_000);
  await expect(box).toHaveValue('first question second part');
  await mic.click();
  await expect(box).toHaveValue('first question Second part.');
});

test('pressing the mic again while it is still stopping is ignored', async ({ page }) => {
  await page.evaluate(() => {
    window.__transcript = 'First question.';
  });
  const mic = page.locator('.mic-btn');
  await mic.click();
  await page.evaluate(() => window.__say('first question'));
  await page.waitForTimeout(500);
  await mic.dblclick(); // stop, then at once start again
  await expect(page.getByLabel('Your message')).toHaveValue('First question.');
  await page.waitForTimeout(1_000); // past the longest wait for the last words
  await expect(mic).toContainText('Start speaking');
  await expect(page.getByLabel('Your message')).toHaveValue('First question.');
});

test('a second Send while the transcript is polished does not send twice', async ({ page }) => {
  await page.evaluate(() => {
    window.__streams(50, 5);
    window.__transcript = 'What is a closure?';
    window.__transcriptDelayMs = 1_000;
  });
  await forgetRequests(page);
  await page.locator('.mic-btn').click();
  await page.evaluate(() => window.__say('what is a closure'));
  await page.waitForTimeout(500);
  const send = page.getByRole('button', { name: /Send/ });
  await send.click(); // stops the mic, polishes, then sends
  await send.click();
  await expect(page.locator('.message.user').last()).toContainText('What is a closure?');
  await waitForAnswer(page);
  expect(await chatRequests(page)).toBe(1);
  await expect(page.locator('.error-banner')).toHaveCount(0);
});

test("if Gemini can't transcribe, the live words stay", async ({ page }) => {
  // No fake transcript: the test backend has no Gemini key, so transcription fails.
  const mic = page.locator('.mic-btn');
  await mic.click();
  await page.evaluate(() => window.__say('what is a vector database'));
  await page.waitForTimeout(300);
  await mic.click();
  await expect(page.locator('.editor-top')).toContainText("Couldn't improve the transcript");
  await expect(page.getByLabel('Your message')).toHaveValue('what is a vector database');
});

test('polishing can be turned off', async ({ page }) => {
  await page.getByLabel(/Improve the transcript/).uncheck();
  await forgetRequests(page);
  const mic = page.locator('.mic-btn');
  await mic.click();
  await page.evaluate(() => window.__say('no polishing please'));
  await page.waitForTimeout(300);
  await mic.click();
  await expect(mic).toContainText('Start speaking');
  await page.waitForTimeout(500);
  expect(await transcribeRequests(page)).toBe(0);
  await expect(page.getByLabel('Your message')).toHaveValue('no polishing please');
});

test('hands-free sending sends the polished transcript', async ({ page }) => {
  await page.evaluate(() => {
    window.__streams(50, 5);
    window.__transcript = 'What is a closure in JavaScript?';
  });
  await page.getByLabel(/Stop listening after 2.2s/).check();
  await page.getByLabel(/send the question automatically/).check();
  await page.locator('.mic-btn').click();
  await page.evaluate(() => window.__say('what is a closure in java script'));
  await expect(page.locator('.message.user').last()).toContainText('What is a closure in JavaScript?', {
    timeout: 6_000,
  });
});
