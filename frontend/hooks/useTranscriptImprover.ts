import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

export type ImproveStatus = 'idle' | 'improving' | 'improved' | 'kept-edits' | 'failed';

// If Gemini takes longer than this, the live transcript is simply kept.
const TIMEOUT_MS = 8_000;

/** Gemini's transcript: its text (maybe empty), undefined if it failed, or null if nothing was recorded. */
type Transcript = Promise<string | undefined | null>;

type Options = {
  draftRef: { current: string };
  updateDraft: (value: string) => void;
  conversationId: string | null;
};

type Segment = {
  /** The draft before this dictation started. */
  prefix: string;
  /** What the draft should be if only dictation changed it. */
  expected: string;
  /** Whether the draft was typed in meanwhile. */
  typed: boolean;
  /** Started at the last pause, for the words dictated by then. */
  early?: { expected: string; transcript: Transcript };
  /** Started when listening stopped, for the whole recording. */
  final?: Transcript;
  /** The whole recording, in case neither of the above fits. */
  audio?: Promise<Blob | null>;
};

async function transcribe(id: string, audio: Promise<Blob | null>): Transcript {
  const blob = await audio;
  if (!blob) return null;
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

/**
 * After dictation, swaps the dictated part of the draft for Gemini's transcription of the
 * recording, which gets technical terms and punctuation right far more often than live
 * recognition. To save time, the recording is already sent at each pause; if no words follow,
 * that transcript is used. It never overwrites typing: if the draft changed after the last
 * dictated words, the draft is left as it is.
 */
export function useTranscriptImprover({ draftRef, updateDraft, conversationId }: Options) {
  const [enabled, setEnabledState] = useState(true);
  const enabledRef = useRef(true);
  const [status, setStatus] = useState<ImproveStatus>('idle');
  const segmentRef = useRef<Segment | null>(null);
  // Counts dictations, so a slow transcription can't change the draft once a new one has started.
  const dictationRef = useRef(0);
  const conversationRef = useRef(conversationId);
  useEffect(() => {
    conversationRef.current = conversationId;
  });

  const setEnabled = useCallback((on: boolean) => {
    enabledRef.current = on;
    setEnabledState(on);
  }, []);

  /** Call when dictation starts. */
  const begin = useCallback(() => {
    dictationRef.current += 1;
    segmentRef.current = { prefix: draftRef.current, expected: draftRef.current, typed: false };
    setStatus('idle');
  }, [draftRef]);

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

  /** Call at a pause in dictation, with the recording so far, to start transcribing it early. */
  const prefetch = useCallback(
    (audio: Promise<Blob | null>) => {
      const current = usable();
      if (current)
        current.segment.early = { expected: current.segment.expected, transcript: transcribe(current.id, audio) };
    },
    [usable],
  );

  /** Call as dictation stops, with the whole recording and whether words were still being recognized. */
  const prepare = useCallback(
    (audio: Promise<Blob | null>, wordsPending: boolean) => {
      const current = usable();
      if (!current) return;
      const { segment, id } = current;
      segment.audio = audio;
      // The transcript from the last pause will do, unless more words came after it.
      if (wordsPending || segment.early?.expected !== segment.expected) segment.final = transcribe(id, audio);
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
    const early = segment.early?.expected === segment.expected ? segment.early.transcript : undefined;
    const request = segment.final ?? early;
    if (!request && !segment.audio) return; // nothing was recorded
    const dictation = dictationRef.current;
    setStatus('improving');
    let text = request ? await request : null;
    // The early transcript had no audio (the recorder was still starting), or none fits: use the whole recording.
    if (text === null && !segment.final && segment.audio) text = await transcribe(id, segment.audio);
    if (dictationRef.current !== dictation) return; // a new dictation has started; leave its draft alone
    const draft = draftRef.current;
    if (text === null || (changed() && !draft.trim())) return setStatus('idle'); // nothing recorded, or sent/cleared
    if (text === undefined) return setStatus('failed');
    if (changed()) return setStatus('kept-edits');
    if (!text) return setStatus('idle');
    const { prefix } = segment;
    if (!believable(draft.slice(prefix.length), text)) return setStatus('failed');
    updateDraft(prefix + (prefix && !/\s$/.test(prefix) ? ' ' : '') + text);
    setStatus('improved');
  }, [draftRef, updateDraft]);

  return { enabled, setEnabled, status, begin, noteDictated, noteTyped, prefetch, prepare, improve };
}
