import { expect, test, type Page } from '@playwright/test';
import {
  chatRequests,
  chatUrls,
  cutPiece,
  forgetRequests,
  openApp,
  openInterview,
  transcribeRequests,
  waitForAnswer,
} from './helpers';

// Speech recognition is faked (see helpers.ts), so window.__say() stands in for speaking. Gemini
// writes the text down from the recording, piece by piece: cutPiece() cuts a piece off, as a pause
// would, and window.__transcripts gives each piece's text in turn (window.__transcript, any further
// piece's). Without them, transcription fails: the test backend has no Gemini key.

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await openInterview(page, 'Demo interview');
});

/** Where Start/Stop and Send are on the page. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const top = (selector: string) =>
      Math.round(document.querySelector(selector)!.getBoundingClientRect().top + scrollY);
    return { mic: top('.mic-btn'), send: top('.btn.primary') };
  });

test('turning auto-stop on while the mic is on stops it after the pause', async ({ page }) => {
  const mic = page.locator('.mic-btn');
  await mic.click();
  await expect(mic).toContainText('Stop listening');
  await page.evaluate(() => window.__say('hello there'));
  await page.getByLabel(/Stop listening after 2.2s/).check();
  await expect(mic).toContainText('Start speaking', { timeout: 4_000 });
  // Gemini can't write it down here, so Chrome's words are used.
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

test('words not written down yet show in gray in the box, and the buttons stay put', async ({ page }) => {
  // Narrow enough for the longer status messages to need cutting short.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    window.__transcripts = ['So, like this.']; // after it, transcription fails
  });
  const box = page.getByLabel('Your message');
  const gray = page.locator('.ghost-words');
  const before = await layout(page);
  const mic = page.locator('.mic-btn');
  await mic.click();
  await expect(page.getByRole('button', { name: /Send/ })).toBeEnabled(); // even before any words
  await page.evaluate(() => window.__sayInterim('so like this'));
  await expect(gray).toHaveText('so like this');
  await expect(box).toHaveValue(''); // gray words aren't part of the text until Gemini has written them down
  await expect(box).toHaveAttribute('placeholder', ''); // nor drawn over the box's hint
  expect(await layout(page)).toEqual(before);
  await cutPiece(page);
  await expect(box).toHaveValue('So, like this.');
  await expect(gray).toHaveCount(0);
  expect(await layout(page)).toEqual(before);
  // The last piece can't be written down, so this ends with a long message.
  await page.evaluate(() => window.__say('and the stateful pods keep their volumes'));
  await mic.click();
  await expect(page.locator('.editor-top')).toContainText("Gemini couldn't write some of it down");
  await expect(box).toHaveValue('So, like this. and the stateful pods keep their volumes');
  expect(await layout(page)).toEqual(before);
  await expect(page.locator('.interim')).toHaveCount(0); // no separate strip under the box
});

test('a long text scrolls to keep the newest gray words in view', async ({ page }) => {
  const box = page.getByLabel('Your message');
  const sentence = 'Explain how Kubernetes schedules pods across nodes and what happens when a node fails.';
  await box.fill(Array(16).fill(sentence).join(' '));
  const before = await layout(page);
  await page.locator('.mic-btn').click();
  await page.evaluate(() => window.__sayInterim('so how would you make sure the stateful pods keep their volumes'));
  await expect(page.locator('.ghost-words')).toHaveText(
    ' so how would you make sure the stateful pods keep their volumes',
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const box = document.querySelector('textarea')!;
        const area = box.getBoundingClientRect();
        const words = document.querySelector('.ghost-words')!.getBoundingClientRect();
        return box.scrollTop > 0 && words.top >= area.top && words.bottom <= area.bottom;
      }),
    )
    .toBe(true);
  expect(await layout(page)).toEqual(before);
});

test('Gemini writes each piece down as it comes, carrying on from the text so far', async ({ page }) => {
  await page.evaluate(() => {
    window.__transcripts = ['What is RAG?', 'How does LangChain use it?'];
    window.__transcriptDelays = [1_500, 800]; // the second piece is cut while the first is still out
    window.__transcript = ''; // any further piece: nothing more was said
  });
  const mic = page.locator('.mic-btn');
  const box = page.getByLabel('Your message');
  const gray = page.locator('.ghost-words');
  await mic.click();
  await page.evaluate(() => window.__say('what is rag'));
  await cutPiece(page);
  await page.waitForTimeout(800); // long enough for the second piece's words
  await page.evaluate(() => window.__say('how does lang chain use it'));
  await cutPiece(page);
  await expect(gray).toHaveText('what is rag how does lang chain use it');
  expect(await transcribeRequests(page)).toBe(1); // one piece at a time, in order
  await expect(box).toHaveValue('What is RAG?');
  await expect(gray).toHaveText(' how does lang chain use it');
  await expect(box).toHaveValue('What is RAG? How does LangChain use it?');
  await expect(gray).toHaveCount(0);
  await expect(mic).toContainText('Stop listening'); // all while listening
  // Each piece went with the text so far, so Gemini carries on from it.
  expect(await page.evaluate(() => window.__contexts)).toEqual(['', 'What is RAG?']);
  await mic.click();
  await expect(page.locator('.editor-top')).toContainText('Transcript improved by Gemini');
  await expect(box).toHaveValue('What is RAG? How does LangChain use it?');
});

test("a piece Gemini can't write down goes again with the next one", async ({ page }) => {
  await page.evaluate(() => {
    window.__transcripts = [null, 'First part, second part.']; // the first try fails
    window.__transcript = '';
  });
  const mic = page.locator('.mic-btn');
  await mic.click();
  await page.evaluate(() => window.__say('first part'));
  await cutPiece(page);
  await page.waitForTimeout(500);
  expect(await transcribeRequests(page)).toBe(1); // not tried again on its own
  await expect(page.locator('.ghost-words')).toHaveText('first part');
  await page.evaluate(() => window.__say('second part'));
  await cutPiece(page);
  await expect(page.getByLabel('Your message')).toHaveValue('First part, second part.');
  expect(await transcribeRequests(page)).toBe(2);
  await mic.click();
  await expect(page.locator('.editor-top')).toContainText('Transcript improved by Gemini');
});

test('the last piece is written down when you stop', async ({ page }) => {
  await page.evaluate(() => {
    window.__transcript = 'What is a closure?';
    window.__transcriptDelayMs = 500;
  });
  const mic = page.locator('.mic-btn');
  await mic.click();
  await page.evaluate(() => window.__say('what is a closure'));
  await page.waitForTimeout(500); // let the recorder capture some audio
  await mic.click();
  await expect(page.locator('.ghost-words')).toHaveText('what is a closure'); // until it's written down
  await expect(page.locator('.editor-top')).toContainText('Improving the transcript with Gemini');
  await expect(page.getByLabel('Your message')).toHaveValue('What is a closure?');
  await expect(page.locator('.editor-top')).toContainText('Transcript improved by Gemini');
  expect(await transcribeRequests(page)).toBe(1);
});

test('text typed during dictation is kept, with the words written down after it', async ({ page }) => {
  await page.evaluate(() => {
    window.__transcripts = ['First words.', 'More words.'];
    window.__transcript = '';
  });
  const mic = page.locator('.mic-btn');
  const box = page.getByLabel('Your message');
  await mic.click();
  await page.evaluate(() => window.__say('first words'));
  await cutPiece(page);
  await expect(box).toHaveValue('First words.');
  await box.focus();
  await box.press('End');
  await box.pressSequentially(' And typed ones.');
  await page.evaluate(() => window.__say('more words'));
  await mic.click();
  await expect(box).toHaveValue('First words. And typed ones. More words.');
});

test('a transcript with far more words than were said is not used', async ({ page }) => {
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
  await expect(page.locator('.editor-top')).toContainText("Gemini couldn't write some of it down");
  await expect(page.getByLabel('Your message')).toHaveValue('what is a closure');
});

test("if Gemini can't write it down, Chrome's words are used", async ({ page }) => {
  // No fake transcript: the test backend has no Gemini key, so transcription fails.
  const mic = page.locator('.mic-btn');
  await mic.click();
  await page.evaluate(() => window.__say('what is a vector database'));
  await page.waitForTimeout(300);
  await mic.click();
  await expect(page.locator('.editor-top')).toContainText(
    "Gemini couldn't write some of it down, so Chrome's words were kept there",
  );
  await expect(page.getByLabel('Your message')).toHaveValue('what is a vector database');
  expect(await transcribeRequests(page)).toBe(2); // it was tried twice
});

test("if Gemini hears no one where Chrome heard words, Chrome's words are used", async ({ page }) => {
  await page.evaluate(() => {
    window.__transcripts = ['']; // Gemini: no one speaks in it
  });
  const mic = page.locator('.mic-btn');
  await mic.click();
  await page.evaluate(() => window.__say('quiet words'));
  await cutPiece(page);
  await expect(page.getByLabel('Your message')).toHaveValue('quiet words');
  await mic.click();
  await expect(page.locator('.editor-top')).toContainText("Chrome's words were kept there");
});

test('Clear drops the words still being written down', async ({ page }) => {
  await page.evaluate(() => {
    window.__transcripts = ['Not this.'];
    window.__transcriptDelays = [800];
    window.__transcript = '';
  });
  const mic = page.locator('.mic-btn');
  await mic.click();
  await page.evaluate(() => window.__say('not this'));
  await cutPiece(page);
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('.ghost-words')).toHaveCount(0);
  await page.waitForTimeout(1_000); // its text has come back by now
  await expect(page.getByLabel('Your message')).toHaveValue('');
  await expect(mic).toContainText('Stop listening'); // still listening, afresh
});

test("a slow piece from the last dictation lands before the next one's words", async ({ page }) => {
  await page.evaluate(() => {
    window.__streams(50, 5);
    window.__transcripts = ['First question.', 'Second part.'];
    window.__transcriptDelays = [1_500, 0];
    window.__transcript = '';
  });
  await forgetRequests(page);
  const mic = page.locator('.mic-btn');
  await mic.click();
  await page.evaluate(() => window.__say('first question'));
  await page.waitForTimeout(300);
  await mic.click(); // its text comes 1.5 s later, during the next dictation
  await expect.poll(() => transcribeRequests(page)).toBe(1);
  await mic.click();
  await expect(mic).toContainText('Stop listening');
  await page.evaluate(() => window.__say('second part'));
  await cutPiece(page);
  await expect(page.locator('.ghost-words')).toHaveText('first question second part');
  // Sending waits for both, as text: this dictation's recording alone would miss the first part.
  await page.getByRole('button', { name: /Send/ }).click();
  await expect(page.locator('.message.user').last()).toContainText('First question. Second part.');
  await waitForAnswer(page);
  expect(await chatUrls(page)).toEqual([expect.stringMatching(/\/api\/chat\/stream$/)]);
});

test('pressing the mic again while it is still stopping is ignored', async ({ page }) => {
  // With Chrome's words as the text, stopping waits a moment for its last ones.
  await page.getByLabel(/Improve the transcript/).uncheck();
  const mic = page.locator('.mic-btn');
  await mic.click();
  await page.evaluate(() => window.__say('first question'));
  await mic.dblclick(); // stop, then at once start again
  await expect(page.getByLabel('Your message')).toHaveValue('first question');
  await page.waitForTimeout(1_000); // past the longest wait for the last words
  await expect(mic).toContainText('Start speaking');
  await expect(page.getByLabel('Your message')).toHaveValue('first question');
});

test('a second Send while the first is still going out does not send twice', async ({ page }) => {
  await page.evaluate(() => {
    window.__streams(50, 5);
    window.__transcript = 'What is a closure?';
  });
  await forgetRequests(page);
  await page.locator('.mic-btn').click();
  await page.waitForTimeout(300); // the recorder is running
  await page.evaluate(() => window.__say('what is a closure'));
  await page.waitForTimeout(200);
  // Two clicks at once, as a quick double-click: the first stops the mic and sends; the second is ignored.
  await page.evaluate(() => {
    const send = document.querySelector<HTMLButtonElement>('.btn.primary')!;
    send.click();
    send.click();
  });
  await expect(page.locator('.message.user').last()).toContainText('What is a closure?');
  await waitForAnswer(page);
  expect(await chatRequests(page)).toBe(1);
  await expect(page.locator('.error-banner')).toHaveCount(0);
});

// Sending before all the text is in: the question goes with its recording, and one Gemini
// request writes it down and answers it.

test('Send while a piece is being written down sends the recording, and Gemini writes the question down', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.__streams(50, 5);
    window.__transcript = 'What is RAG in LangChain?';
    window.__transcriptDelayMs = 2_000; // the piece is still out at Send
  });
  await forgetRequests(page);
  const box = page.getByLabel('Your message');
  await page.locator('.mic-btn').click();
  await page.evaluate(() => window.__say('what is rag in lang chain'));
  await page.waitForTimeout(300); // the recorder is running
  await cutPiece(page);
  await page.getByRole('button', { name: /Send/ }).click();
  await expect(page.locator('.message.user').last()).toContainText('What is RAG in LangChain?');
  await waitForAnswer(page);
  expect(await page.evaluate(() => window.__heard)).toBe('what is rag in lang chain');
  expect(await chatUrls(page)).toEqual([expect.stringContaining('/api/chat/stream-recording')]);
  await expect(box).toHaveValue('');
  await page.waitForTimeout(2_000); // the piece's text comes back, and leaves the box alone
  await expect(box).toHaveValue('');
  await expect(page.locator('.editor-top')).not.toContainText('Transcript improved');
});

test('Send while words are still being heard goes at once, without waiting for them', async ({ page }) => {
  await page.evaluate(() => {
    window.__streams(50, 5);
    window.__transcript = 'What is RAG, and how does LangChain use it?';
  });
  await forgetRequests(page);
  const box = page.getByLabel('Your message');
  await page.locator('.mic-btn').click();
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.__say('what is rag');
    window.__sayInterim('and how does lang chain'); // not final yet
  });
  await page.getByRole('button', { name: /Send/ }).click();
  await expect(page.locator('.message.user').last()).toContainText('What is RAG, and how does LangChain use it?');
  await waitForAnswer(page);
  // The recording went with the words heard so far, the unfinished ones included.
  expect(await page.evaluate(() => window.__heard)).toBe('what is rag and how does lang chain');
  expect(await chatUrls(page)).toEqual([expect.stringContaining('/api/chat/stream-recording')]);
  // Recognition was stopped at once: its late words never land in the box.
  await page.evaluate(() => window.__say('and how does lang chain use it'));
  await page.waitForTimeout(500);
  await expect(box).toHaveValue('');
  await expect(page.locator('.mic-btn')).toContainText('Start speaking');
  expect(await transcribeRequests(page)).toBe(0);
});

test('Send once all the text is in sends it as Gemini wrote it, without writing the recording down again', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.__streams(50, 5);
    window.__transcripts = ['What is RAG in LangChain?']; // the piece: the whole question, written down
    window.__transcript = 'What is RAG in LangChain, and why?'; // what the recording would be written down as
  });
  await forgetRequests(page);
  await page.locator('.mic-btn').click();
  await page.evaluate(() => window.__say('what is rag in lang chain'));
  await page.waitForTimeout(800); // long enough for its words
  await cutPiece(page);
  await expect(page.getByLabel('Your message')).toHaveValue('What is RAG in LangChain?');
  await page.getByRole('button', { name: /Send/ }).click();
  await expect(page.locator('.message.user').last()).toContainText('What is RAG in LangChain?');
  await waitForAnswer(page);
  expect(await chatUrls(page)).toEqual([expect.stringMatching(/\/api\/chat\/stream$/)]); // as text
  expect(await page.evaluate(() => window.__heard)).toBeNull();
  await expect(page.locator('.message.user').last()).toContainText('What is RAG in LangChain?'); // and so it stays
  await expect(page.locator('.mic-btn')).toContainText('Start speaking');
});

test('the microphone stays open for a while after you stop, so the next dictation starts at once', async ({ page }) => {
  await page.evaluate(() => {
    window.__micHoldMs = 1_500;
  });
  const mic = page.locator('.mic-btn');
  const states = () => page.evaluate(() => window.__micTracks.map(track => track.readyState));
  await mic.click();
  await expect(page.locator('.status-text')).toHaveText('Listening live');
  await mic.click(); // Stop
  await expect(mic).toContainText('Start speaking');
  expect(await page.evaluate(() => window.__micOpens)).toBe(1);
  expect(await states()).toEqual(['live']); // kept open
  await mic.click(); // again, from the mic kept open
  await expect(page.locator('.status-text')).toHaveText('Listening live');
  expect(await page.evaluate(() => window.__micOpens)).toBe(1);
  await mic.click();
  await expect(mic).toContainText('Start speaking');
  await expect.poll(states, { timeout: 5_000 }).toEqual(['ended']); // let go once the hold is over
  await mic.click(); // opened afresh
  await expect(page.locator('.status-text')).toHaveText('Listening live');
  expect(await page.evaluate(() => window.__micOpens)).toBe(2);
  await mic.click();
  await expect(mic).toContainText('Start speaking');
});

test('a dictated question that was typed in is sent as its text', async ({ page }) => {
  await page.evaluate(() => {
    window.__streams(50, 5);
    window.__transcripts = ['What is a closure?', 'And why?'];
    window.__transcript = '';
  });
  await forgetRequests(page);
  const box = page.getByLabel('Your message');
  await page.locator('.mic-btn').click();
  await page.evaluate(() => window.__say('what is a closure'));
  await page.waitForTimeout(500); // long enough for its words
  await cutPiece(page);
  await expect(box).toHaveValue('What is a closure?');
  await box.focus();
  await box.press('End');
  await box.pressSequentially(' In JavaScript?');
  await page.evaluate(() => window.__sayInterim('and why')); // still to be written down
  await page.getByRole('button', { name: /Send/ }).click();
  await expect(page.locator('.message.user').last()).toContainText('What is a closure? In JavaScript? And why?');
  await waitForAnswer(page);
  expect(await chatUrls(page)).toEqual([expect.stringMatching(/\/api\/chat\/stream$/)]);
});

test("if a recorded question can't be answered, its words come back to the box", async ({ page }) => {
  // No fake answer: the test backend has no Gemini key, so the request fails.
  await page.locator('.mic-btn').click();
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__say('what is a pod'));
  await page.getByRole('button', { name: /Send/ }).click();
  await expect(page.locator('.error-banner')).toContainText('GEMINI_API_KEY');
  expect(await chatUrls(page)).toEqual([expect.stringContaining('/api/chat/stream-recording')]);
  await expect(page.getByLabel('Your message')).toHaveValue('what is a pod');
  await expect(page.getByRole('button', { name: 'Retry question' })).toBeVisible();
  // The error is right under the buttons, not at the bottom of the panel where it was off the screen.
  const banner = (await page.locator('.error-banner').boundingBox())!;
  const send = (await page.getByRole('button', { name: /Send/ }).boundingBox())!;
  const lengths = (await page.getByRole('group', { name: 'Interview answer length' }).boundingBox())!;
  expect(banner.y).toBeGreaterThan(send.y + send.height);
  expect(banner.y + banner.height).toBeLessThanOrEqual(lengths.y);
  // Retry sends the recording again, so Gemini can still write the question down; edited, it goes as its text.
  await page.getByRole('button', { name: 'Retry question' }).click();
  await expect.poll(() => chatUrls(page)).toHaveLength(2);
  expect((await chatUrls(page))[1]).toContain('/api/chat/stream-recording');
  await expect(page.locator('.error-banner')).toContainText('GEMINI_API_KEY');
  await page.getByLabel('Your message').fill('what is a pod in kubernetes');
  await page.getByRole('button', { name: 'Retry question' }).click();
  await expect.poll(() => chatUrls(page)).toHaveLength(3);
  expect((await chatUrls(page))[2]).toMatch(/\/api\/chat\/stream$/);
});

test('Gemini writing the text down can be turned off', async ({ page }) => {
  await page.getByLabel(/Improve the transcript/).uncheck();
  await forgetRequests(page);
  const mic = page.locator('.mic-btn');
  await mic.click();
  await page.evaluate(() => window.__say('no polishing please'));
  await expect(page.getByLabel('Your message')).toHaveValue('no polishing please'); // Chrome's words, at once
  await page.waitForTimeout(300);
  await mic.click();
  await expect(mic).toContainText('Start speaking');
  await page.waitForTimeout(500);
  expect(await transcribeRequests(page)).toBe(0);
  await expect(page.getByLabel('Your message')).toHaveValue('no polishing please');
});

test('hands-free sending sends the question Gemini wrote down', async ({ page }) => {
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
