'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Composer } from '../components/Composer';
import { ConversationPanel } from '../components/ConversationPanel';
import { HistoryPage } from '../components/HistoryPage';
import { SetupPage, type NewInterview } from '../components/SetupPage';
import { TopBar } from '../components/TopBar';
import { useDraft } from '../hooks/useDraft';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import { useStickToBottom } from '../hooks/useStickToBottom';
import { useTabAudio } from '../hooks/useTabAudio';
import { useTranscriptImprover, type HandOff } from '../hooks/useTranscriptImprover';
import { api, errorMessage, MAX_QUESTION_CHARS, readEvents } from '../lib/api';
import type { AnswerMode, Message, Session, StreamMetrics, View, VoiceSource } from '../lib/types';

// Remembers in this browser whether dictation listens to the mic or a tab.
const SOURCE_KEY = 'ai-interact.voice-source';

/** The whole app: New Interview, History and the interview itself, plus the actions that connect them. */
export default function Home() {
  const [view, setView] = useState<View>('setup');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [historySearch, setHistorySearch] = useState('');
  // Changing this key remounts the New Interview form, which resets its fields.
  const [setupKey, setSetupKey] = useState(0);
  const [starting, setStarting] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [answerMode, setAnswerMode] = useState<AnswerMode>('balanced');
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

  const { draft, draftRef, updateDraft, appendWords } = useDraft();
  const improver = useTranscriptImprover({ draftRef, updateDraft, conversationId });
  const {
    begin: beginDictation,
    noteDictated,
    noteTyped,
    prefetch,
    prepare,
    improve,
    handOver,
    handOverNow,
  } = improver;
  // Only real words count as dictation (stopping also flushes an often-empty last phrase).
  const appendDictated = useCallback(
    (words: string) => {
      if (!words.trim()) return;
      appendWords(words);
      noteDictated();
    },
    [appendWords, noteDictated],
  );
  const typeInDraft = useCallback(
    (value: string) => {
      updateDraft(value);
      noteTyped();
    },
    [noteTyped, updateDraft],
  );
  const speech = useSpeechRecognition({
    language,
    appendWords: appendDictated,
    busyRef,
    setError,
    record: improver.enabled,
    onPhraseEnd: prefetch,
    onRecordingEnd: prepare,
    // Runs after a later render, by which time finish and sendMessage (defined below) exist.
    onSilenceStop: stopped => {
      void finish(stopped);
      if (autoSend) void sendMessage(); // it waits for the last words itself
    },
  });
  const { haltRecognition, startListening, stopListening, updateInterim, isListening, pendingWords, stopForSending } =
    speech;
  const { bodyRef, bottomRef, onPanelScroll, followNewest } = useStickToBottom(messages, busy);
  // Stop sharing, pressed in Chrome's sharing bar, stops listening as if Stop was pressed.
  const tabAudio = useTabAudio(() => {
    if (isListening()) void finish(stopListening());
  });
  const { connect: connectTab, disconnect: disconnectTab } = tabAudio;
  const fromTab = tabAudio.supported && source === 'tab';

  const startDictation = useCallback(async () => {
    if (busyRef.current) return;
    let track: MediaStreamTrack | undefined;
    if (fromTab) {
      try {
        track = await connectTab(); // the first time, Chrome asks which tab to share
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't share the tab.");
        return;
      }
    }
    if (startListening(track)) beginDictation(fromTab);
  }, [beginDictation, connectTab, fromTab, startListening]);

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
   * Stops the mic and, if polishing is on, swaps in Gemini's more accurate transcript. If the
   * mic is already off, it just waits for any dictation still being finished.
   */
  const finishDictation = useCallback(
    () => (isListening() ? finish(stopListening()) : (finishingRef.current ?? Promise.resolve())),
    [finish, isListening, stopListening],
  );

  const clearDraft = useCallback(() => {
    updateDraft('');
    updateInterim('');
    setError('');
    if (isListening()) {
      // Invalidate old callbacks so previous words cannot reappear after Clear.
      haltRecognition(false);
      // Restart on the next tick after disposing the old recognition instance.
      setTimeout(() => {
        if (mountedRef.current) void startDictation();
      }, 80);
    }
    textareaRef.current?.focus();
  }, [haltRecognition, isListening, startDictation, updateDraft, updateInterim]);

  const refreshSessions = useCallback(async () => {
    try {
      const r = await api.listInterviews();
      if (r.ok) setSessions((await r.json()).sessions);
    } catch {
      /* backend offline */
    }
  }, []);

  const openSession = useCallback(
    async (id: string) => {
      if (busyRef.current) return;
      haltRecognition(false);
      try {
        const r = await api.getInterview(id);
        if (!r.ok) throw new Error('Could not open interview');
        const data = await r.json();
        followNewest();
        setConversationId(id);
        setMessages(data.messages);
        setAnswerMode(data.session.mode || 'balanced');
        setView('interview');
        updateDraft('');
        setError('');
        setStreamMetrics(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load history');
      }
    },
    [followNewest, haltRecognition, updateDraft],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      const next = window.prompt('Interview title', title);
      if (!next?.trim()) return;
      await api.updateInterview(id, { title: next.trim() });
      void refreshSessions();
    },
    [refreshSessions],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      if (busyRef.current || !window.confirm('Delete this interview and its saved questions, answers and resume?'))
        return;
      const r = await api.deleteInterview(id);
      if (r.ok) {
        if (conversationId === id) {
          setConversationId(null);
          setMessages([]);
        }
        void refreshSessions();
      }
    },
    [conversationId, refreshSessions],
  );

  const sendMessage = useCallback(async () => {
    if (busyRef.current) return;
    // Wait for dictation's last words. Then, if its transcript isn't final yet, send the question
    // with its recording: one Gemini request writes it down and answers it, which is quicker than
    // waiting for the transcript first. Otherwise wait for the transcript, if any, and send the
    // text. Other sends (a second click, ⌘+Enter) are ignored meanwhile.
    busyRef.current = true;
    let recording: HandOff | null = null;
    let spoken: string | null = null; // the live words, when the question goes straight from listening
    try {
      const pending = pendingWords();
      if (isListening() && handOverNow(Boolean(pending))) {
        // At once, with no waiting for the words still being recognized: the recording has them.
        spoken = `${draftRef.current.trim()} ${pending}`.trim();
        const audio = await stopForSending();
        if (audio) recording = { audio, heard: spoken };
      } else {
        const finishing = finishDictation();
        await stoppedRef.current;
        recording = conversationId ? await handOver() : null;
        if (!recording) await finishing;
      }
    } finally {
      busyRef.current = false;
    }
    const text = recording ? recording.heard : (spoken ?? draftRef.current.trim());
    if ((!text && !recording) || busyRef.current) {
      if (!text && !recording) setError('Type or speak a message first.');
      return;
    }
    if (text.length > MAX_QUESTION_CHARS) {
      setFailedDraft(null);
      setError(
        `Your question is ${text.length.toLocaleString()} characters. The limit is ${MAX_QUESTION_CHARS.toLocaleString()}.`,
      );
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError('');
    setFailedDraft(null);
    updateDraft('');
    updateInterim('');
    followNewest(); // show the new question even if the reader had scrolled up
    setMessages(prev => [...prev, { role: 'user', content: text || '…' }]); // '…' until Gemini writes it down
    setStreamMetrics(null);
    const controller = new AbortController();
    chatRequestRef.current = controller;
    // Create an answer placeholder and update it progressively as chunks arrive.
    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);
    let completed = false;
    // The question as shown: for a recording, its live words until Gemini has written it down.
    let question = text;
    try {
      const response =
        recording && conversationId
          ? await api.askRecordedQuestion(
              { audio: recording.audio, heard: text, conversation_id: conversationId, mode: answerMode },
              controller.signal,
            )
          : await api.askQuestion(
              { message: text, conversation_id: conversationId, mode: answerMode },
              controller.signal,
            );
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(errorMessage(data, `Chat request failed (${response.status})`));
      }
      if (!response.body) throw new Error('Streaming is not supported by this connection.');
      let received = '';
      await readEvents(response.body, event => {
        if (event.type === 'start' && event.conversation_id) setConversationId(event.conversation_id);
        if (event.type === 'question' && event.text) {
          const written = event.text;
          question = written;
          setMessages(prev => prev.map((m, i) => (i === prev.length - 2 ? { role: 'user', content: written } : m)));
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
    } catch (e) {
      if (!controller.signal.aborted && mountedRef.current) {
        setError(e instanceof Error ? e.message : 'Could not send message');
        updateDraft(question);
        setFailedDraft(question);
        // Drop the uncompleted answer and unsaved question.
        setMessages(prev => prev.slice(0, -2));
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
      if (chatRequestRef.current === controller) chatRequestRef.current = null;
    }
  }, [
    answerMode,
    conversationId,
    draftRef,
    finishDictation,
    handOver,
    handOverNow,
    isListening,
    pendingWords,
    stopForSending,
    followNewest,
    refreshSessions,
    updateDraft,
    updateInterim,
  ]);

  const copyMessage = useCallback(async (content: string, key: string) => {
    try {
      await navigator.clipboard.writeText(content);
      if (!mountedRef.current) return;
      setCopiedKey(key);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      setError('Unable to copy. Check browser clipboard permissions.');
    }
  }, []);

  // Saves the answer length on the interview, so reopening it from History keeps the choice.
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

  const newChat = useCallback(() => {
    if (busyRef.current) return;
    haltRecognition(false);
    updateDraft('');
    updateInterim('');
    setMessages([]);
    setConversationId(null);
    setAnswerMode('balanced');
    setSetupKey(key => key + 1);
    setError('');
    setStreamMetrics(null);
    setView('setup');
    void refreshSessions();
  }, [haltRecognition, refreshSessions, updateDraft, updateInterim]);

  const showHistory = useCallback(() => {
    haltRecognition(false);
    setError('');
    setView('history');
    void refreshSessions();
  }, [haltRecognition, refreshSessions]);

  const startInterview = useCallback(
    async (form: NewInterview) => {
      if (starting || !form.targetRole.trim()) return;
      setStarting(true);
      setError('');
      // Holds the new interview's id until setup finishes, so a failed resume upload can remove it.
      let unfinishedId: string | null = null;
      try {
        const r = await api.createInterview({
          target_role: form.targetRole.trim(),
          interview_type: form.interviewType,
          mode: answerMode,
          instructions: form.instructions,
          job_description: form.jobDescription,
        });
        if (!r.ok) throw new Error('Could not create interview');
        const id = (await r.json()).conversation_id as string;
        unfinishedId = id;
        if (form.resume) {
          const uploaded = await api.uploadResume(id, form.resume);
          if (!uploaded.ok) {
            const data = await uploaded.json().catch(() => ({}));
            throw new Error(errorMessage(data, 'Resume upload failed'));
          }
        }
        unfinishedId = null;
        setConversationId(id);
        setMessages([]);
        setView('interview');
        await refreshSessions();
      } catch (e) {
        // Remove the half-made interview so retrying doesn't leave empty ones in History.
        if (unfinishedId) await api.deleteInterview(unfinishedId).catch(() => {});
        setError(e instanceof Error ? e.message : 'Could not start interview');
      } finally {
        setStarting(false);
      }
    },
    [answerMode, refreshSessions, starting],
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

  useEffect(() => {
    try {
      if (localStorage.getItem(SOURCE_KEY) === 'tab') setSource('tab');
    } catch {
      /* storage is blocked: start with the mic */
    }
  }, []);

  useEffect(() => {
    // The shortcut sends a question, so it only works on the interview page.
    if (view !== 'interview') return;
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        void sendMessage();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sendMessage, view]);

  return (
    <main className="app-shell">
      <TopBar view={view} disabled={busy || starting} onNewInterview={newChat} onHistory={showHistory} />
      {view === 'setup' && (
        <SetupPage
          key={setupKey}
          answerMode={answerMode}
          onAnswerModeChange={setAnswerMode}
          starting={starting}
          error={error}
          setError={setError}
          onStart={form => void startInterview(form)}
        />
      )}
      {view === 'history' && (
        <HistoryPage
          sessions={sessions}
          search={historySearch}
          onSearchChange={setHistorySearch}
          error={error}
          onOpen={id => void openSession(id)}
          onRename={(id, title) => void renameSession(id, title)}
          onDelete={id => void deleteSession(id)}
          onNewInterview={newChat}
        />
      )}
      {view === 'interview' && (
        <div className={`workspace ${focusMode ? 'focus-workspace' : ''}`}>
          <Composer
            draft={draft}
            onDraftChange={typeInDraft}
            textareaRef={textareaRef}
            speech={speech}
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
            language={language}
            onLanguageChange={setLanguage}
            autoSend={autoSend}
            onAutoSendChange={setAutoSend}
            error={error}
            failedDraft={failedDraft}
            onClear={clearDraft}
            onSend={() => void sendMessage()}
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
            streamMetrics={streamMetrics}
            sessionInfoOpen={sessionInfoOpen}
            onToggleSessionInfo={() => setSessionInfoOpen(open => !open)}
            conversationId={conversationId}
            bodyRef={bodyRef}
            bottomRef={bottomRef}
            onPanelScroll={onPanelScroll}
          />
        </div>
      )}
    </main>
  );
}
