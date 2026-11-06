import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

export type ImproveStatus = 'idle' | 'improving' | 'improved' | 'kept-edits' | 'failed';

// If Gemini takes longer than this, the live transcript is simply kept.
const TIMEOUT_MS = 12_000;

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
};

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
 * recognition. It never overwrites typing: if the draft changed after the last dictated words,
 * the draft is left as it is.
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

  /** Call with the recording when dictation stops. Resolves once the draft is final. */
  const improve = useCallback(
    async (audio: Blob | null) => {
      const segment = segmentRef.current;
      segmentRef.current = null;
      const id = conversationRef.current;
      if (!audio || !segment || !id || !enabledRef.current) return;
      // Typed in, cleared or sent since? Then the draft is kept as it is.
      const changed = () => segment.typed || draftRef.current !== segment.expected;
      if (changed()) return setStatus(draftRef.current.trim() ? 'kept-edits' : 'idle'); // no need to ask Gemini
      const dictation = dictationRef.current;
      setStatus('improving');
      let text: string | undefined;
      try {
        const response = await api.transcribe(id, audio, AbortSignal.timeout(TIMEOUT_MS));
        if (!response.ok) throw new Error(`Transcription failed (${response.status})`);
        text = ((await response.json()) as { text?: string }).text?.trim();
      } catch {
        text = undefined;
      }
      if (dictationRef.current !== dictation) return; // a new dictation has started; leave its draft alone
      const draft = draftRef.current;
      if (changed() && !draft.trim()) return setStatus('idle'); // sent or cleared
      if (text === undefined) return setStatus('failed');
      if (changed()) return setStatus('kept-edits');
      if (!text) return setStatus('idle');
      const { prefix } = segment;
      if (!believable(draft.slice(prefix.length), text)) return setStatus('failed');
      updateDraft(prefix + (prefix && !/\s$/.test(prefix) ? ' ' : '') + text);
      setStatus('improved');
    },
    [draftRef, updateDraft],
  );

  return { enabled, setEnabled, status, begin, noteDictated, noteTyped, improve };
}
