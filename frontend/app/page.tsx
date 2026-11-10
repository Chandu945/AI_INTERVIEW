'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Composer } from '../components/Composer';
import { ConversationPanel } from '../components/ConversationPanel';
import { InterviewsPage, type TypeFilter } from '../components/InterviewsPage';
import { SetupPage, type NewInterview } from '../components/SetupPage';
import { TopBar } from '../components/TopBar';
import { useDraft } from '../hooks/useDraft';
import { useImageAttachments } from '../hooks/useImageAttachments';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import { useQuestionPages } from '../hooks/useQuestionPages';
import { useTabAudio } from '../hooks/useTabAudio';
import { useTranscriptImprover, type HandOff } from '../hooks/useTranscriptImprover';
import { api, MAX_QUESTION_CHARS, readEvents, responseError } from '../lib/api';
import type {
  AnswerMode,
  AnswerStyle,
  Message,
  Rewrite,
  Session,
  StreamMetrics,
  View,
  VoiceSource,
} from '../lib/types';

// Remembers in this browser whether dictation listens to the mic or a tab.
const SOURCE_KEY = 'ai-interact.voice-source';

/** The whole app: the Interviews page, the New interview form and the interview itself, and what connects them. */
export default function Home() {
  const [view, setView] = useState<View>('home');
  const [sessions, setSessions] = useState<Session[]>([]);
  // Whether the list of interviews has loaded, and why it couldn't.
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionsError, setSessionsError] = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('All');
  // The interview being held, as last loaded (the list's copy, when it has one, is newer).
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  // Changing this key remounts the New Interview form, which resets its fields.
  const [setupKey, setSetupKey] = useState(0);
  const [starting, setStarting] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [answerMode, setAnswerMode] = useState<AnswerMode>('balanced');
  const [answerStyle, setAnswerStyle] = useState<AnswerStyle>('simple');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [streamMetrics, setStreamMetrics] = useState<StreamMetrics | null>(null);
  const [error, setError] = useState('');
  const [failedDraft, setFailedDraft] = useState<string | null>(null);
  const [language, setLanguage] = useState('en-IN');
  const [source, setSource] = useState<VoiceSource>('mic');
  // Hands-free: send the question as soon as the mic stops after a pause. Off by default, so you review first.
  const [autoSend, setAutoSend] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [fontSize, setFontSize] = useState(20);
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatRequestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // A recorded question that couldn't be answered, so that Retry can send its recording again.
  const failedRecordingRef = useRef<HandOff | null>(null);

  // Shows an error that isn't a failed send: the Retry button goes with a failed send's error only.
  const showError = useCallback((message: string) => {
    setError(message);
    setFailedDraft(null);
  }, []);

  const { draft, draftRef, updateDraft, appendWords } = useDraft();
  const improver = useTranscriptImprover({ draftRef, updateDraft, conversationId });
  const {
    begin: beginDictation,
    noteTyped,
    addPiece,
    prepare,
    end: endDictation,
    improve,
    handOver,
    handOverNow,
    discard,
    waitingWords,
  } = improver;
  // Images to ask the question with, uploaded as they are attached.
  const images = useImageAttachments(conversationId, showError);
  const {
    add: addImages,
    remove: removeImage,
    clear: clearImages,
    hasImages,
    take: takeImages,
    restore: restoreImages,
  } = images;
  // Chrome's words, when they are the text (Gemini's improvement is off). Only real words count
  // (stopping also flushes an often-empty last phrase).
  const appendDictated = useCallback(
    (words: string) => {
      if (words.trim()) appendWords(words);
    },
    [appendWords],
  );
  const typeInDraft = useCallback(
    (value: string) => {
      updateDraft(value);
      noteTyped();
      failedRecordingRef.current = null; // edited, it goes as its text
    },
    [noteTyped, updateDraft],
  );
  const speech = useSpeechRecognition({
    language,
    appendWords: appendDictated,
    busyRef,
    setError: showError,
    record: improver.enabled,
    onPiece: addPiece,
    onRecordingEnd: prepare,
    // Runs after a later render, by which time finish and sendMessage (defined below) exist.
    onSilenceStop: stopped => {
      void finish(stopped);
      if (autoSend) void sendMessage(); // it waits for the last words itself
    },
  });
  const {
    haltRecognition,
    startListening,
    stopListening,
    updateInterim,
    isListening,
    pendingWords,
    tailHasSpeech,
    stopForSending,
  } = speech;
  const { bodyRef, showNewest } = useQuestionPages(messages);
  // Stop sharing, pressed in Chrome's sharing bar, stops listening as if Stop was pressed.
  const tabAudio = useTabAudio(() => {
    if (isListening()) void finish(stopListening());
  });
  const { connect: connectTab, disconnect: disconnectTab } = tabAudio;
  const fromTab = tabAudio.supported && source === 'tab';
  // However listening ended (Stop, a pause, an error), no more pieces will come.
  useEffect(() => {
    if (!speech.listening) endDictation();
  }, [endDictation, speech.listening]);

  const startDictation = useCallback(async () => {
    if (busyRef.current) return;
    let track: MediaStreamTrack | undefined;
    if (fromTab) {
      try {
        track = await connectTab(); // the first time, Chrome asks which tab to share
      } catch (e) {
        showError(e instanceof Error ? e.message : "Couldn't share the tab.");
        return;
      }
    }
    if (startListening(track)) beginDictation();
  }, [beginDictation, connectTab, fromTab, showError, startListening]);

  const changeSource = useCallback(
    (next: VoiceSource) => {
      setSource(next);
      try {
        localStorage.setItem(SOURCE_KEY, next);
      } catch {
        /* storage is blocked: the choice lasts until the page is reloaded */
      }
      if (next === 'mic') disconnectTab();
    },
    [disconnectTab],
  );

  // The dictation being finished (the mic stopping, then the transcript being polished), so
  // that Send can wait for it, and the stopping part alone (its last words coming in).
  const finishingRef = useRef<Promise<void> | null>(null);
  const stoppedRef = useRef<Promise<void>>(Promise.resolve());
  const finish = useCallback(
    (stopped: Promise<void>) => {
      stoppedRef.current = stopped;
      const done = stopped.then(improve).finally(() => {
        if (finishingRef.current === done) finishingRef.current = null;
      });
      finishingRef.current = done;
      return done;
    },
    [improve],
  );

  /**
   * Stops the mic, then waits for Gemini to write down the dictation's last pieces. If the mic is
   * already off, it just waits for those.
   */
  const finishDictation = useCallback(
    () => (isListening() ? finish(stopListening()) : (finishingRef.current ?? finish(Promise.resolve()))),
    [finish, isListening, stopListening],
  );

  const clearDraft = useCallback(() => {
    discard(); // words still being written down must not come back
    failedRecordingRef.current = null;
    clearImages();
    updateDraft('');
    updateInterim('');
    showError('');
    if (isListening()) {
      // Invalidate old callbacks so previous words cannot reappear after Clear.
      haltRecognition(false);
      // Restart on the next tick after disposing the old recognition instance.
      setTimeout(() => {
        if (mountedRef.current) void startDictation();
      }, 80);
    }
    textareaRef.current?.focus();
  }, [clearImages, discard, haltRecognition, isListening, showError, startDictation, updateDraft, updateInterim]);

  const refreshSessions = useCallback(async () => {
    try {
      // No response at all: the backend isn't running, or can't be reached.
      const r = await api.listInterviews().catch(() => null);
      if (!r) throw new Error("Couldn't load your interviews. Is the backend running?");
      // An error response: in the backend's own words (say, that the database is out of reach).
      if (!r.ok) throw await responseError(r, `Couldn't load your interviews (${r.status}).`);
      setSessions((await r.json()).sessions);
      setSessionsLoaded(true);
      setSessionsError('');
    } catch (e) {
      setSessionsError(e instanceof Error ? e.message : "Couldn't load your interviews.");
    }
  }, []);

  const openSession = useCallback(
    async (id: string) => {
      if (busyRef.current) return;
      haltRecognition(false);
      discard();
      clearImages(); // ones not sent belong to the interview being left
      try {
        const r = await api.getInterview(id);
        if (!r.ok) throw await responseError(r, 'Could not open the interview');
        const data = await r.json();
        showNewest();
        setCurrentSession(data.session);
        setConversationId(id);
        setMessages(data.messages);
        setAnswerMode(data.session.mode || 'balanced');
        setAnswerStyle(data.session.style || 'simple');
        setView('interview');
        updateDraft('');
        showError('');
        setStreamMetrics(null);
      } catch (e) {
        showError(e instanceof Error ? e.message : 'Could not open the interview');
      }
    },
    [clearImages, discard, haltRecognition, showError, showNewest, updateDraft],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      try {
        const r = await api.updateInterview(id, { title });
        if (!r.ok) throw await responseError(r, 'Could not rename the interview');
        setSessions(list => list.map(session => (session.id === id ? { ...session, title } : session)));
        setCurrentSession(current => (current?.id === id ? { ...current, title } : current));
      } catch (e) {
        showError(e instanceof Error ? e.message : 'Could not rename the interview');
      }
    },
    [showError],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      if (busyRef.current) return;
      try {
        const r = await api.deleteInterview(id);
        if (!r.ok) throw await responseError(r, 'Could not delete the interview');
        setSessions(list => list.filter(session => session.id !== id));
        if (conversationId === id) {
          setConversationId(null);
          setCurrentSession(null);
          setMessages([]);
        }
        void refreshSessions();
      } catch (e) {
        showError(e instanceof Error ? e.message : 'Could not delete the interview');
      }
    },
    [conversationId, refreshSessions, showError],
  );

  // A new interview with the same setup as another, opened straight away.
  const copySession = useCallback(
    async (id: string) => {
      if (busyRef.current) return;
      try {
        const r = await api.copyInterview(id);
        if (!r.ok) throw await responseError(r, 'Could not start a new interview');
        await openSession((await r.json()).conversation_id);
        void refreshSessions();
      } catch (e) {
        showError(e instanceof Error ? e.message : 'Could not start a new interview');
      }
    },
    [openSession, refreshSessions, showError],
  );

  const sendMessage = useCallback(async () => {
    if (busyRef.current || !conversationId) return;
    // A dictated question goes as its text once Gemini has written all of it down. Sent sooner, it
    // goes with its recording: Gemini writes the whole question down while it answers, and the
    // box's text is only a preview. A question typed in or edited, or one the box held more than,
    // goes as its text once dictation's last words are in. Other sends (a second click, Enter)
    // are ignored meanwhile.
    busyRef.current = true;
    let recording: HandOff | null = null;
    let spoken: string | null = null; // the words so far, when the question goes straight from listening
    try {
      // The words so far: those in the box, then those shown in gray.
      const words = [draftRef.current.trim(), waitingWords(), pendingWords()].filter(Boolean).join(' ');
      // Words said that aren't in the box yet: shown in gray, or not even heard by Chrome yet.
      const unwritten = Boolean(waitingWords() || pendingWords()) || tailHasSpeech();
      const now = isListening() ? handOverNow(unwritten) : null;
      if (now) {
        // At once, with no waiting for words not in the box yet: the recording has them, or there
        // are none and the text is the whole question as Gemini wrote it.
        spoken = words;
        const audio = await stopForSending();
        if (now === 'recording' && audio) recording = { audio, heard: spoken };
      } else {
        const finishing = finishDictation();
        await stoppedRef.current;
        recording = await handOver();
        if (!recording) await finishing;
      }
    } finally {
      busyRef.current = false;
    }
    const text = recording ? recording.heard : (spoken ?? draftRef.current.trim());
    // Retry, for a recorded question that couldn't be answered: its recording goes again, so that
    // Gemini still writes the question down, as long as the box holds its words as they were (and
    // no new dictation was just handed over, which would be the question instead).
    const failed = failedRecordingRef.current;
    if (!recording && spoken === null && failed && text === failed.heard) recording = failed;
    if (!text && !recording && !hasImages()) {
      showError('Type or speak a question, or add an image.');
      return;
    }
    if (text.length > MAX_QUESTION_CHARS) {
      showError(
        `Your question is ${text.length.toLocaleString()} characters. The limit is ${MAX_QUESTION_CHARS.toLocaleString()}.`,
      );
      return;
    }
    busyRef.current = true;
    setBusy(true);
    // The question's images, once uploaded (usually they are by now).
    const imageIds = await takeImages();
    if (!imageIds) {
      // An image couldn't be uploaded (takeImages said so). Dictation has stopped by now, so its
      // words go back in the box, and its recording waits for Retry, as after a failed send.
      updateDraft(text);
      updateInterim('');
      setFailedDraft(text);
      failedRecordingRef.current = recording;
      busyRef.current = false;
      setBusy(false);
      return;
    }
    showError('');
    updateDraft('');
    updateInterim('');
    showNewest(); // the new question at the top of the panel, its answer under it
    setMessages(prev => [
      ...prev,
      // '…' for a recording, until Gemini writes it down.
      { role: 'user', content: text || (recording ? '…' : ''), images: imageIds.length ? imageIds : undefined },
    ]);
    setStreamMetrics(null);
    const controller = new AbortController();
    chatRequestRef.current = controller;
    // Create an answer placeholder and update it progressively as chunks arrive.
    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);
    let completed = false;
    // The question as shown: for a recording, its live words until Gemini has written it down.
    let question = text;
    try {
      const response = recording
        ? await api.askRecordedQuestion(
            {
              audio: recording.audio,
              heard: text,
              conversation_id: conversationId,
              mode: answerMode,
              style: answerStyle,
              image_ids: imageIds,
            },
            controller.signal,
          )
        : await api.askQuestion(
            {
              message: text,
              conversation_id: conversationId,
              mode: answerMode,
              style: answerStyle,
              image_ids: imageIds,
            },
            controller.signal,
          );
      if (!response.ok) throw await responseError(response, `Chat request failed (${response.status})`);
      if (!response.body) throw new Error('Streaming is not supported by this connection.');
      let received = '';
      await readEvents(response.body, event => {
        if (event.type === 'start' && event.conversation_id) setConversationId(event.conversation_id);
        if (event.type === 'question' && event.text) {
          const written = event.text;
          question = written;
          setMessages(prev => prev.map((m, i) => (i === prev.length - 2 ? { ...m, content: written } : m)));
        }
        if (event.type === 'restart') {
          received = '';
          setMessages(prev => prev.map((m, i) => (i === prev.length - 1 ? { role: 'assistant', content: '' } : m)));
        }
        if (event.type === 'delta' && event.text) {
          received += event.text;
          const next = received;
          setMessages(prev => prev.map((m, i) => (i === prev.length - 1 ? { role: 'assistant', content: next } : m)));
        }
        if (event.type === 'done') {
          completed = true;
          setStreamMetrics({ first: event.first_token_ms ?? null, total: event.total_ms ?? 0 });
          if (event.conversation_id) setConversationId(event.conversation_id);
          void refreshSessions();
        }
        if (event.type === 'error') throw new Error(event.message || 'Gemini streaming failed');
      });
      if (!completed) throw new Error('The response ended before Gemini finished. Please retry.');
      failedRecordingRef.current = null;
    } catch (e) {
      if (!controller.signal.aborted && mountedRef.current) {
        setError(e instanceof Error ? e.message : 'Could not send message');
        updateDraft(question);
        setFailedDraft(question);
        failedRecordingRef.current = recording;
        restoreImages(imageIds);
        // Drop the uncompleted answer and unsaved question, and show the question before.
        setMessages(prev => prev.slice(0, -2));
        showNewest();
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
      if (chatRequestRef.current === controller) chatRequestRef.current = null;
    }
  }, [
    hasImages,
    restoreImages,
    takeImages,
    answerMode,
    answerStyle,
    conversationId,
    draftRef,
    finishDictation,
    handOver,
    handOverNow,
    isListening,
    pendingWords,
    stopForSending,
    tailHasSpeech,
    waitingWords,
    showNewest,
    refreshSessions,
    showError,
    updateDraft,
    updateInterim,
  ]);

  // Says the latest answer again (shorter, more simply or in more detail), in its place. The
  // backend puts the new version in the old one's place once it's complete; until then, and if it
  // fails, the old one is still the saved one.
  const rewriteAnswer = useCallback(
    async (how: Rewrite) => {
      const old = messages[messages.length - 1];
      if (busyRef.current || !conversationId || old?.role !== 'assistant') return;
      busyRef.current = true;
      setBusy(true);
      showError('');
      setStreamMetrics(null);
      const showAnswer = (content: string) =>
        setMessages(prev => prev.map((m, i) => (i === prev.length - 1 ? { ...m, content } : m)));
      showAnswer('');
      const controller = new AbortController();
      chatRequestRef.current = controller;
      let completed = false;
      try {
        const response = await api.rewriteAnswer(
          { conversation_id: conversationId, how, style: answerStyle },
          controller.signal,
        );
        if (!response.ok) throw await responseError(response, `Request failed (${response.status})`);
        if (!response.body) throw new Error('Streaming is not supported by this connection.');
        let received = '';
        await readEvents(response.body, event => {
          if (event.type === 'restart') received = '';
          if (event.type === 'delta' && event.text) received += event.text;
          if (event.type === 'restart' || event.type === 'delta') showAnswer(received);
          if (event.type === 'done') {
            completed = true;
            setStreamMetrics({ first: event.first_token_ms ?? null, total: event.total_ms ?? 0 });
            void refreshSessions();
          }
          if (event.type === 'error') throw new Error(event.message || 'Gemini streaming failed');
        });
        if (!completed) throw new Error('The response ended before Gemini finished. Please retry.');
      } catch (e) {
        if (!controller.signal.aborted && mountedRef.current) {
          showError(e instanceof Error ? e.message : 'Could not say the answer again');
          showAnswer(old.content);
        }
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
        if (chatRequestRef.current === controller) chatRequestRef.current = null;
      }
    },
    [answerStyle, conversationId, messages, refreshSessions, showError],
  );

  const copyMessage = useCallback(
    async (content: string, key: string) => {
      try {
        await navigator.clipboard.writeText(content);
        if (!mountedRef.current) return;
        setCopiedKey(key);
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => setCopiedKey(null), 1800);
      } catch {
        showError('Unable to copy. Check browser clipboard permissions.');
      }
    },
    [showError],
  );

  // Saves the answer length on the interview, so reopening it keeps the choice.
  const changeAnswerMode = useCallback(
    (mode: AnswerMode) => {
      setAnswerMode(mode);
      if (!conversationId) return;
      void api.updateInterview(conversationId, { mode }).catch(() => {
        /* not critical: the next question still uses the new length */
      });
    },
    [conversationId],
  );

  // Saves the answer style on the interview, so reopening it keeps the choice.
  const changeAnswerStyle = useCallback(
    (style: AnswerStyle) => {
      setAnswerStyle(style);
      if (!conversationId) return;
      void api.updateInterview(conversationId, { style }).catch(() => {
        /* not critical: the next question still uses the new style */
      });
    },
    [conversationId],
  );

  const newInterview = useCallback(() => {
    if (busyRef.current) return;
    haltRecognition(false);
    discard();
    clearImages();
    updateDraft('');
    updateInterim('');
    setMessages([]);
    setConversationId(null);
    setCurrentSession(null);
    setSetupKey(key => key + 1);
    showError('');
    setStreamMetrics(null);
    setView('setup');
  }, [clearImages, discard, haltRecognition, showError, updateDraft, updateInterim]);

  // Back to the Interviews page, from an interview or the New interview form.
  const goHome = useCallback(() => {
    if (busyRef.current) return;
    haltRecognition(false);
    discard();
    clearImages();
    showError('');
    setView('home');
    void refreshSessions();
  }, [clearImages, discard, haltRecognition, refreshSessions, showError]);

  const startInterview = useCallback(
    async (form: NewInterview) => {
      if (starting || !form.targetRole.trim()) return;
      setStarting(true);
      showError('');
      // Holds the new interview's id until setup finishes, so a failed resume upload can remove it.
      let unfinishedId: string | null = null;
      try {
        const r = await api.createInterview({
          target_role: form.targetRole.trim(),
          interview_type: form.interviewType,
          mode: form.answerMode,
          style: form.answerStyle,
          instructions: form.instructions,
          job_description: form.jobDescription,
        });
        if (!r.ok) throw await responseError(r, 'Could not create the interview');
        const id = (await r.json()).conversation_id as string;
        unfinishedId = id;
        if (form.resume) {
          const uploaded = await api.uploadResume(id, form.resume);
          if (!uploaded.ok) throw await responseError(uploaded, 'Resume upload failed');
        }
        unfinishedId = null;
        setCurrentSession({
          id,
          title: 'New Interview',
          resume_name: form.resume?.name ?? null,
          target_role: form.targetRole.trim(),
          interview_type: form.interviewType,
          mode: form.answerMode,
          style: form.answerStyle,
          created_at: '',
          updated_at: '',
        });
        setConversationId(id);
        setAnswerMode(form.answerMode);
        setAnswerStyle(form.answerStyle);
        setMessages([]);
        setFailedDraft(null);
        setStreamMetrics(null);
        setView('interview');
        await refreshSessions();
      } catch (e) {
        // Remove the half-made interview so retrying doesn't leave empty ones on the Interviews page.
        if (unfinishedId) await api.deleteInterview(unfinishedId).catch(() => {});
        showError(e instanceof Error ? e.message : 'Could not start interview');
      } finally {
        setStarting(false);
      }
    },
    [refreshSessions, showError, starting],
  );

  useEffect(() => {
    mountedRef.current = true;
    void refreshSessions();
    return () => {
      mountedRef.current = false;
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      chatRequestRef.current?.abort();
    };
  }, [refreshSessions]);

  // A failed question's recording belongs to the interview it was asked in.
  useEffect(() => {
    failedRecordingRef.current = null;
  }, [conversationId]);

  useEffect(() => {
    try {
      if (localStorage.getItem(SOURCE_KEY) === 'tab') setSource('tab');
    } catch {
      /* storage is blocked: start with the mic */
    }
  }, []);

  useEffect(() => {
    // The shortcuts send a question, so they only work on the interview page: ⌘/Ctrl+Enter anywhere, and
    // Enter anywhere but a control (the question box handles its own Enter; a button's Enter presses it).
    if (view !== 'interview') return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Enter' || event.isComposing) return;
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        void sendMessage();
        return;
      }
      if (event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, select, button, a, summary, dialog, [contenteditable="true"]')) return;
      if (!isListening() && !draftRef.current.trim() && !hasImages()) return; // nothing to send
      event.preventDefault();
      void sendMessage();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draftRef, hasImages, isListening, sendMessage, view]);

  // The list's copy is the newest: Gemini titles an interview after its first question.
  const current = sessions.find(session => session.id === conversationId) ?? currentSession;
  return (
    <main className="app-shell">
      <TopBar
        interview={view === 'interview' ? current : null}
        busy={busy || starting}
        onBack={goHome}
        onRename={title => {
          if (conversationId) void renameSession(conversationId, title);
        }}
      />
      {view === 'home' && (
        <InterviewsPage
          sessions={sessions}
          loaded={sessionsLoaded}
          search={search}
          onSearchChange={setSearch}
          filter={typeFilter}
          onFilterChange={setTypeFilter}
          error={error || sessionsError}
          onOpen={id => void openSession(id)}
          onRename={(id, title) => void renameSession(id, title)}
          onCopy={id => void copySession(id)}
          onDelete={id => void deleteSession(id)}
          onNewInterview={newInterview}
        />
      )}
      {view === 'setup' && (
        <SetupPage
          key={setupKey}
          starting={starting}
          error={error}
          onStart={form => void startInterview(form)}
          onCancel={goHome}
        />
      )}
      {view === 'interview' && (
        <div className={`workspace ${focusMode ? 'focus-workspace' : ''}`}>
          <Composer
            draft={draft}
            onDraftChange={typeInDraft}
            textareaRef={textareaRef}
            speech={speech}
            preview={[improver.waiting, speech.interim].filter(Boolean).join(' ')}
            source={fromTab ? 'tab' : 'mic'}
            onSourceChange={changeSource}
            tabSupported={tabAudio.supported}
            tabShared={tabAudio.shared}
            onStopSharing={disconnectTab}
            onStartDictation={() => void startDictation()}
            onStopDictation={() => void finishDictation()}
            improve={improver.enabled}
            onImproveChange={improver.setEnabled}
            improveStatus={improver.status}
            busy={busy}
            answerMode={answerMode}
            onAnswerModeChange={changeAnswerMode}
            answerStyle={answerStyle}
            onAnswerStyleChange={changeAnswerStyle}
            language={language}
            onLanguageChange={setLanguage}
            autoSend={autoSend}
            onAutoSendChange={setAutoSend}
            error={error}
            failedDraft={failedDraft}
            onClear={clearDraft}
            onSend={() => void sendMessage()}
            attachments={images.attachments}
            onAddImages={addImages}
            onRemoveImage={removeImage}
          />
          <ConversationPanel
            messages={messages}
            busy={busy}
            focusMode={focusMode}
            onToggleFocus={() => setFocusMode(on => !on)}
            fontSize={fontSize}
            onFontSizeChange={setFontSize}
            copiedKey={copiedKey}
            onCopy={copyMessage}
            onRewrite={rewriteAnswer}
            streamMetrics={streamMetrics}
            sessionInfoOpen={sessionInfoOpen}
            onToggleSessionInfo={() => setSessionInfoOpen(open => !open)}
            conversationId={conversationId}
            bodyRef={bodyRef}
          />
        </div>
      )}
    </main>
  );
}
