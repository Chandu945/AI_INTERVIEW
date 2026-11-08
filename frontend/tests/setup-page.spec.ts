import path from 'path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, chatRequests, forgetRequests, openApp } from './helpers';

// The New interview page.

const PDF_21_PAGES = path.join(__dirname, 'fixtures', '21-pages.pdf');
const SEEDED = ['Demo interview', 'Markdown showcase'];

type Listed = { id: string; title: string };
const listed = async (request: APIRequestContext) =>
  ((await (await request.get(`${API}/api/conversations`)).json()) as { sessions: Listed[] }).sessions;

/** What the summary beside the form says for one of its lines. */
const summaryOf = (page: Page, line: string) =>
  page
    .getByRole('complementary', { name: 'Summary' })
    .locator('div', { has: page.locator('dt', { hasText: line }) })
    .locator('dd');

async function openForm(page: Page) {
  await page.getByRole('button', { name: '+ New interview' }).click();
  await expect(page.getByRole('heading', { name: 'New interview' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await openForm(page);
});

// Interviews a test started go, so the other tests see only the seeded ones.
test.afterEach(async ({ request }) => {
  for (const session of await listed(request))
    if (!SEEDED.includes(session.title)) await request.delete(`${API}/api/conversations/${session.id}`);
});

test('Cmd+Enter on the New interview page does nothing', async ({ page }) => {
  await page.getByLabel('Job description').click();
  await forgetRequests(page);
  await page.keyboard.press('Meta+Enter');
  await page.waitForTimeout(300);
  await expect(page.locator('.error-banner')).toHaveCount(0);
  expect(await chatRequests(page)).toBe(0);
});

test('a resume can be picked or dropped, and removed; leaving the page empties the form', async ({ page }) => {
  const picker = page.locator('#setup-resume');
  const filesInPicker = () => picker.evaluate((input: HTMLInputElement) => input.files?.length ?? 0);
  await picker.setInputFiles(PDF_21_PAGES);
  await expect(page.locator('.file-chip')).toContainText('21-pages.pdf');
  await expect(summaryOf(page, 'Resume')).toHaveText('21-pages.pdf');
  await page.getByRole('button', { name: 'Remove' }).click();
  expect(await filesInPicker()).toBe(0);
  await expect(summaryOf(page, 'Resume')).toHaveText('None');

  const dropped = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(['%PDF-1.4'], 'dropped.pdf', { type: 'application/pdf' }));
    return data;
  });
  await page.locator('.dropzone').dispatchEvent('drop', { dataTransfer: dropped });
  await expect(page.locator('.file-chip')).toContainText('dropped.pdf');

  await page.getByRole('button', { name: 'Interviews', exact: true }).click();
  await openForm(page);
  await expect(page.locator('.file-chip')).toHaveCount(0);
  expect(await filesInPicker()).toBe(0);
});

test("a file that isn't a PDF or Word document, or is over 5 MB, is turned away", async ({ page }) => {
  const picker = page.locator('#setup-resume');
  await picker.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.locator('.field-error')).toHaveText('Use a PDF or Word (.docx) file.');
  const big = Buffer.alloc(6 * 1024 * 1024);
  await picker.setInputFiles({ name: 'big.pdf', mimeType: 'application/pdf', buffer: big });
  await expect(page.locator('.field-error')).toHaveText('That file is 6.0 MB. The limit is 5 MB.');
  await expect(page.locator('.file-chip')).toHaveCount(0);
});

test('a resume over 20 pages shows the page limit and leaves no empty interview behind', async ({ page, request }) => {
  const before = (await listed(request)).length;
  await page.locator('#setup-resume').setInputFiles(PDF_21_PAGES);
  await page.getByRole('button', { name: /Start interview/ }).click();
  await expect(page.locator('.error-banner')).toHaveText('Resume has 21 pages; the limit is 20');
  expect((await listed(request)).length).toBe(before);
});

test('the summary follows the choices, and the next new interview starts from them', async ({ page }) => {
  await page.getByLabel('Role', { exact: true }).fill('Platform Engineer');
  await page.getByRole('radio', { name: /^HR/ }).check();
  await page.getByRole('radio', { name: /^Detailed/ }).check();
  await page.getByRole('radio', { name: /^Technical.*senior/ }).check();
  await page.getByLabel('Job description').fill('Kubernetes, Terraform and on-call.');
  await expect(summaryOf(page, 'Role')).toHaveText('Platform Engineer');
  await expect(summaryOf(page, 'Interview type')).toHaveText('HR');
  await expect(summaryOf(page, 'Answer length')).toHaveText('Detailed');
  await expect(summaryOf(page, 'Answer style')).toHaveText('Technical');
  await expect(summaryOf(page, 'Job description')).toHaveText('4 words');

  await page.getByRole('button', { name: /Start interview/ }).click();
  await expect(page.locator('.topbar')).toContainText('Platform Engineer · HR');
  await expect(
    page.getByRole('group', { name: 'Interview answer length' }).locator('.answer-mode-button.selected'),
  ).toHaveText('Detailed');
  await expect(page.getByRole('group', { name: 'Answer style' }).locator('.answer-mode-button.selected')).toHaveText(
    'Technical',
  );

  await page.getByRole('button', { name: 'Back to interviews' }).click();
  await openForm(page);
  await expect(page.getByLabel('Role', { exact: true })).toHaveValue('Platform Engineer');
  await expect(page.getByRole('radio', { name: /^HR/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /^Detailed/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /^Technical.*senior/ })).toBeChecked();
  await expect(page.getByLabel('Job description')).toHaveValue(''); // only the role, type, length and style carry over
});

test('the interview needs a role to start', async ({ page }) => {
  await page.getByLabel('Role', { exact: true }).fill('');
  await expect(page.getByRole('button', { name: /Start interview/ })).toBeDisabled();
  await expect(summaryOf(page, 'Role')).toHaveText('—');
});
