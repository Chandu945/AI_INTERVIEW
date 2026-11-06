import { expect, type Page } from '@playwright/test';

/** The throwaway backend that playwright.config.ts starts. */
export const API = 'http://localhost:8100';

declare global {
  interface Window {
    __requests: string[];
    __fakeStream: null | (() => Response);
    __emptyHistory: boolean;
    __streams: (intervalMs?: number, count?: number) => void;
    __say: (text: string) => void;
  }
}

/**
 * Runs in the page before the app loads. Records every fetch, can fake a streamed answer and
 * an empty History list, and replaces speech recognition with a fake the tests can "speak" into.
 */
function pageFakes() {
  window.__requests = [];
  window.__fakeStream = null;
  window.__emptyHistory = false;
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = String(input);
    window.__requests.push(url);
    if (window.__emptyHistory && !init?.method && url.endsWith('/api/conversations')) {
      const body = JSON.stringify({ sessions: [] });
      return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'application/json' } }));
    }
    if (window.__fakeStream && url.includes('/api/chat/stream')) return Promise.resolve(window.__fakeStream());
    return realFetch(input, init);
  };

  // Answers with `count` sentences, one every `intervalMs`.
  window.__streams = (intervalMs = 100, count = 40) => {
    window.__fakeStream = () => {
      const encoder = new TextEncoder();
      const line = (event: object) => encoder.encode(JSON.stringify(event) + '\n');
      let sent = 0;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(line({ type: 'start' }));
          const timer = setInterval(() => {
            sent += 1;
            if (sent <= count) {
              controller.enqueue(
                line({
                  type: 'delta',
                  text: `Sentence ${sent} of a long streamed answer that keeps growing line after line. `,
                }),
              );
            } else {
              clearInterval(timer);
              controller.enqueue(line({ type: 'done', first_token_ms: 100, total_ms: 4000 }));
              controller.close();
            }
          }, intervalMs);
        },
      });
      return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
    };
  };

  type Result = { isFinal: boolean; 0: { transcript: string } };
  type Handler<T> = ((event: T) => void) | null;
  const recognitions: FakeRecognition[] = [];
  class FakeRecognition {
    onresult: Handler<{ resultIndex: number; results: Result[] }> = null;
    onerror: Handler<{ error: string }> = null;
    onend: (() => void) | null = null;
    results: Result[] = [];
    constructor() {
      recognitions.push(this);
    }
    start() {}
    stop() {
      setTimeout(() => this.onend?.(), 30);
    }
    abort() {}
  }
  for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) {
    Object.defineProperty(window, name, { value: FakeRecognition, configurable: true, writable: true });
  }
  window.__say = text => {
    const rec = recognitions[recognitions.length - 1];
    rec.results.push({ isFinal: true, 0: { transcript: text } });
    rec.onresult?.({ resultIndex: rec.results.length - 1, results: rec.results });
  };
}

/** Opens the app with the fakes installed and waits until it has loaded its interviews. */
export async function openApp(page: Page) {
  await page.addInitScript(pageFakes);
  await page.goto('/');
  await page.waitForFunction(() => window.__requests.some(url => url.endsWith('/api/conversations')));
}

export async function openInterview(page: Page, title: string) {
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.locator('.history-card-open', { hasText: title }).click();
  await expect(page.locator('.conversation-body .message').first()).toBeVisible();
}

export async function sendQuestion(page: Page, text: string) {
  await page.getByLabel('Your message').fill(text);
  await page.getByRole('button', { name: /Send/ }).click();
}

export async function waitForAnswer(page: Page) {
  await expect(page.getByRole('button', { name: /Sending/ })).toHaveCount(0, { timeout: 15_000 });
}

export function chatRequests(page: Page) {
  return page.evaluate(() => window.__requests.filter(url => url.includes('/api/chat')).length);
}

export async function forgetRequests(page: Page) {
  await page.evaluate(() => {
    window.__requests.length = 0;
  });
}

export async function interviewId(
  request: { get: (url: string) => Promise<{ json: () => Promise<unknown> }> },
  title: string,
) {
  const { sessions } = (await (await request.get(`${API}/api/conversations`)).json()) as {
    sessions: { id: string; title: string }[];
  };
  return sessions.find(s => s.title === title)!.id;
}
