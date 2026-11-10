import { expect, test, type Page } from '@playwright/test';
import {
  API,
  chatRequests,
  chatUrls,
  cutPiece,
  forgetRequests,
  openApp,
  openInterview,
  waitForAnswer,
} from './helpers';

// Images with a question: added from the picker, pasted or dropped, uploaded at once, and sent
// with the question. Answers are faked (see helpers.ts); images go to the test backend.

// The smallest PNG: one pixel.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const png = (name: string) => ({ name, mimeType: 'image/png', buffer: PIXEL });

const picker = (page: Page) => page.getByLabel('Images to add');
const attachments = (page: Page) => page.locator('.attachment');

/** Where Start/Stop and Send are on the page. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const top = (selector: string) => Math.round(document.querySelector(selector)!.getBoundingClientRect().top);
    return { mic: top('.mic-btn'), send: top('.btn.primary') };
  });

/** Sends a made-up event carrying these files (a paste on the box, or a drop on it). */
async function deliver(page: Page, kind: 'paste' | 'drop', width = 1, height = 1) {
  await page.evaluate(
    async ({ kind, width, height }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.fillRect(0, 0, width, height);
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(made => resolve(made!), 'image/png'));
      const data = new DataTransfer();
      data.items.add(new File([blob], `${kind}.png`, { type: 'image/png' }));
      if (kind === 'paste')
        document
          .querySelector('textarea')!
          .dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      else {
        const box = document.querySelector('.editor-wrap')!;
        box.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
        box.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
      }
    },
    { kind, width, height },
  );
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await openInterview(page, 'Demo interview');
});

test('an image is uploaded as soon as it is added, without moving the buttons, and can be taken off', async ({
  page,
}) => {
  const before = await layout(page);
  await picker(page).setInputFiles(png('code.png'));
  await expect(page.locator('.attachment.ready')).toHaveCount(1);
  expect(await layout(page)).toEqual(before);
  const deleted = page.waitForRequest(request => request.method() === 'DELETE' && request.url().includes('/images/'));
  await page.getByRole('button', { name: 'Remove code.png' }).click();
  await deleted;
  await expect(attachments(page)).toHaveCount(0);
});

test('a pasted or dropped screenshot is attached, and a big one is shrunk first', async ({ page }) => {
  const uploaded = page.waitForResponse(response => response.url().endsWith('/images'));
  await deliver(page, 'paste', 3000, 1000);
  const { image_id } = (await (await uploaded).json()) as { image_id: string };
  const size = await page.evaluate(async url => {
    const image = await createImageBitmap(await (await fetch(url)).blob());
    return [image.width, image.height];
  }, `${API}/api/images/${image_id}`);
  expect(size).toEqual([2048, 683]);
  await deliver(page, 'drop');
  await expect(page.locator('.attachment.ready')).toHaveCount(2);
  await expect(page.getByLabel('Your message')).toHaveValue(''); // nothing pasted as text
});

test('a question goes with its images, which then show with it', async ({ page }) => {
  await page.evaluate(() => window.__streams(50, 3));
  await page.getByLabel('Your message').fill('What does this code print?');
  await picker(page).setInputFiles([png('one.png'), png('two.png')]);
  await expect(page.locator('.attachment.ready')).toHaveCount(2);
  await page.getByRole('button', { name: /Send/ }).click();
  await waitForAnswer(page);
  const body = await page.evaluate(() => window.__chatBodies[0]);
  expect(body).toMatchObject({ message: 'What does this code print?' });
  expect(body.image_ids).toHaveLength(2);
  const shown = page.locator('.message.user').last().locator('.message-images img');
  await expect(shown).toHaveCount(2);
  expect(await shown.first().evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1); // served
  await expect(attachments(page)).toHaveCount(0); // gone from the box
});

test('an image alone can be the question', async ({ page }) => {
  await page.evaluate(() => window.__streams(50, 3));
  const send = page.getByRole('button', { name: /Send/ });
  await expect(send).toBeDisabled();
  await picker(page).setInputFiles(png('problem.png'));
  await expect(send).toBeEnabled();
  await expect(page.locator('.attachment.ready')).toHaveCount(1);
  await send.click();
  await waitForAnswer(page);
  expect(await page.evaluate(() => window.__chatBodies[0])).toMatchObject({ message: '' });
  const question = page.locator('.message.user').last();
  await expect(question.locator('.message-images img')).toHaveCount(1);
  await expect(question.locator('.message-text')).toHaveCount(0);
});

test('a spoken question sent with its recording takes its images too', async ({ page }) => {
  await page.evaluate(() => {
    window.__streams(50, 3);
    window.__transcript = 'What does this print?';
  });
  await picker(page).setInputFiles(png('code.png'));
  await expect(page.locator('.attachment.ready')).toHaveCount(1);
  await page.locator('.mic-btn').click();
  await page.waitForTimeout(300); // the recorder is running
  await page.evaluate(() => window.__sayInterim('what does this print'));
  await page.getByRole('button', { name: /Send/ }).click();
  await waitForAnswer(page);
  const body = await page.evaluate(() => window.__chatBodies[0]);
  expect(body).toMatchObject({ heard: 'what does this print' });
  expect(String(body.image_ids)).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.locator('.message.user').last().locator('.message-images img')).toHaveCount(1);
});

test('only images can be added, and up to 4 of them', async ({ page }) => {
  await picker(page).setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
  await expect(page.locator('.error-banner')).toContainText('Only images can be added to a question.');
  await expect(attachments(page)).toHaveCount(0);
  await picker(page).setInputFiles(['a', 'b', 'c', 'd', 'e'].map(name => png(`${name}.png`)));
  await expect(page.locator('.error-banner')).toContainText('A question can have up to 4 images.');
  await expect(attachments(page)).toHaveCount(4);
  await expect(page.getByRole('button', { name: /Add image/ })).toBeDisabled();
});

test("if the question can't be answered, its images come back to send again", async ({ page }) => {
  // No fake answer: the test backend has no Gemini key, so the request fails.
  await page.getByLabel('Your message').fill('What does this print?');
  await picker(page).setInputFiles(png('code.png'));
  await expect(page.locator('.attachment.ready')).toHaveCount(1);
  await page.getByRole('button', { name: /Send/ }).click();
  await expect(page.locator('.error-banner')).toContainText('GEMINI_API_KEY');
  await expect(page.locator('.attachment.ready')).toHaveCount(1);
  await expect(page.getByLabel('Your message')).toHaveValue('What does this print?');
  await expect(page.getByRole('button', { name: 'Retry question' })).toBeVisible();
});

test("if an image can't be uploaded at Send, the dictated words stay, and Retry sends the recording", async ({
  page,
}) => {
  // Sent while words are still being heard, so the question goes with its recording.
  await page.route(`${API}/api/conversations/*/images`, route =>
    route.fulfill({ status: 500, json: { detail: 'Boom' } }),
  );
  await page.evaluate(() => {
    window.__streams(50, 3);
    window.__transcripts = ['What is RAG?'];
    window.__transcript = 'What is RAG?';
  });
  await page.locator('.mic-btn').click();
  await page.evaluate(() => window.__say('what is rag'));
  await page.waitForTimeout(500);
  await cutPiece(page);
  await expect(page.getByLabel('Your message')).toHaveValue('What is RAG?');
  await picker(page).setInputFiles(png('code.png'));
  await expect(page.locator('.attachment.failed')).toHaveCount(1);
  await forgetRequests(page);
  await page.evaluate(() => window.__sayInterim('and why')); // not written down yet
  await page.getByRole('button', { name: /Send/ }).click();
  await expect(page.locator('.error-banner')).toContainText("An image couldn't be uploaded");
  await expect(page.getByLabel('Your message')).toHaveValue('What is RAG? and why'); // the words aren't lost
  await expect(page.locator('.mic-btn')).toContainText('Start speaking');
  expect(await chatRequests(page)).toBe(0);
  await page.getByRole('button', { name: 'Remove code.png' }).click();
  await page.getByRole('button', { name: 'Retry question' }).click();
  await expect(page.locator('.message.user').last()).toContainText('What is RAG?');
  await waitForAnswer(page);
  expect(await chatUrls(page)).toEqual([expect.stringContaining('/api/chat/stream-recording')]); // the recording, kept
});

test('Clear takes the images off too', async ({ page }) => {
  await picker(page).setInputFiles(png('code.png'));
  await expect(page.locator('.attachment.ready')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(attachments(page)).toHaveCount(0);
});
