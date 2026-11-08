import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, openApp, openInterview } from './helpers';

// The Interviews page, where the app starts, and the top bar during an interview.

const SEEDED = ['Demo interview', 'Markdown showcase'];

type Listed = { id: string; title: string; target_role: string };
const listed = async (request: APIRequestContext) =>
  ((await (await request.get(`${API}/api/conversations`)).json()) as { sessions: Listed[] }).sessions;

/** Makes an interview through the API, and shows the page again with it. Deleted after the test. */
async function makeInterview(page: Page, request: APIRequestContext, fields: object) {
  await request.post(`${API}/api/conversations`, { data: fields });
  await page.reload();
}

const row = (page: Page, text: string) => page.locator('.interview-row', { hasText: text });

async function menu(page: Page, text: string, item: string) {
  await row(page, text)
    .getByRole('button', { name: /More actions/ })
    .click();
  await page.getByRole('menuitem', { name: item }).click();
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

// Interviews the tests made (or the app made for them) go, so the other tests see only the seeded ones.
test.afterEach(async ({ request }) => {
  for (const session of await listed(request))
    if (!SEEDED.includes(session.title)) await request.delete(`${API}/api/conversations/${session.id}`);
});

test('interviews are listed by day, with how many questions each has and the last one asked', async ({ page }) => {
  const today = page.getByRole('region', { name: 'Today' });
  const earlier = page.getByRole('region', { name: 'Earlier' });
  await expect(today.locator('.interview-row')).toHaveCount(1);
  await expect(today).toContainText('Demo interview');
  await expect(today).toContainText('GenAI Developer');
  await expect(today).toContainText('3 questions');
  await expect(today).toContainText('Last question: Explain FastAPI dependency injection.');
  await expect(earlier).toContainText('Markdown showcase');
  await expect(earlier).toContainText('2 questions');
  await expect(earlier.locator('.interview-time')).toHaveText('Jan 1, 2000');
});

test('search and the type filters narrow the list', async ({ page }) => {
  const rows = page.locator('.interview-row');
  const search = page.getByLabel('Search interviews');
  await search.fill('fastapi'); // in the demo interview's last question
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Demo interview');
  await search.fill('');
  await expect(rows).toHaveCount(2);
  await page.getByRole('button', { name: /^HR/ }).click();
  await expect(rows).toHaveCount(0);
  await expect(page.getByText('No interviews match your search.')).toBeVisible();
  await page.getByRole('button', { name: 'Show all interviews' }).click();
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');
});

test('an interview is renamed in place; Esc leaves it as it was', async ({ page, request }) => {
  await makeInterview(page, request, { target_role: 'Test Engineer' });
  const title = row(page, 'Test Engineer').locator('.interview-title');
  await menu(page, 'Test Engineer', 'Rename');
  await page.getByLabel('Interview title').fill('Mock round 1');
  await page.keyboard.press('Enter');
  await expect(title).toHaveText('Mock round 1');
  await menu(page, 'Test Engineer', 'Rename');
  await page.getByLabel('Interview title').fill('Not this');
  await page.keyboard.press('Escape');
  await expect(title).toHaveText('Mock round 1');
  await page.reload(); // it was saved
  await expect(title).toHaveText('Mock round 1');
});

test('deleting asks first, and Cancel keeps the interview', async ({ page, request }) => {
  await makeInterview(page, request, { target_role: 'Throwaway Role' });
  const dialog = page.getByRole('dialog');
  await menu(page, 'Throwaway Role', 'Delete…');
  await expect(dialog).toContainText('“New Interview” and its questions, answers and resume will be deleted.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, 'Throwaway Role')).toHaveCount(1);
  await menu(page, 'Throwaway Role', 'Delete…');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(row(page, 'Throwaway Role')).toHaveCount(0);
  expect((await listed(request)).some(session => session.target_role === 'Throwaway Role')).toBe(false);
});

test('"Start new with same setup" opens a fresh interview with the same role, type, length and style', async ({
  page,
  request,
}) => {
  await makeInterview(page, request, {
    target_role: 'Data Engineer',
    interview_type: 'HR',
    mode: 'detailed',
    style: 'technical',
  });
  await menu(page, 'Data Engineer', 'Start new with same setup');
  const bar = page.locator('.topbar');
  await expect(bar).toContainText('New Interview');
  await expect(bar).toContainText('Data Engineer · HR');
  await expect(page.locator('.empty-state')).toContainText('Ready when you are');
  await expect(
    page.getByRole('group', { name: 'Interview answer length' }).locator('.answer-mode-button.selected'),
  ).toHaveText('Detailed');
  await expect(page.getByRole('group', { name: 'Answer style' }).locator('.answer-mode-button.selected')).toHaveText(
    'Technical',
  );
  await page.getByRole('button', { name: 'Back to interviews' }).click();
  await expect(row(page, 'Data Engineer')).toHaveCount(2);
});

test('with no interviews yet, the page invites you to start one', async ({ page }) => {
  await page.route(`${API}/api/conversations`, route =>
    route.request().method() === 'GET' ? route.fulfill({ json: { sessions: [] } }) : route.fallback(),
  );
  await page.reload();
  const empty = page.locator('.empty-card');
  await expect(empty).toContainText('No interviews yet');
  await empty.getByRole('button', { name: '+ New interview' }).click();
  await expect(page.getByRole('heading', { name: 'New interview' })).toBeVisible();
});

test('during an interview, the top bar has only the way back, and its title and details', async ({ page }) => {
  await openInterview(page, 'Demo interview');
  const bar = page.locator('.topbar');
  await expect(bar.getByRole('button')).toHaveCount(2); // back, and the title (to rename it)
  await expect(bar).toContainText('Demo interview');
  await expect(bar).toContainText('GenAI Developer · Technical');
  await expect(bar).not.toContainText('New interview');
  await expect(bar).not.toContainText('History');
  await page.getByRole('button', { name: 'Back to interviews' }).click();
  await expect(page.getByRole('heading', { name: 'Interviews' })).toBeVisible();
});

test("an interview's title can be renamed from the top bar", async ({ page, request }) => {
  await makeInterview(page, request, { target_role: 'Header Test' });
  await page.locator('.interview-open', { hasText: 'Header Test' }).click();
  const bar = page.locator('.topbar');
  await bar.getByRole('button', { name: 'New Interview' }).click();
  await page.getByLabel('Interview title').fill('Header renamed');
  await page.keyboard.press('Enter');
  await expect(bar.locator('h1')).toHaveText('Header renamed');
  await page.getByRole('button', { name: 'Back to interviews' }).click();
  await expect(row(page, 'Header Test').locator('.interview-title')).toHaveText('Header renamed');
});
