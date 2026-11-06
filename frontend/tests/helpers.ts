import { expect, type Page } from '@playwright/test';

/** The throwaway backend that playwright.config.ts starts. */
export const API = 'http://localhost:8100';

declare global {
  interface Window {
    __requests: string[];
    __fakeStream: null | ((url: string, heard: string) => Response);
    __emptyHistory: boolean;
    __streams: (intervalMs?: number, count?: number) => void;
    __replay: (events: object[], intervalMs?: number) => void;
    __say: (text: string) => void;
    __sayInterim: (text: string) => void;
    __transcript: string | null;
    __transcriptDelayMs: number;
    __transcripts: (string | null)[];
    __transcriptDelays: number[];
    __recognitionTrack: MediaStreamTrack | null;
    __tabShare: 'share' | 'cancel' | 'no-audio';
    __tabShares: number;
    __sharedTracks: MediaStreamTrack[];
    __stopSharing: () => void;
    __heard: string | null;
    __contexts: string[];
    __pieceTimings: { min: number; max: number; quiet: number; silence: number };
    __cutPiece?: () => boolean;
    __tabPauses: boolean;
  }
}

/**
 * Runs in the page before the app loads. Records every fetch, can fake a streamed answer and
 * an empty History list, and replaces speech recognition and Chrome's tab-sharing picker with
 * fakes the tests can control.
 */
function pageFakes() {
  window.__requests = [];
  window.__fakeStream = null;
  window.__emptyHistory = false;
  // When set, recordings are "transcribed" as this text instead of being sent to the test backend
  // (which has no Gemini key, so it answers 503). __transcripts and __transcriptDelays, when not
  // empty, give each request its own text and delay instead, in turn; a null text fails.
  window.__transcript = null;
  window.__transcriptDelayMs = 0;
  window.__transcripts = [];
  window.__heard = null;
  // The text so far sent with each piece.
  window.__contexts = [];
  // Pieces are cut only when a test says so (see cutPiece), and "stop after silence" goes by the
  // fake recognition alone (the fake mic beeps on and on).
  window.__pieceTimings = { min: 1e9, max: 1e9, quiet: 1e9, silence: 0 };
  window.__transcriptDelays = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = String(input);
    window.__requests.push(url);
    if (url.endsWith('/transcribe') && init?.body instanceof FormData)
      window.__contexts.push(String(init.body.get('context') ?? ''));
    if ((window.__transcript !== null || window.__transcripts.length) && url.endsWith('/transcribe')) {
      const text = window.__transcripts.length ? window.__transcripts.shift() : window.__transcript;
      if (text === null) return realFetch(input, init); // the test backend can't, so it fails
      const delay = window.__transcriptDelays.length ? window.__transcriptDelays.shift() : window.__transcriptDelayMs;
      const body = JSON.stringify({ text });
      const response = new Response(body, { headers: { 'Content-Type': 'application/json' } });
      return new Promise(resolve => setTimeout(() => resolve(response), delay));
    }
    if (window.__emptyHistory && !init?.method && url.endsWith('/api/conversations')) {
      const body = JSON.stringify({ sessions: [] });
      return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'application/json' } }));
    }
    if (window.__fakeStream && url.includes('/api/chat/stream')) {
      const heard = init?.body instanceof FormData ? String(init.body.get('heard') ?? '') : '';
      if (url.endsWith('/stream-recording')) window.__heard = heard;
      return Promise.resolve(window.__fakeStream(url, heard));
    }
    return realFetch(input, init);
  };

  // Answers with exactly these events, one every `intervalMs`.
  window.__replay = (events, intervalMs = 50) => {
    window.__fakeStream = () => {
      const encoder = new TextEncoder();
      let sent = 0;
      const stream = new ReadableStream({
        start(controller) {
          const timer = setInterval(() => {
            if (sent < events.length) controller.enqueue(encoder.encode(JSON.stringify(events[sent++]) + '\n'));
            else {
              clearInterval(timer);
              controller.close();
            }
          }, intervalMs);
        },
      });
      return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
    };
  };

  // Answers with `count` sentences, one every `intervalMs`.
  window.__streams = (intervalMs = 100, count = 40) => {
    window.__fakeStream = (url, heard) => {
      const encoder = new TextEncoder();
      const line = (event: object) => encoder.encode(JSON.stringify(event) + '\n');
      let sent = 0;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(line({ type: 'start' }));
          // A question sent as its recording: Gemini writes it down first (here, as __transcript).
          if (url.endsWith('/stream-recording'))
            controller.enqueue(line({ type: 'question', text: window.__transcript ?? heard }));
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
    // Given a track, recognition listens to it (a shared tab's sound) instead of the mic.
    start(track?: MediaStreamTrack) {
      window.__recognitionTrack = track ?? null;
    }
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
  // Words still being recognized (not final yet).
  window.__sayInterim = text => {
    const rec = recognitions[recognitions.length - 1];
    rec.onresult?.({
      resultIndex: rec.results.length,
      results: [...rec.results, { isFinal: false, 0: { transcript: text } }],
    });
  };

  // Chrome's share picker. `__tabShare` sets what it does: share a tab (its sound is a test
  // tone, or with `__tabPauses`, a tone that pauses for 0.4 s every second), close without
  // sharing, or share a tab without its sound.
  window.__recognitionTrack = null;
  window.__tabShare = 'share';
  window.__tabPauses = false;
  window.__tabShares = 0;
  window.__sharedTracks = [];
  navigator.mediaDevices.getDisplayMedia = async () => {
    window.__tabShares += 1;
    if (window.__tabShare === 'cancel') throw new DOMException('Permission denied by user', 'NotAllowedError');
    const tracks = document.createElement('canvas').captureStream().getVideoTracks();
    if (window.__tabShare === 'share') {
      const context = new AudioContext();
      const tone = context.createOscillator();
      const volume = context.createGain();
      const sound = context.createMediaStreamDestination();
      tone.connect(volume).connect(sound);
      if (window.__tabPauses)
        for (let second = 0; second < 120; second++) {
          volume.gain.setValueAtTime(1, context.currentTime + second);
          volume.gain.setValueAtTime(0, context.currentTime + second + 0.6);
        }
      tone.start();
      tracks.push(...sound.stream.getAudioTracks());
    }
    window.__sharedTracks = tracks;
    return new MediaStream(tracks);
  };
  // Like pressing Stop sharing in Chrome's sharing bar.
  window.__stopSharing = () => {
    for (const track of window.__sharedTracks) {
      track.stop();
      track.dispatchEvent(new Event('ended'));
    }
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

export function chatUrls(page: Page) {
  return page.evaluate(() => window.__requests.filter(url => url.includes('/api/chat')));
}

/**
 * Cuts the recording into a piece now, as a pause would (once there is something recorded). The
 * piece goes to Gemini with the words heard since the last cut. A piece's text may have at most
 * 3 words, plus 4.5 a second: wait a little before cutting one with more.
 */
export async function cutPiece(page: Page) {
  await page.waitForFunction(() => window.__cutPiece?.() === true);
}

export function transcribeRequests(page: Page) {
  return page.evaluate(() => window.__requests.filter(url => url.endsWith('/transcribe')).length);
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
