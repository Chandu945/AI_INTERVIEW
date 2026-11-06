import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

export type ImproveStatus = 'idle' | 'improving' | 'improved' | 'kept-edits' | 'failed' | 'too-long';
/** A dictated question's recording and live words, to send it with before its transcript is final. */
export type HandOff = { audio: Blob; heard: string };

// If Gemini takes longer than this, the live transcript is simply kept.
const TIMEOUT_MS = 8_000;
// About 2 minutes of the recorder's 16 kHz 16-bit audio (32,000 bytes a second), a long question:
// the most a question is sent with, and, as a tab can talk on and on (a class, say), the most of
// a tab that is improved.
const TWO_MINUTES = 120 * 32_000;
// A tab pauses after nearly every sentence, and the answers share Gemini's free per-minute
// limit, so a tab sends at most 3 transcriptions at once, and after that one every 6 seconds.
const TAB_BURST = 3;
const TAB_REFILL_MS = 6_000;
/** Stands in for a transcript when the recording is too long to improve. */
const TOO_LONG = Symbol('too long');

/**
 * Gemini's transcript: its text (maybe empty), undefined if it failed, null if nothing was
 * recorded, or TOO_LONG.
 */
type Text = string | undefined | null | typeof TOO_LONG;
type Transcript = Promise<Text>;

type Options = {
  draftRef: { current: string };
  updateDraft: (value: string) => void;
  conversationId: string | null;
};

/** A transcription started at a pause, for the words dictated by then. */
type Early = {
  /** The draft when it started, kept in step with the transcripts swapped in since. */
  expected: string;
  transcript: Transcript;
  /** Counts the pauses, so an older transcript never replaces a newer one. */
  seq: number;
};

type Segment = {
  /** The draft before this dictation started. */
  prefix: string;
  /** What the draft should be if only dictation (and its transcripts) changed it. */
  expected: string;
  /** Whether the draft was typed in meanwhile. */
  typed: boolean;
  /** Listening to a shared tab rather than the mic. */
  fromTab: boolean;
  /** How many transcriptions were started at pauses. */
  pauses: number;
  /** The latest of them. */
  early?: Early;
  /** The latest one swapped in while listening, and the draft up to the end of its text. */
  appliedSeq: number;
  polished?: string;
  /** Whether the recording got too long to improve. */
  tooLong?: boolean;
  /** Whether the question was sent with its recording, so its transcript must leave the draft alone. */
  handedOver?: boolean;
  /** Started when listening stopped, for the whole recording. */
  final?: Transcript;
  /** The whole recording, in case none of the above fits. */
  audio?: Promise<Blob | null>;
};

async function transcribe(id: string, audio: Promise<Blob | null>, maxBytes = Infinity): Transcript {
  const blob = await audio;
  if (!blob) return null;
  if (blob.size > maxBytes) return TOO_LONG;
  try {
    const response = await api.transcribe(id, blob, AbortSignal.timeout(TIMEOUT_MS));
    if (!response.ok) return undefined;
    return ((await response.json()) as { text?: string }).text?.trim() ?? '';
  } catch {
    return undefined;
  }
}

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * Whether Gemini's transcript is close enough in length to the live words to replace them. Much
 * shorter means part of the recording is missing; much longer means Gemini added words (or
 * answered the question instead of writing it down).
 */
function believable(live: string, transcript: string) {
  const heard = countWords(live);
  if (!heard) return true; // nothing was recognized live, so there is nothing to compare with
  const words = countWords(transcript);
  return words >= heard / 2 && words <= heard * 2 + 8;
}

/** The text after the prefix, with a space between them if needed. */
const join = (prefix: string, text: string) => prefix + (prefix && !/\s$/.test(prefix) ? ' ' : '') + text;

/**
 * Swaps the dictated part of the draft for Gemini's transcription of the recording, which gets
 * technical terms and punctuation right far more often than live recognition. It does so as you
 * go: at each pause, the recording so far is transcribed, and its text replaces the words it
 * covers as soon as it is back, while later words keep arriving after it. So when listening
 * stops, the text is usually final already; if not, the rest is transcribed then. A tab sends
 * fewer transcriptions (see TAB_BURST), and none past 2 minutes. Typing is never overwritten:
 * once the draft is typed in, it is left as it is.
 */
export function useTranscriptImprover({ draftRef, updateDraft, conversationId }: Options) {
  const [enabled, setEnabledState] = useState(true);
  const enabledRef = useRef(true);
  const [status, setStatus] = useState<ImproveStatus>('idle');
  const segmentRef = useRef<Segment | null>(null);
  // The dictation whose transcript improve() is waiting for, so handOver() can still take it.
  const improvingRef = useRef<Segment | null>(null);
  // Counts dictations, so a slow transcription can't change the draft once a new one has started.
  const dictationRef = useRef(0);
  const conversationRef = useRef(conversationId);
  useEffect(() => {
    conversationRef.current = conversationId;
  });
  // How many transcriptions a tab may send now (see TAB_BURST), and when that was worked out.
  const tabAllowanceRef = useRef({ requests: TAB_BURST, at: 0 });

  const setEnabled = useCallback((on: boolean) => {
    enabledRef.current = on;
    setEnabledState(on);
  }, []);

  /** Call when dictation starts, saying whether it listens to a shared tab rather than the mic. */
  const begin = useCallback(
    (fromTab = false) => {
      dictationRef.current += 1;
      const draft = draftRef.current;
      segmentRef.current = { prefix: draft, expected: draft, typed: false, fromTab, pauses: 0, appliedSeq: 0 };
      setStatus('idle');
    },
    [draftRef],
  );

  /** Call after recognized words are added to the draft. */
  const noteDictated = useCallback(() => {
    if (segmentRef.current) segmentRef.current.expected = draftRef.current;
  }, [draftRef]);

  /** Call when the draft is typed in, so dictation can't overwrite it. */
  const noteTyped = useCallback(() => {
    if (segmentRef.current) segmentRef.current.typed = true;
  }, []);

  /** The current dictation, if its transcript may still be used. */
  const usable = useCallback(() => {
    const segment = segmentRef.current;
    const id = conversationRef.current;
    return segment && !segment.typed && id && enabledRef.current ? { segment, id } : null;
  }, []);

  /** Whether a tab may send another transcription now (see TAB_BURST). */
  const takeTabTurn = useCallback(() => {
    const allowance = tabAllowanceRef.current;
    const now = Date.now();
    allowance.requests = Math.min(TAB_BURST, allowance.requests + (now - allowance.at) / TAB_REFILL_MS);
    allowance.at = now;
    if (allowance.requests < 1) return false;
    allowance.requests -= 1;
    return true;
  }, []);

  /** Swaps in a transcript that came back while listening, if it is the newest and nothing it covers changed. */
  const swapIn = useCallback(
    (segment: Segment, early: Early, text: Text) => {
      if (text === TOO_LONG) segment.tooLong = true;
      if (segmentRef.current !== segment || !enabledRef.current || typeof text !== 'string' || !text) return;
      const draft = draftRef.current;
      if (early.seq <= segment.appliedSeq || segment.typed || draft !== segment.expected) return;
      if (!draft.startsWith(early.expected) || !believable(early.expected.slice(segment.prefix.length), text)) return;
      const polished = join(segment.prefix, text);
      // A newer transcription, still on its way, covers these words too: keep its idea of the draft in step.
      const latest = segment.early;
      if (latest && latest !== early && latest.expected.startsWith(early.expected))
        latest.expected = polished + latest.expected.slice(early.expected.length);
      segment.appliedSeq = early.seq;
      segment.polished = polished;
      segment.expected = polished + draft.slice(early.expected.length);
      updateDraft(segment.expected);
    },
    [draftRef, updateDraft],
  );

  /** Call at a pause in dictation, with a way to get the recording so far, to transcribe it then. */
  const prefetch = useCallback(
    (recording: () => Promise<Blob | null>) => {
      const current = usable();
      if (!current) return;
      const { segment, id } = current;
      if (segment.fromTab && (segment.tooLong || !takeTabTurn())) return;
      segment.pauses += 1;
      const early: Early = {
        expected: segment.expected,
        transcript: transcribe(id, recording(), segment.fromTab ? TWO_MINUTES : Infinity),
        seq: segment.pauses,
      };
      segment.early = early;
      void early.transcript.then(text => swapIn(segment, early, text));
    },
    [swapIn, takeTabTurn, usable],
  );

  /** Call as dictation stops, with the whole recording and whether words were still being recognized. */
  const prepare = useCallback(
    (audio: Promise<Blob | null>, wordsPending: boolean) => {
      const current = usable();
      if (!current) return;
      const { segment, id } = current;
      segment.audio = audio;
      // Nothing more to send if the last pause's transcript is in, or on its way, and no words came after it.
      const upToDate = segment.polished === segment.expected || segment.early?.expected === segment.expected;
      if (wordsPending || !upToDate) segment.final = transcribe(id, audio, segment.fromTab ? TWO_MINUTES : Infinity);
    },
    [usable],
  );

  /** Call once dictation has stopped and its last words are in. Resolves once the draft is final. */
  const improve = useCallback(async () => {
    const segment = segmentRef.current;
    segmentRef.current = null;
    const id = conversationRef.current;
    if (!segment || !id || !enabledRef.current) return;
    // Typed in, cleared or sent since? Then the draft is kept as it is.
    const changed = () => segment.typed || draftRef.current !== segment.expected;
    if (changed()) return setStatus(draftRef.current.trim() ? 'kept-edits' : 'idle');
    // The last pause's transcript is already in, and no words came after it.
    if (!segment.final && segment.polished === segment.expected) return setStatus('improved');
    const early = segment.early?.expected === segment.expected ? segment.early.transcript : undefined;
    const request = segment.final ?? early;
    if (!request && !segment.audio) return; // nothing was recorded
    const dictation = dictationRef.current;
    setStatus('improving');
    improvingRef.current = segment;
    let text: Text;
    try {
      text = request ? await request : null;
      // The early transcript had no audio (the recorder was still starting), or none fits: use the whole recording.
      if (text === null && !segment.final && segment.audio)
        text = await transcribe(id, segment.audio, segment.fromTab ? TWO_MINUTES : Infinity);
    } finally {
      if (improvingRef.current === segment) improvingRef.current = null;
    }
    if (dictationRef.current !== dictation) return; // a new dictation has started; leave its draft alone
    if (segment.handedOver) return setStatus('idle'); // sent with its recording already
    const draft = draftRef.current;
    if (text === null || (changed() && !draft.trim())) return setStatus('idle'); // nothing recorded, or sent/cleared
    if (text === undefined) return setStatus('failed');
    if (text === TOO_LONG) return setStatus('too-long');
    if (changed()) return setStatus('kept-edits');
    if (!text) return setStatus('idle');
    if (!believable(draft.slice(segment.prefix.length), text)) return setStatus('failed');
    updateDraft(join(segment.prefix, text));
    setStatus('improved');
  }, [draftRef, updateDraft]);

  /**
   * Call when sending, once dictation's last words are in. If the transcript isn't final yet,
   * returns the recording and the live words, so the question can go at once and Gemini writes it
   * down while answering it, and keeps the transcript from changing the draft later. Null if the
   * draft is final already or was typed in (then its text is sent as it is), or if part of the
   * question was in the box before dictating.
   */
  const handOver = useCallback(async (): Promise<HandOff | null> => {
    const segment = segmentRef.current ?? improvingRef.current;
    if (!segment?.audio || segment.handedOver || !enabledRef.current || segment.prefix.trim()) return null;
    const settled = () =>
      segment.typed || draftRef.current !== segment.expected || segment.polished === segment.expected;
    if (settled()) return null;
    const audio = await segment.audio;
    if (!audio || audio.size > TWO_MINUTES || settled() || segment.handedOver) return null;
    segment.handedOver = true;
    return { audio, heard: draftRef.current.trim() };
  }, [draftRef]);

  return { enabled, setEnabled, status, begin, noteDictated, noteTyped, prefetch, prepare, improve, handOver };
}
