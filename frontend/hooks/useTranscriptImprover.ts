import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { encodeWav } from '../lib/wav';
import type { HeardPiece } from './useSpeechRecognition';

export type ImproveStatus = 'idle' | 'improving' | 'improved' | 'failed';
/** A dictated question's recording and words so far, to send it with before all its text is in. */
export type HandOff = { audio: Blob; heard: string };

// If Gemini takes longer than this for a piece, the piece is tried again.
const TIMEOUT_MS = 8_000;
const SAMPLE_RATE = 16_000;
// About 2 minutes of the recorder's 16 kHz 16-bit audio (32,000 bytes a second), a long question:
// the most a question is sent with.
const TWO_MINUTES = 120 * 32_000;
// Nobody says more words than this a second (give or take a few): more means Gemini made them up.
const WORDS_PER_SECOND = 4.5;
// How much of the text so far goes with a piece, so Gemini can carry on from it.
const CONTEXT_WORDS = 30;

type Options = {
  draftRef: { current: string };
  updateDraft: (value: string) => void;
  conversationId: string | null;
};

/** One stretch of listening, from start to stop. */
type Dictation = {
  /** Its text so far: Gemini's words for its pieces (Chrome's, where Gemini couldn't). */
  text: string;
  /** Whether the draft was typed in meanwhile. */
  typed: boolean;
  /** How many pieces, and how many seconds of them, it has had. */
  pieces: number;
  seconds: number;
  /** Listening stopped, so no more pieces will come. */
  stopped: boolean;
  /** Sent with its recording, or thrown away (say, by Clear): its pieces are dropped. */
  dropped: boolean;
  /** Some of its words are Chrome's, because Gemini couldn't write them down. */
  usedChrome: boolean;
  /** The whole recording, once listening stopped. */
  audio?: Promise<Blob | null>;
};

/**
 * A piece waiting for Gemini. `failed`: Gemini couldn't write it down, so it goes again with the
 * next piece (or on its own, once listening has stopped); `lastTry`: this is that second go.
 */
type Waiting = HeardPiece & { dictation: Dictation; failed?: boolean; lastTry?: boolean };

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;
const join = (a: string, b: string) => [a.trim(), b.trim()].filter(Boolean).join(' ');

function merge(a: Waiting, b: Waiting): Waiting {
  const samples = new Float32Array(a.samples.length + b.samples.length);
  samples.set(a.samples);
  samples.set(b.samples, a.samples.length);
  return {
    samples,
    seconds: a.seconds + b.seconds,
    speech: a.speech || b.speech,
    heard: join(a.heard, b.heard),
    dictation: a.dictation,
  };
}

/** Gemini's text for a piece: '' if no one spoke, undefined if it failed or made words up. */
async function transcribe(id: string, piece: Waiting, context: string): Promise<string | undefined> {
  try {
    const audio = encodeWav(piece.samples, SAMPLE_RATE);
    const response = await api.transcribe(id, audio, AbortSignal.timeout(TIMEOUT_MS), context);
    if (!response.ok) return undefined;
    const text = ((await response.json()) as { text?: string }).text?.trim() ?? '';
    return countWords(text) <= piece.seconds * WORDS_PER_SECOND + 3 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Has Gemini write dictation down, piece by piece, which gets every word, technical terms and
 * punctuation right far more often than Chrome's live recognition. The recording is cut into
 * pieces at quiet moments as it goes; each goes to Gemini with the end of the text so far, and its
 * text is added to the draft when it is back, 1 to 2 seconds later. Meanwhile the words Chrome
 * heard in it are shown in gray (`waiting`). Pieces are written down one at a time, in order. A
 * piece Gemini can't write down goes again with the next one (or on its own, once listening has
 * stopped); if that fails too, Chrome's words for it are used. Once all of that text is in, it's
 * the question; sent sooner, the question goes with its recording (see handOver), for Gemini to
 * write down as a whole.
 */
export function useTranscriptImprover({ draftRef, updateDraft, conversationId }: Options) {
  const [enabled, setEnabledState] = useState(true);
  const enabledRef = useRef(true);
  const [status, setStatus] = useState<ImproveStatus>('idle');
  // Chrome's words for the pieces waiting for Gemini, shown in gray until their text is in.
  const [waiting, setWaiting] = useState('');
  const queueRef = useRef<Waiting[]>([]);
  const workingRef = useRef(false);
  const dictationRef = useRef<Dictation | null>(null);
  // Waiting for a dictation's pieces to be all in.
  const waitersRef = useRef<{ dictation: Dictation; resolve: () => void }[]>([]);
  const conversationRef = useRef(conversationId);
  useEffect(() => {
    conversationRef.current = conversationId;
  });

  const setEnabled = useCallback((on: boolean) => {
    enabledRef.current = on;
    setEnabledState(on);
  }, []);

  const pendingFor = (dictation: Dictation) => queueRef.current.some(piece => piece.dictation === dictation);
  /** Chrome's words for the pieces waiting for Gemini. */
  const waitingWords = useCallback(
    () =>
      queueRef.current
        .map(piece => piece.heard)
        .filter(Boolean)
        .join(' '),
    [],
  );

  /** Updates the gray words, and lets know whoever waits for a dictation whose pieces are all in. */
  const changed = useCallback(() => {
    queueRef.current = queueRef.current.filter(piece => !piece.dictation.dropped);
    setWaiting(waitingWords());
    waitersRef.current = waitersRef.current.filter(waiter => {
      if (pendingFor(waiter.dictation)) return true;
      waiter.resolve();
      return false;
    });
  }, [waitingWords]);

  /** Writes the waiting pieces down, one at a time, in order. */
  const work = useCallback(async () => {
    if (workingRef.current) return;
    workingRef.current = true;
    try {
      while (queueRef.current.length) {
        const piece = queueRef.current[0];
        const { dictation } = piece;
        if (piece.failed) {
          // It goes again with the next piece of its dictation, or on its own once no more will
          // come; until then, it waits.
          const next = queueRef.current[1];
          if (next?.dictation === dictation) queueRef.current.splice(0, 2, { ...merge(piece, next), lastTry: true });
          else if (dictation.stopped) Object.assign(piece, { failed: false, lastTry: true });
          else break;
          continue;
        }
        const id = conversationRef.current;
        const context = draftRef.current.split(/\s+/).slice(-CONTEXT_WORDS).join(' ');
        let text: string | undefined = '';
        if (!id)
          text = piece.heard; // nowhere to send it
        else if (piece.speech || piece.heard) text = await transcribe(id, piece, context);
        if (dictation.dropped) {
          changed();
          continue;
        }
        if (text === undefined && !piece.lastTry) {
          piece.failed = true;
          continue;
        }
        if (text === undefined || (!text && piece.heard)) {
          // The second go failed too, or Gemini heard no one where Chrome heard words: Chrome's
          // words will have to do.
          text = piece.heard;
          dictation.usedChrome = true;
        }
        queueRef.current.shift();
        if (text.trim()) {
          dictation.text = join(dictation.text, text);
          updateDraft(join(draftRef.current, text));
        }
        changed();
      }
    } finally {
      workingRef.current = false;
    }
  }, [changed, draftRef, updateDraft]);

  /** Call when dictation starts, before its pieces come. */
  const begin = useCallback(() => {
    dictationRef.current = {
      text: '',
      typed: false,
      pieces: 0,
      seconds: 0,
      stopped: false,
      dropped: false,
      usedChrome: false,
    };
    setStatus('idle');
  }, []);

  /** Call when the draft is typed in: the question then goes as its text, not its recording. */
  const noteTyped = useCallback(() => {
    if (dictationRef.current) dictationRef.current.typed = true;
  }, []);

  /** Call with each piece of the recording, as it's cut. */
  const addPiece = useCallback(
    (piece: HeardPiece) => {
      const dictation = dictationRef.current;
      if (!dictation || dictation.dropped) return;
      dictation.pieces += 1;
      dictation.seconds += piece.seconds;
      queueRef.current.push({ ...piece, dictation });
      changed();
      void work();
    },
    [changed, work],
  );

  /** Call as listening stops, with the whole recording. */
  const prepare = useCallback((audio: Promise<Blob | null>) => {
    if (dictationRef.current) dictationRef.current.audio = audio;
  }, []);

  /** Call when listening has ended, however it ended: no more pieces will come. */
  const end = useCallback(() => {
    const dictation = dictationRef.current;
    if (!dictation || dictation.stopped) return;
    dictation.stopped = true;
    void work(); // a piece waiting for a next one goes on its own now
  }, [work]);

  /** Call once listening has stopped. Resolves once all its text is in the draft. */
  const improve = useCallback(async () => {
    const dictation = dictationRef.current;
    if (!dictation || dictation.dropped) return;
    end();
    if (!dictation.pieces) return;
    // Says how it's going, unless another dictation has started meanwhile.
    const show = (next: ImproveStatus) => {
      if (dictationRef.current === dictation && !dictation.dropped) setStatus(next);
    };
    if (pendingFor(dictation)) {
      show('improving');
      await new Promise<void>(resolve => waitersRef.current.push({ dictation, resolve }));
    }
    show(dictation.usedChrome ? 'failed' : 'improved');
  }, [end]);

  /** Drops the pieces still waiting, so their text never reaches the draft (say, after Clear). */
  const discard = useCallback(() => {
    if (dictationRef.current) dictationRef.current.dropped = true;
    for (const piece of queueRef.current) piece.dictation.dropped = true;
    changed();
    setStatus('idle');
  }, [changed]);

  /**
   * Whether the question may go as the dictation's recording: the box holds the dictation's text
   * alone (nothing typed in or there before), and no earlier dictation's text is still to come.
   */
  const mayHandOver = useCallback(
    (dictation: Dictation | null): dictation is Dictation =>
      Boolean(
        dictation &&
        !dictation.dropped &&
        !dictation.typed &&
        enabledRef.current &&
        conversationRef.current &&
        draftRef.current.trim() === dictation.text &&
        queueRef.current.every(piece => piece.dictation === dictation),
      ),
    [draftRef],
  );

  /** Whether the box holds the whole dictation as Gemini wrote it, so there's nothing more to write down. */
  const written = (dictation: Dictation) =>
    !dictation.usedChrome && !queueRef.current.some(piece => piece.dictation === dictation);

  /**
   * Call when Send is pressed while listening, with whether words were said that aren't in the box
   * yet (`unwritten`). Returns how the question goes, at once: as its 'text', if the box holds the
   * whole dictation as Gemini wrote it, or with its 'recording', for Gemini to write down as a
   * whole, if words are still to be written down or some of the text is Chrome's. Its pieces are
   * then dropped. Null if the box has more than this dictation's text (typed, or there before), or
   * the recording is too long to go with the question: then listening is stopped as usual and the
   * text sent.
   */
  const handOverNow = useCallback(
    (unwritten: boolean): 'text' | 'recording' | null => {
      const dictation = dictationRef.current;
      if (!mayHandOver(dictation) || dictation.stopped) return null;
      const asText = !unwritten && written(dictation);
      if (!asText && dictation.seconds > 110) return null;
      dictation.dropped = true;
      changed();
      setStatus('idle');
      return asText ? 'text' : 'recording';
    },
    [changed, mayHandOver],
  );

  /**
   * Call when sending after listening stopped. Returns the dictation's recording and its words so
   * far (the box's text, and any still in gray), so the question can go with it, and drops its
   * pieces. Null if the above rules out sending the recording, or the box holds the whole
   * dictation as Gemini wrote it: then the text is sent.
   */
  const handOver = useCallback(async (): Promise<HandOff | null> => {
    const dictation = dictationRef.current;
    if (!mayHandOver(dictation) || !dictation.audio || written(dictation)) return null;
    const audio = await dictation.audio;
    // Checked again, as things may have changed meanwhile.
    if (!audio || audio.size > TWO_MINUTES || !mayHandOver(dictation)) return null;
    const heard = join(draftRef.current, waitingWords());
    dictation.dropped = true;
    changed();
    setStatus('idle');
    return { audio, heard };
  }, [changed, draftRef, mayHandOver, waitingWords]);

  return {
    enabled,
    setEnabled,
    status,
    waiting,
    waitingWords,
    begin,
    noteTyped,
    addPiece,
    prepare,
    end,
    improve,
    discard,
    handOver,
    handOverNow,
  };
}
