import { useCallback, useEffect, useRef, useState } from 'react';

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
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

type Options = {
  language: string;
  /** Adds finalized words to the draft. */
  appendWords: (words: string) => void;
  /** The mic won't start while an answer is being generated. */
  busyRef: { current: boolean };
  setError: (message: string) => void;
  /** Called after the mic stops by itself because of a pause (the "stop after silence" option). */
  onSilenceStop?: () => void;
};

export type Speech = ReturnType<typeof useSpeechRecognition>;

/**
 * Live dictation with the browser's speech recognition (Chrome). Finalized words go into the
 * draft; words still being recognized are shown as `interim`. The browser ends recognition on
 * its own now and then, so it is reopened until stopListening() is called. Every start gets a
 * new session number, and callbacks from an older session are ignored.
 */
export function useSpeechRecognition({ language, appendWords, busyRef, setError, onSilenceStop }: Options) {
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
  // Always the latest callback, since the silence timer outlives the render that started it.
  const onSilenceStopRef = useRef(onSilenceStop);
  useEffect(() => {
    onSilenceStopRef.current = onSilenceStop;
  });

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
      recognitionFinalRef.current = '';
      clearTimers();
      disposeRecognition();
      setListening(false);
      setStatus('Microphone off');
      finishStop();
    },
    [appendWords, clearTimers, disposeRecognition, finishStop, updateInterim],
  );

  // Stops the mic once no new words have arrived for 2.2s (the "stop after silence" option).
  const scheduleSilenceStop = useCallback(() => {
    if (silenceRef.current) clearTimeout(silenceRef.current);
    silenceRef.current = setTimeout(() => {
      const stop = stopListeningRef.current;
      if (shouldListenRef.current && stop) void stop().then(() => onSilenceStopRef.current?.());
    }, 2200);
  }, []);

  const startListening = useCallback(() => {
    const w = window as SpeechWindow;
    const Constructor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Constructor) {
      setError('Live speech recognition is not supported in this browser. Try Chrome.');
      return;
    }
    if (shouldListenRef.current || busyRef.current) return;
    setError('');
    const token = ++sessionRef.current;
    shouldListenRef.current = true;
    stoppingRef.current = false;
    recognitionFinalRef.current = '';
    updateInterim('');
    setElapsed(0);
    setListening(true);
    setStatus('Connecting microphone...');
    timerRef.current = setInterval(() => setElapsed(v => v + 1), 1000);

    const openRecognition = () => {
      if (sessionRef.current !== token || !shouldListenRef.current || stoppingRef.current) return;
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
        // Browser results represent the current recognition session, not just new words.
        // Append only the newly finalized suffix, keeping manual textarea edits intact.
        if (final.length < recognitionFinalRef.current.length || !final.startsWith(recognitionFinalRef.current)) {
          recognitionFinalRef.current = '';
        }
        const addition = final.slice(recognitionFinalRef.current.length).trim();
        if (addition) appendWords(addition);
        recognitionFinalRef.current = final;
        updateInterim(temporary.trim());
        setStatus(stoppingRef.current ? 'Finishing transcription...' : 'Listening live');
        if (autoPauseRef.current && (final.trim() || temporary.trim())) scheduleSilenceStop();
      };
      rec.onerror = event => {
        if (sessionRef.current !== token) return;
        const fatal = ['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'];
        if (fatal.includes(event.error)) {
          setError(`Microphone recognition error: ${event.error}. Check browser permissions.`);
          haltRecognition(true);
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
        if (shouldListenRef.current) {
          setStatus('Reconnecting microphone...');
          restartRef.current = setTimeout(openRecognition, 300);
        }
      };
      try {
        rec.start();
        setStatus('Listening live');
      } catch {
        setError('Unable to start speech recognition. Check microphone permissions.');
        haltRecognition(true);
      }
    };
    openRecognition();
  }, [appendWords, busyRef, finishStop, haltRecognition, language, scheduleSilenceStop, setError, updateInterim]);

  const stopListening = useCallback(async () => {
    if (!shouldListenRef.current) return;
    stoppingRef.current = true;
    shouldListenRef.current = false;
    clearTimers();
    setListening(false);
    setStatus('Finishing transcription...');
    const rec = recognitionRef.current;
    if (!rec) {
      haltRecognition(true);
      return;
    }
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
    haltRecognition(false);
  }, [appendWords, clearTimers, finishStop, haltRecognition, updateInterim]);

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

  useEffect(() => {
    const w = window as SpeechWindow;
    setSupported(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition));
    return () => haltRecognition(false);
  }, [haltRecognition]);

  return {
    listening,
    supported,
    status,
    elapsed,
    interim,
    autoPause,
    startListening,
    stopListening,
    haltRecognition,
    changeAutoPause,
    updateInterim,
    isListening,
  };
}
