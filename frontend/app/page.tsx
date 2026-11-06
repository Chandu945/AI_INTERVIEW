'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Message = { role: 'user' | 'assistant'; content: string };
type Session = { id: string; title: string; resume_name: string | null; mode?: AnswerMode; target_role?: string; interview_type?: string; created_at: string; updated_at: string };
type AnswerMode = 'quick' | 'balanced' | 'detailed';
type StreamEvent = { type: 'start' | 'delta' | 'done' | 'error'; conversation_id?: string; text?: string; message?: string; first_token_ms?: number | null; total_ms?: number };
type SpeechResult = { isFinal: boolean; 0: { transcript: string } };
type SpeechEvent = { resultIndex: number; results: ArrayLike<SpeechResult> };
type SpeechError = { error: string };
type Recognition = {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((event: SpeechEvent) => void) | null;
  onerror: ((event: SpeechError) => void) | null;
  onend: (() => void) | null;
  start: () => void; stop: () => void; abort: () => void;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};
const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
// Must match ChatRequest.message max_length in backend/main.py.
const MAX_QUESTION_CHARS = 10000;
const LANGUAGES = [
  { code: 'en-IN', label: 'English (India)' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'hi-IN', label: 'Hindi' },
  { code: 'te-IN', label: 'Telugu' },
];

// FastAPI sends `detail` as a string for the app's own errors, but as a list of
// { msg } objects when request validation fails.
function errorMessage(data: unknown, fallback: string): string {
  const detail = (data as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map(item => item?.msg).filter((msg): msg is string => typeof msg === 'string');
    if (messages.length) return messages.join('; ');
  }
  return fallback;
}

export default function Home() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [view, setView] = useState<'setup'|'interview'|'history'>('setup');
  const [targetRole, setTargetRole] = useState('GenAI Developer');
  const [interviewType, setInterviewType] = useState<'Technical'|'HR'|'Mixed'>('Technical');
  const [instructions, setInstructions] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  const [autoPause, setAutoPause] = useState(false);
  // Speech callbacks read this ref, so changing the option applies to the current listening session.
  const autoPauseRef = useRef(false);
  const [focusMode, setFocusMode] = useState(false);
  const silenceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [setupResume, setSetupResume] = useState<File | null>(null);
  const resumeInputRef = useRef<HTMLInputElement | null>(null);
  const [starting, setStarting] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [fontSize, setFontSize] = useState(20);
  const [draft, setDraft] = useState('');
  const draftRef = useRef('');
  const [interim, setInterim] = useState('');
  const interimRef = useRef('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [answerMode, setAnswerMode] = useState<AnswerMode>('balanced');
  const [streamMetrics, setStreamMetrics] = useState<{first: number | null; total: number} | null>(null);
  const busyRef = useRef(false);
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(true);
  const [status, setStatus] = useState('Ready to type or speak');
  const [error, setError] = useState('');
  const [failedDraft, setFailedDraft] = useState<string | null>(null);
  const [language, setLanguage] = useState('en-IN');
  const [elapsed, setElapsed] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const recognitionRef = useRef<Recognition | null>(null);
  const stopListeningRef = useRef<(() => Promise<void>) | null>(null);
  const sessionRef = useRef(0);
  const shouldListenRef = useRef(false);
  const stoppingRef = useRef(false);
  const recognitionFinalRef = useRef('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restartRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatRequestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const conversationBodyRef = useRef<HTMLDivElement | null>(null);
  // True while the reader is at the bottom of the answers; new text is only followed then.
  const stickToBottomRef = useRef(true);
  // Last scroll positions seen, to tell when the reader scrolls up.
  const panelTopRef = useRef(0);
  const pageTopRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const stopWaitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopFinalizeRef = useRef<(() => void) | null>(null);

  const updateDraft = useCallback((value: string) => {
    draftRef.current = value;
    setDraft(value);
  }, []);
  const updateInterim = useCallback((value: string) => {
    interimRef.current = value;
    setInterim(value);
  }, []);
  const appendWords = useCallback((words: string) => {
    const text = words.trim();
    if (!text) return;
    const previous = draftRef.current;
    updateDraft(previous + (previous && !/\s$/.test(previous) ? ' ' : '') + text);
  }, [updateDraft]);

  const clearTimers = useCallback(() => {
    if (silenceRef.current) clearTimeout(silenceRef.current); silenceRef.current = null;
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
      try { rec.abort(); } catch { /* already stopped */ }
    }
  }, []);
  const finishStop = useCallback(() => {
    if (stopWaitRef.current) clearTimeout(stopWaitRef.current);
    stopWaitRef.current = null;
    const resolve = stopFinalizeRef.current;
    stopFinalizeRef.current = null;
    if (resolve) resolve();
  }, []);
  const haltRecognition = useCallback((preserveInterim: boolean) => {
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
  }, [appendWords, clearTimers, disposeRecognition, finishStop, updateInterim]);

  // Stops the mic once no new words have arrived for 2.2s (the "stop after silence" option).
  const scheduleSilenceStop = useCallback(() => {
    if (silenceRef.current) clearTimeout(silenceRef.current);
    silenceRef.current = setTimeout(() => { if (shouldListenRef.current) void stopListeningRef.current?.(); }, 2200);
  }, []);

  const startListening = useCallback(() => {
    const w = window as SpeechWindow;
    const Constructor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Constructor) { setError('Live speech recognition is not supported in this browser. Try Chrome.'); return; }
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
        if (final.length < recognitionFinalRef.current.length ||
            !final.startsWith(recognitionFinalRef.current)) {
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
      try { rec.start(); setStatus('Listening live'); }
      catch {
        setError('Unable to start speech recognition. Check microphone permissions.');
        haltRecognition(true);
      }
    };
    openRecognition();
  }, [appendWords, finishStop, haltRecognition, language, updateInterim, scheduleSilenceStop]);

  const stopListening = useCallback(async () => {
    if (!shouldListenRef.current) return;
    stoppingRef.current = true;
    shouldListenRef.current = false;
    clearTimers();
    setListening(false);
    setStatus('Finishing transcription...');
    const rec = recognitionRef.current;
    if (!rec) { haltRecognition(true); return; }
    await new Promise<void>(resolve => {
      stopFinalizeRef.current = resolve;
      stopWaitRef.current = setTimeout(() => {
        // Some browsers never send onend after stop().
        appendWords(interimRef.current);
        updateInterim('');
        finishStop();
      }, 850);
      try { rec.stop(); } catch { finishStop(); }
    });
    haltRecognition(false);
  }, [appendWords, clearTimers, finishStop, haltRecognition, updateInterim]);

  stopListeningRef.current = stopListening;

  const changeAutoPause = useCallback((on: boolean) => {
    autoPauseRef.current = on;
    setAutoPause(on);
    if (silenceRef.current) clearTimeout(silenceRef.current);
    silenceRef.current = null;
    // If words were already heard, start counting the current pause now.
    if (on && shouldListenRef.current && (recognitionFinalRef.current.trim() || interimRef.current.trim())) scheduleSilenceStop();
  }, [scheduleSilenceStop]);

  const clearDraft = useCallback(() => {
    updateDraft('');
    updateInterim('');
    setError('');
    if (shouldListenRef.current) {
      // Invalidate old callbacks so previous words cannot reappear after Clear.
      haltRecognition(false);
      // Restart on the next tick after disposing the old recognition instance.
      setTimeout(() => { if (mountedRef.current) startListening(); }, 80);
    }
    textareaRef.current?.focus();
  }, [haltRecognition, startListening, updateDraft, updateInterim]);

  const refreshSessions = useCallback(async () => {
    try { const r = await fetch(`${API}/api/conversations`); if (r.ok) setSessions((await r.json()).sessions); } catch { /* backend offline */ }
  }, []);

  const openSession = useCallback(async (id: string) => {
    if (busyRef.current) return;
    haltRecognition(false);
    try {
      const r = await fetch(`${API}/api/conversations/${id}`);
      if (!r.ok) throw new Error('Could not open interview');
      const data = await r.json();
      stickToBottomRef.current = true;
      setConversationId(id); setMessages(data.messages);
      setAnswerMode(data.session.mode || 'balanced'); setView('interview'); updateDraft(''); setError(''); setStreamMetrics(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load history'); }
  }, [haltRecognition, updateDraft]);

  const renameSession = useCallback(async (id: string, title: string) => {
    const next = window.prompt('Interview title', title);
    if (!next?.trim()) return;
    await fetch(`${API}/api/conversations/${id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({title:next.trim()}) });
    void refreshSessions();
  }, [refreshSessions]);

  const deleteSession = useCallback(async (id: string) => {
    if (busyRef.current || !window.confirm('Delete this interview and its saved questions, answers and resume?')) return;
    const r = await fetch(`${API}/api/conversations/${id}`, { method:'DELETE' });
    if (r.ok) { if (conversationId === id) { setConversationId(null); setMessages([]); } void refreshSessions(); }
  }, [conversationId, refreshSessions]);

  const sendMessage = useCallback(async () => {
    if (busyRef.current) return;
    if (shouldListenRef.current) await stopListening();
    const text = draftRef.current.trim();
    if (!text || busyRef.current) { if (!text) setError('Type or speak a message first.'); return; }
    if (text.length > MAX_QUESTION_CHARS) {
      setFailedDraft(null);
      setError(`Your question is ${text.length.toLocaleString()} characters. The limit is ${MAX_QUESTION_CHARS.toLocaleString()}.`);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(''); setFailedDraft(null);
    updateDraft('');
    updateInterim('');
    stickToBottomRef.current = true; // show the new question even if the reader had scrolled up
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setStreamMetrics(null);
    const controller = new AbortController();
    chatRequestRef.current = controller;
    // Create an answer placeholder and update it progressively as chunks arrive.
    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);
    let completed = false;
    try {
      const response = await fetch(`${API}/api/chat/stream`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, conversation_id: conversationId, mode: answerMode }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(errorMessage(data, `Chat request failed (${response.status})`));
      }
      if (!response.body) throw new Error('Streaming is not supported by this connection.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let received = '';
      const processLine = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line) as StreamEvent;
        if (event.type === 'start' && event.conversation_id) setConversationId(event.conversation_id);
        if (event.type === 'delta' && event.text) {
          received += event.text;
          const next = received;
          setMessages(prev => prev.map((m, i) => i === prev.length - 1 ? { role: 'assistant', content: next } : m));
        }
        if (event.type === 'done') {
          completed = true;
          setStreamMetrics({ first: event.first_token_ms ?? null, total: event.total_ms ?? 0 });
          if (event.conversation_id) setConversationId(event.conversation_id);
          void refreshSessions();
        }
        if (event.type === 'error') throw new Error(event.message || 'Gemini streaming failed');
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) processLine(line);
      }
      buffer += decoder.decode();
      if (buffer.trim()) processLine(buffer);
      if (!completed) throw new Error('The response ended before Gemini finished. Please retry.');
    } catch (e) {
      if (!controller.signal.aborted && mountedRef.current) {
        setError(e instanceof Error ? e.message : 'Could not send message');
        updateDraft(text); setFailedDraft(text);
        // Drop the uncompleted answer and unsaved question.
        setMessages(prev => prev.slice(0, -2));
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
      if (chatRequestRef.current === controller) chatRequestRef.current = null;
    }
  }, [answerMode, conversationId, stopListening, updateDraft, updateInterim, refreshSessions]);

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
  const changeAnswerMode = useCallback((mode: AnswerMode) => {
    setAnswerMode(mode);
    if (!conversationId) return;
    void fetch(`${API}/api/conversations/${conversationId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) })
      .catch(() => { /* not critical: the next question still uses the new length */ });
  }, [conversationId]);

  const newChat = useCallback(() => {
    if (busyRef.current) return;
    haltRecognition(false); updateDraft(''); updateInterim('');
    setMessages([]); setConversationId(null);
    setAnswerMode('balanced'); setTargetRole('GenAI Developer'); setInterviewType('Technical');
    setInstructions(''); setJobDescription(''); setSetupResume(null); setError(''); setStreamMetrics(null);
    setView('setup'); void refreshSessions();
  }, [haltRecognition, updateDraft, updateInterim, refreshSessions]);

  const startInterview = useCallback(async () => {
    if (starting || !targetRole.trim()) return;
    setStarting(true); setError('');
    // Holds the new interview's id until setup finishes, so a failed resume upload can remove it.
    let unfinishedId: string | null = null;
    try {
      const r = await fetch(`${API}/api/conversations`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({target_role:targetRole.trim(),interview_type:interviewType,mode:answerMode,instructions,job_description:jobDescription})});
      if (!r.ok) throw new Error('Could not create interview');
      const id = (await r.json()).conversation_id as string;
      unfinishedId = id;
      if (setupResume) {
        const body = new FormData(); body.append('file',setupResume);
        const uploaded = await fetch(`${API}/api/conversations/${id}/resume`, {method:'POST',body});
        if (!uploaded.ok) { const data = await uploaded.json().catch(()=>({})); throw new Error(errorMessage(data, 'Resume upload failed')); }
      }
      unfinishedId = null;
      setConversationId(id); setMessages([]); setView('interview'); setSetupResume(null);
      await refreshSessions();
    } catch(e) {
      // Remove the half-made interview so retrying doesn't leave empty ones in History.
      if (unfinishedId) await fetch(`${API}/api/conversations/${unfinishedId}`, {method:'DELETE'}).catch(()=>{});
      setError(e instanceof Error ? e.message : 'Could not start interview');
    }
    finally { setStarting(false); }
  },[starting,targetRole,interviewType,answerMode,instructions,jobDescription,setupResume,refreshSessions]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshSessions();
    const w = window as SpeechWindow;
    setSupported(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition));
    return () => {
      mountedRef.current = false;
      haltRecognition(false);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      chatRequestRef.current?.abort();
    };
  }, [haltRecognition, refreshSessions]);

  // The file picker isn't controlled by React, so empty it whenever the attached resume is removed.
  useEffect(() => { if (!setupResume && resumeInputRef.current) resumeInputRef.current.value = ''; }, [setupResume]);

  // Scrolling up pauses following the streamed answer, and scrolling back to the bottom resumes it.
  // Only an upward scroll pauses it, so text arriving mid-scroll can't switch following off.
  const onPanelScroll = useCallback(() => {
    const body = conversationBodyRef.current;
    if (!body) return;
    const top = body.scrollTop;
    if (top < panelTopRef.current - 1) stickToBottomRef.current = false;
    else if (body.scrollHeight - top - body.clientHeight <= 32) stickToBottomRef.current = true;
    panelTopRef.current = top;
  }, []);
  // On narrow screens the answer panel doesn't scroll on its own; the whole page does.
  const onPageScroll = useCallback(() => {
    const body = conversationBodyRef.current, marker = bottomRef.current;
    if (!body || !marker) return;
    const top = window.scrollY;
    if (body.scrollHeight <= body.clientHeight + 1) {
      if (top < pageTopRef.current - 1) stickToBottomRef.current = false;
      else if (marker.getBoundingClientRect().top <= window.innerHeight + 32) stickToBottomRef.current = true;
    }
    pageTopRef.current = top;
  }, []);
  useEffect(() => {
    window.addEventListener('scroll', onPageScroll, { passive: true });
    return () => window.removeEventListener('scroll', onPageScroll);
  }, [onPageScroll]);
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ block: 'end' });
    // Our own scroll isn't the reader scrolling up, so compare later scrolls against where it left things.
    panelTopRef.current = conversationBodyRef.current?.scrollTop ?? 0;
    pageTopRef.current = window.scrollY;
  }, [messages, busy]);

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

  const time = `${Math.floor(elapsed / 60).toString().padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`;
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">✦</span><div><h1>AI Interact</h1><p>Interview practice with Gemini</p></div></div>
        <nav className="top-actions" aria-label="Main navigation">
          <button className={`btn ${view==='setup'?'primary':'subtle'}`} onClick={newChat} disabled={busy || starting}>+ New Interview</button>
          <button className={`btn ${view==='history'?'primary':'subtle'}`} onClick={()=>{haltRecognition(false);setError('');setView('history');void refreshSessions();}} disabled={busy || starting}>History</button>
          {view==='interview' && <span className="online"><span className="online-dot"/> Interview workspace</span>}
        </nav>
      </header>
      {view==='setup' && <section className="setup-page"><div className="setup-card">
        <span className="eyebrow">START A NEW SESSION</span><h2>New Interview</h2><p className="setup-subtitle">Set up your interview before entering the focused workspace. A resume is optional and belongs only to this session.</p>
        <label className="setup-field">Target role<input value={targetRole} maxLength={100} onChange={e=>setTargetRole(e.target.value)} placeholder="e.g. GenAI Developer" /></label>
        <fieldset className="setup-field"><legend>Interview type</legend><div className="setup-choice-row">{(['Technical','HR','Mixed'] as const).map(t=><button type="button" key={t} className={`choice ${interviewType===t?'selected':''}`} onClick={()=>setInterviewType(t)}>{t}</button>)}</div></fieldset>
        <div className="setup-field"><label htmlFor="setup-resume">Candidate resume <span className="optional">Optional · PDF or DOCX · up to 5 MB</span></label><input ref={resumeInputRef} id="setup-resume" type="file" accept=".pdf,.docx" onChange={e=>{const file=e.target.files?.[0]||null;if(file && file.size>5*1024*1024){setError('Resume must be 5 MB or smaller');e.target.value='';return;}setSetupResume(file);setError('');}}/>{setupResume && <span className="attached-file">📄 {setupResume.name} <button type="button" onClick={()=>setSetupResume(null)}>Remove</button></span>}</div>
        <div className="setup-field"><label>Answer mode</label><div className="setup-choice-row">{(['quick','balanced','detailed'] as AnswerMode[]).map(m=><button type="button" key={m} className={`choice ${answerMode===m?'selected':''}`} onClick={()=>setAnswerMode(m)}>{m==='quick'?'Short':m[0].toUpperCase()+m.slice(1)}</button>)}</div></div>
        <label className="setup-field">Job description <span className="optional">Optional · paste the role requirements</span><textarea rows={4} maxLength={12000} value={jobDescription} onChange={e=>setJobDescription(e.target.value)} placeholder="Paste a job description to tailor technical topics without inventing experience." /></label>
        <label className="setup-field">Additional instructions <span className="optional">Optional</span><textarea rows={3} maxLength={2000} value={instructions} onChange={e=>setInstructions(e.target.value)} placeholder="e.g. Focus on my recent projects and keep answers conversational." /></label>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <button className="btn primary start-interview" onClick={()=>void startInterview()} disabled={starting || !targetRole.trim()}>{starting?'Preparing interview…':'Start Interview →'}</button>
      </div></section>}
      {view==='history' && <section className="history-page"><div className="history-page-head"><div><span className="eyebrow">YOUR SAVED SESSIONS</span><h2>Interview History</h2><p>Open a previous session to review or continue the conversation.</p></div><button className="btn primary" onClick={newChat}>+ New Interview</button></div>
        <input className="history-search" value={historySearch} onChange={e=>setHistorySearch(e.target.value)} placeholder="Search interview titles, roles, or dates…" aria-label="Search interview history" />
        <div className="history-grid">{sessions.filter(s=>[s.title,s.target_role,s.interview_type,s.created_at].join(' ').toLowerCase().includes(historySearch.toLowerCase())).map(session=><article key={session.id} className="history-card"><button className="history-card-open" onClick={()=>void openSession(session.id)}><strong>{session.title}</strong><span>{session.target_role||'Interview'} · {session.interview_type||'Technical'} · {session.resume_name?'Resume attached':'No resume'}</span><small>Last updated {session.updated_at?.slice(0,10)}</small></button><div className="history-actions"><button onClick={()=>void renameSession(session.id,session.title)}>Rename</button><button onClick={()=>void deleteSession(session.id)}>Delete</button></div></article>)}
          {sessions.length===0 && <div className="history-empty">No saved interviews yet. Start a new interview to create one.</div>}</div>
        {error && <div className="error-banner" role="alert">{error}</div>}
      </section>}
      {view==='interview' && <div className={`workspace ${focusMode?'focus-workspace':''}`}>
        <section className="input-panel" aria-label="Unified text and voice input">
          <div className="panel-title"><div><span className="eyebrow">YOUR WORKSPACE</span><h2>Ask anything</h2><p>Type, speak, or edit while speaking.</p></div><span className="panel-icon">✎</span></div>
          <div className={`editor-wrap ${listening ? 'active' : ''}`}>
            <div className="editor-top"><span className={`status-dot ${listening ? 'pulse' : ''}`}/><span>{status}</span>{listening && <span className="duration">{time}</span>}</div>
            <textarea ref={textareaRef} aria-label="Your message" placeholder="Type a question, or tap the microphone to speak..." value={draft} onChange={e => updateDraft(e.target.value)} spellCheck rows={10} />
            {interim && <div className="interim" aria-live="off"><span className="interim-label">Recognizing</span> {interim}</div>}
            <div className="editor-foot"><span className={draft.length > MAX_QUESTION_CHARS ? 'over-limit' : undefined}>{draft.length.toLocaleString()} / {MAX_QUESTION_CHARS.toLocaleString()} characters</span><span>Editable even while listening</span></div>
          </div>
          <div className="controls">
            <button className={`btn mic-btn ${listening ? 'recording' : ''}`} onClick={() => listening ? void stopListening() : startListening()} disabled={!supported || busy} aria-pressed={listening}>
              <span aria-hidden="true">{listening ? '■' : '🎙'}</span> {listening ? 'Stop listening' : 'Start speaking'}
            </button>
            <button className="btn subtle" onClick={clearDraft} disabled={busy} title="Clear draft, keep microphone active">Clear</button>
            <button className="btn primary" onClick={() => void sendMessage()} disabled={busy || (!draft.trim() && !interim.trim())}> {busy ? 'Sending…' : 'Send ↗'}</button>
          </div>
          <div className="answer-mode-wrap">
            <label htmlFor="answer-mode">Interview answer length</label>
            <div className="answer-mode-options" role="group" aria-label="Interview answer length">
              {(['quick', 'balanced', 'detailed'] as AnswerMode[]).map(mode =>
                <button type="button" key={mode} className={`answer-mode-button ${answerMode === mode ? 'selected' : ''}`}
                  aria-pressed={answerMode === mode} disabled={busy} onClick={() => changeAnswerMode(mode)}>
                  {mode==='quick'?'Short':mode[0].toUpperCase() + mode.slice(1)}
                </button>
              )}
            </div>
          </div>
          <div className="options-row"><label><input type="checkbox" checked={autoPause} onChange={e=>changeAutoPause(e.target.checked)}/> Stop listening after 2.2s of silence (review before sending)</label></div>
          <div className="options-row"><label htmlFor="language">Recognition language</label><select id="language" value={language} onChange={e => setLanguage(e.target.value)} disabled={listening}>{LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}</select></div>
          <div className="tips">{!supported ? 'Live speech recognition is unavailable in this browser. Try Chrome.' : 'Live words appear below the editable text until finalized. You can edit the text at any time.'}<br/>Shortcut: <kbd>⌘ / Ctrl</kbd> + <kbd>Enter</kbd> to send.</div>
          {error && <div className="error-banner" role="alert">{error} {failedDraft && <button className="btn subtle" onClick={()=>void sendMessage()} disabled={busy}>Retry question</button>}</div>}
        </section>
        <section className="conversation-panel" aria-label="AI conversation">
          <div className="conversation-head"><button className="btn subtle" onClick={()=>setFocusMode(v=>!v)} aria-pressed={focusMode} title={focusMode ? 'Show all settings again' : 'Hide settings and highlight the latest answer'}>{focusMode?'Exit Focus':'Focus Mode'}</button><div><span className="eyebrow">GEMINI AI</span><h2>Questions &amp; Answers</h2></div><label className="font-control">Font size <select value={fontSize} onChange={e => setFontSize(Number(e.target.value))}><option value={16}>Normal</option><option value={20}>Large</option><option value={24}>Extra large</option></select></label></div>
          <div className="conversation-body" aria-live="polite" ref={conversationBodyRef} onScroll={onPanelScroll}>
            {messages.length === 0 && <div className="empty-state"><div className="empty-orb">✦</div><h3>Ready when you are</h3><p>Your conversation appears here. Start by typing or speaking on the left.</p></div>}
            {messages.map((message, i) => <article className={`message ${message.role}${i >= messages.length - 2 ? ' latest' : ''}`} key={i}>
              <div className="message-label">
                <span className="message-heading"><span className="message-label-icon">{message.role === 'user' ? '?' : '✦'}</span>{message.role === 'user' ? 'Question' : 'Answer'}</span>
                <button type="button" className="copy-button" onClick={() => void copyMessage(message.content, String(i))} aria-label={`Copy ${message.role === 'user' ? 'question' : 'answer'}`}>
                  <span aria-hidden="true">{copiedKey === String(i) ? '✓' : '⧉'}</span> {copiedKey === String(i) ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div className="message-text" style={{fontSize: message.role === 'user' ? fontSize+2 : fontSize}}><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
            </article>)}
            {busy && <div className="thinking"><span className="spinner"/> {messages[messages.length - 1]?.content ? 'Generating answer...' : 'Waiting for Gemini...'} </div>}
            <div ref={bottomRef}/>
          </div>
          <div className="conversation-bottom"><span>{messages.length} messages{streamMetrics ? ` · First text ${streamMetrics.first ?? "—"} ms · Total ${streamMetrics.total} ms` : ""}</span><button onClick={() => setHistoryOpen(v => !v)} className="text-button">{historyOpen ? 'Hide' : 'Show'} session info</button></div>
          {historyOpen && <div className="session-info">Conversation ID: {conversationId || 'New conversation'}<br/>Messages are saved by the FastAPI backend after successful replies.</div>}
        </section>
      </div>}
    </main>
  );
}
