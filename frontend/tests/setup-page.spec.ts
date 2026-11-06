import path from 'path';
import { expect, test } from '@playwright/test';
import { API, openApp } from './helpers';

const PDF_21_PAGES = path.join(__dirname, 'fixtures', '21-pages.pdf');

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('Cmd+Enter on the New Interview page does nothing', async ({ page }) => {
  await page.getByPlaceholder(/Paste a job description/).click();
  await page.keyboard.press('Meta+Enter');
  await page.waitForTimeout(300);
  await expect(page.locator('.error-banner')).toHaveCount(0);
});

test('Remove and + New Interview empty the resume file picker', async ({ page }) => {
  const picker = page.locator('#setup-resume');
  const filesInPicker = () => picker.evaluate((input: HTMLInputElement) => input.files?.length ?? 0);
  await picker.setInputFiles(PDF_21_PAGES);
  await page.getByRole('button', { name: 'Remove' }).click();
  expect(await filesInPicker()).toBe(0);
  await picker.setInputFiles(PDF_21_PAGES);
  await expect(page.locator('.attached-file')).toContainText('21-pages.pdf');
  await page.getByRole('button', { name: '+ New Interview' }).click();
  expect(await filesInPicker()).toBe(0);
});

test('a resume over 20 pages shows the page limit and leaves no empty interview behind', async ({ page, request }) => {
  const interviews = async () =>
    ((await (await request.get(`${API}/api/conversations`)).json()) as { sessions: unknown[] }).sessions.length;
  const before = await interviews();
  await page.locator('#setup-resume').setInputFiles(PDF_21_PAGES);
  await page.getByRole('button', { name: /Start Interview/ }).click();
  await expect(page.locator('.error-banner')).toHaveText('Resume has 21 pages; the limit is 20');
  expect(await interviews()).toBe(before);
});
