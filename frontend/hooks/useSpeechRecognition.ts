import { useCallback, useEffect, useRef, useState } from 'react';
import { useAudioRecorder, type Piece } from './useAudioRecorder';

type SpeechResult = { isFinal: boolean; 0: { transcript: string } };
type SpeechEvent = { resultIndex: number; results: ArrayLike<SpeechResult> };
type SpeechError = { error: string };
type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechEvent) => void) | null;
  onerror: ((event: SpeechError) => void) | null;
  onend: (() => void) | null;
  /** Listens to the mic, or to `track` if given (Chrome). */
  start: (track?: MediaStreamTrack) => void;
  stop: () => void;
  abort: () => void;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

/** A piece of the recording, with the words Chrome heard in it. */
export type HeardPiece = Piece & { heard: string };

type Options = {
  language: string;
  /** Adds finalized words to the draft, when Chrome's words are the text. */
  appendWords: (words: string) => void;
  /** The mic won't start while an answer is being generated. */
  busyRef: { current: boolean };
  setError: (message: string) => void;
  /**
   * Gemini writes the text: the audio is recorded and cut into pieces at quiet moments, each
   * handed to onPiece with the words Chrome heard in it. Chrome's words are then only shown, as
   * `interim`, until Gemini's version of them is in.
   */
  record?: boolean;
  onPiece?: (piece: HeardPiece) => void;
  /** Called as listening stops, with the whole recording. */
  onRecordingEnd?: (audio: Promise<Blob | null>) => void;
  /**
   * Called when the mic stops by itself after a pause (the "stop after silence" option), with
   * the stop in progress. It resolves once the last words are in.
   */
  onSilenceStop?: (stopped: Promise<void>) => void;
};

export type Speech = ReturnType<typeof useSpeechRecognition>;

const join = (a: string, b: string) => [a.trim(), b.trim()].filter(Boolean).join(' ');

/**
 * Live dictation with the browser's speech recognition (Chrome), from the mic or from a shared
 * tab's sound. Either Chrome's finalized words go into the draft, or (with `record`) Gemini writes
 * the text from the recording, piece by piece, and Chrome's words only show until then. Words
 * still being recognized are shown as `interim`. The browser ends recognition on its own now and
 * then, so it is reopened until stopListening() is called. Every start gets a new session number,
 * and callbacks from an older session are ignored.
 */
export function useSpeechRecognition({
  language,
  appendWords,
  busyRef,
  setError,
  record = false,
  onPiece,
  onRecordingEnd,
  onSilenceStop,
}: Options) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(true);
  const [status, setStatus] = useState('Ready to type or speak');
  const [elapsed, setElapsed] = useState(0);
  const [interim, setInterim] = useState('');
  const interimRef = useRef('');
  const [autoPause, setAutoPause] = useState(false);
  // Speech callbacks read this ref, so changing the option applies to the current listening session.
  const autoPauseRef = useRef(false);

  const recognitionRef = useRef<Recognition | null>(null);
  // The shared tab's sound being listened to, or null for the mic.
  const trackRef = useRef<MediaStreamTrack | null>(null);
  // Whether Gemini writes the text for this listening session (`record` when it started).
  const recordingRef = useRef(false);
  // Words of a Chrome session that ended by itself, shown before the next session's words.
  const carryRef = useRef('');
  // The words shown when listening stopped, which go with the recording's last piece.
  const lastHeardRef = useRef('');
  const stopListeningRef = useRef<(() => Promise<void>) | null>(null);
  const sessionRef = useRef(0);
  const shouldListenRef = useRef(false);
  const stoppingRef = useRef(false);
  const recognitionFinalRef = useRef('');
  const silenceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restartRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopWaitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopFinalizeRef = useRef<(() => void) | null>(null);
  // Always the latest options, since speech callbacks and timers outlive the render that started them.
  const optionsRef = useRef({ record, onPiece, onRecordingEnd, onSilenceStop });
  useEffect(() => {
    optionsRef.current = { record, onPiece, onRecordingEnd, onSilenceStop };
  });
  const {
    start: startRecording,
    stop: stopRecording,
    cancel: cancelRecording,
    isQuiet,
    tailHasSpeech,
    held: micHeld,
  } = useAudioRecorder();

  const updateInterim = useCallback((value: string) => {
    interimRef.current = value;
    setInterim(value);
  }, []);

  const clearTimers = useCallback(() => {
    if (silenceRef.current) clearTimeout(silenceRef.current);
    silenceRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    if (restartRef.current) clearTimeout(restartRef.current);
    timerRef.current = null;
    restartRef.current = null;
  }, []);
  const disposeRecognition = useCallback(() => {
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.abort();
      } catch {
        /* already stopped */
      }
    }
  }, []);
  const finishStop = useCallback(() => {
    if (stopWaitRef.current) clearTimeout(stopWaitRef.current);
    stopWaitRef.current = null;
    const resolve = stopFinalizeRef.current;
    stopFinalizeRef.current = null;
    if (resolve) resolve();
  }, []);
  const haltRecognition = useCallback(
    (preserveInterim: boolean) => {
      sessionRef.current += 1;
      shouldListenRef.current = false;
      stoppingRef.current = false;
      if (preserveInterim) appendWords(interimRef.current);
      updateInterim('');
      carryRef.current = '';
      recognitionFinalRef.current = '';
      clearTimers();
      disposeRecognition();
      cancelRecording();
      setListening(false);
      setStatus(trackRef.current ? 'Stopped listening to the tab' : 'Microphone off');
      finishStop();
    },
    [appendWords, cancelRecording, clearTimers, disposeRecognition, finishStop, updateInterim],
  );

  // Stops the mic once no new words have arrived for 2.2s (the "stop after silence" option). When
  // Gemini writes the text, the sound must be quiet too, as Chrome can fall behind on long speech;
  // but not for ever, in case music is playing.
  const scheduleSilenceStop = useCallback(() => {
    let waits = 0;
    const arm = () => {
      if (silenceRef.current) clearTimeout(silenceRef.current);
      silenceRef.current = setTimeout(() => {
        const stop = stopListeningRef.current;
        if (!shouldListenRef.current || !stop) return;
        if (recordingRef.current && !isQuiet() && waits++ < 3) return arm();
        optionsRef.current.onSilenceStop?.(stop());
      }, 2200);
    };
    arm();
  }, [isQuiet]);

  /**
   * Starts listening to the mic, or to `track` (a shared tab's sound) if given. Returns whether
   * listening started. It won't while already listening or still stopping.
   */
  const startListening = useCallback(
    (track?: MediaStreamTrack): boolean => {
      const w = window as SpeechWindow;
      const Constructor = w.SpeechRecognition || w.webkitSpeechRecognition;
      if (!Constructor) {
        setError('Live speech recognition is not supported in this browser. Try Chrome.');
        return false;
      }
      if (shouldListenRef.current || stoppingRef.current || busyRef.current) return false;
      setError('');
      const token = ++sessionRef.current;
      shouldListenRef.current = true;
      stoppingRef.current = false;
      trackRef.current = track ?? null;
      recordingRef.current = optionsRef.current.record;
      carryRef.current = '';
      // Once a shared tab stops being shared, its track ends; the page then stops listening.
      const tabGone = () => track?.readyState === 'ended';
      const listeningText = track ? 'Listening to the tab' : 'Listening live';
      // When Gemini writes the text, it's listening once the recording has started (opening the
      // mic takes a moment): until then the status doesn't say so, as words said now aren't recorded.
      let recorderOpen = !recordingRef.current;
      recognitionFinalRef.current = '';
      updateInterim('');
      setElapsed(0);
      setListening(true);
      setStatus(track ? 'Connecting to the tab...' : 'Connecting microphone...');
      timerRef.current = setInterval(() => setElapsed(v => v + 1), 1000);

      const openRecognition = () => {
        if (sessionRef.current !== token || !shouldListenRef.current || stoppingRef.current || tabGone()) return;
        const rec = new Constructor();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = language;
        recognitionFinalRef.current = '';
        recognitionRef.current = rec;
        rec.onresult = event => {
          if (sessionRef.current !== token) return;
          let final = '';
          let temporary = '';
          for (let i = 0; i < event.results.length; i++) {
            const result = event.results[i];
            if (result.isFinal) final += result[0].transcript + ' ';
            else temporary += result[0].transcript + ' ';
          }
          if (recordingRef.current) {
            // Gemini writes the text: Chrome's words only show until its version of them is in.
            updateInterim(join(carryRef.current, final + temporary));
          } else {
            // Browser results represent the current recognition session, not just new words.
            // Append only the newly finalized suffix, keeping manual textarea edits intact.
            if (final.length < recognitionFinalRef.current.length || !final.startsWith(recognitionFinalRef.current)) {
              recognitionFinalRef.current = '';
            }
            const addition = final.slice(recognitionFinalRef.current.length).trim();
            if (addition) appendWords(addition);
            recognitionFinalRef.current = final;
            updateInterim(temporary.trim());
          }
          setStatus(stoppingRef.current ? 'Finishing transcription...' : listeningText);
          if (autoPauseRef.current && (final.trim() || temporary.trim())) scheduleSilenceStop();
        };
        rec.onerror = event => {
          // Errors after the tab stopped being shared don't matter: the page stops listening.
          if (sessionRef.current !== token || tabGone()) return;
          const fatal = ['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'];
          if (fatal.includes(event.error)) {
            setError(
              track
                ? `Couldn't listen to the tab (${event.error}).`
                : `Microphone recognition error: ${event.error}. Check browser permissions.`,
            );
            // When Gemini writes the text, stop as usual, so the last piece goes to it.
            if (recordingRef.current) void stopListeningRef.current?.();
            else haltRecognition(true);
          } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
            setStatus(`Recognition interrupted: ${event.error}`);
          }
        };
        rec.onend = () => {
          if (sessionRef.current !== token) return;
          recognitionRef.current = null;
          if (stoppingRef.current) {
            // Keep a last interim phrase if the browser never marked it final.
            appendWords(interimRef.current);
            updateInterim('');
            finishStop();
            return;
          }
          if (shouldListenRef.current && !tabGone()) {
            // Chrome ended the session by itself. Keep the words it hadn't finished: in the text,
            // or, when Gemini writes it, shown before the next session's words.
            if (recordingRef.current) carryRef.current = interimRef.current;
            else {
              appendWords(interimRef.current);
              updateInterim('');
            }
            setStatus(track ? 'Reconnecting to the tab...' : 'Reconnecting microphone...');
            restartRef.current = setTimeout(openRecognition, 100);
          }
        };
        try {
          if (track) rec.start(track);
          else rec.start();
          if (recorderOpen) setStatus(listeningText);
        } catch {
          setError(
            track
              ? "Couldn't listen to the tab. Try sharing it again."
              : 'Unable to start speech recognition. Check microphone permissions.',
          );
          haltRecognition(true);
        }
      };

      // A piece of the recording was cut: hand it on with the words Chrome heard in it, and start
      // Chrome afresh for the next one. So the words shown start over, and Chrome never runs one
      // endless sentence (after about 18 seconds of one, it stops hearing new words).
      const handOn = (piece: Piece) => {
        if (sessionRef.current !== token) return;
        const stopping = stoppingRef.current;
        optionsRef.current.onPiece?.({ ...piece, heard: stopping ? lastHeardRef.current : interimRef.current });
        if (stopping || !shouldListenRef.current) return;
        carryRef.current = '';
        updateInterim('');
        disposeRecognition();
        if (restartRef.current) clearTimeout(restartRef.current);
        openRecognition();
      };
      if (recordingRef.current)
        void startRecording(track, handOn).then(started => {
          if (sessionRef.current !== token) return;
          // Without a recording, Gemini has nothing to write from: Chrome's words are the text after all.
          if (!started) recordingRef.current = false;
          recorderOpen = true;
          if (shouldListenRef.current && !stoppingRef.current) setStatus(listeningText);
        });
      openRecognition();
      return true;
    },
    [
      appendWords,
      busyRef,
      disposeRecognition,
      finishStop,
      haltRecognition,
      language,
      scheduleSilenceStop,
      setError,
      startRecording,
      updateInterim,
    ],
  );

  /** Stops listening. Resolves once the last words are in. */
  const stopListening = useCallback(async (): Promise<void> => {
    if (!shouldListenRef.current) return;
    stoppingRef.current = true;
    shouldListenRef.current = false;
    clearTimers();
    setListening(false);
    setStatus('Finishing transcription...');
    if (recordingRef.current) {
      // Gemini writes the text: the recording's last piece has every word, so there is no waiting
      // for Chrome's. Stopping the recording hands that piece on.
      lastHeardRef.current = interimRef.current;
      const audio = stopRecording();
      optionsRef.current.onRecordingEnd?.(audio);
      await audio;
      haltRecognition(false);
      return;
    }
    // Live recognition gets a moment to finalize its last words.
    const rec = recognitionRef.current;
    if (rec) {
      await new Promise<void>(resolve => {
        stopFinalizeRef.current = resolve;
        stopWaitRef.current = setTimeout(() => {
          // Some browsers never send onend after stop().
          appendWords(interimRef.current);
          updateInterim('');
          finishStop();
        }, 850);
        try {
          rec.stop();
        } catch {
          finishStop();
        }
      });
    }
    haltRecognition(!rec);
  }, [appendWords, clearTimers, finishStop, haltRecognition, stopRecording, updateInterim]);

  stopListeningRef.current = stopListening;

  const changeAutoPause = useCallback(
    (on: boolean) => {
      autoPauseRef.current = on;
      setAutoPause(on);
      if (silenceRef.current) clearTimeout(silenceRef.current);
      silenceRef.current = null;
      // If words were already heard, start counting the current pause now.
      if (on && shouldListenRef.current && (recognitionFinalRef.current.trim() || interimRef.current.trim()))
        scheduleSilenceStop();
    },
    [scheduleSilenceStop],
  );

  const isListening = useCallback(() => shouldListenRef.current, []);
  /**
   * The words shown but not yet in the text: still being recognized, or waiting for Gemini. Words
   * said since the last piece was cut may not show yet, either: tailHasSpeech() says if any were.
   */
  const pendingWords = useCallback(() => interimRef.current.trim(), []);

  /**
   * Stops listening at once, to send the question with its recording, and returns the recording.
   * Words not in the text yet are dropped rather than waited for: the recording has them.
   */
  const stopForSending = useCallback(() => {
    const audio = stopRecording();
    haltRecognition(false);
    return audio;
  }, [haltRecognition, stopRecording]);

  useEffect(() => {
    const w = window as SpeechWindow;
    setSupported(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition));
    return () => haltRecognition(false);
  }, [haltRecognition]);

  return {
    listening,
    supported,
    // While the mic is kept open after listening (so the next dictation starts at once), the
    // status says so, as Chrome shows the tab as using it.
    status: status === 'Microphone off' && micHeld ? 'Microphone open, not recording' : status,
    elapsed,
    interim,
    autoPause,
    startListening,
    stopListening,
    haltRecognition,
    changeAutoPause,
    updateInterim,
    isListening,
    pendingWords,
    tailHasSpeech,
    stopForSending,
  };
}
