import type { RefObject } from 'react';
import type { Speech } from '../hooks/useSpeechRecognition';
import { MAX_QUESTION_CHARS } from '../lib/api';
import { ANSWER_MODES, answerModeLabel, type AnswerMode } from '../lib/types';

const LANGUAGES = [
  { code: 'en-IN', label: 'English (India)' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'hi-IN', label: 'Hindi' },
  { code: 'te-IN', label: 'Telugu' },
];

type Props = {
  draft: string;
  onDraftChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  speech: Speech;
  busy: boolean;
  answerMode: AnswerMode;
  onAnswerModeChange: (mode: AnswerMode) => void;
  language: string;
  onLanguageChange: (code: string) => void;
  error: string;
  failedDraft: string | null;
  onClear: () => void;
  onSend: () => void;
};

/** The left panel: the question box, Speak / Clear / Send, and the answer-length and voice settings. */
export function Composer({
  draft, onDraftChange, textareaRef, speech, busy, answerMode, onAnswerModeChange,
  language, onLanguageChange, error, failedDraft, onClear, onSend,
}: Props) {
  const { listening, status, elapsed, interim, supported, autoPause, changeAutoPause, startListening, stopListening } = speech;
  const time = `${Math.floor(elapsed / 60).toString().padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`;
  return (
    <section className="input-panel" aria-label="Unified text and voice input">
      <div className="panel-title"><div><span className="eyebrow">YOUR WORKSPACE</span><h2>Ask anything</h2><p>Type, speak, or edit while speaking.</p></div><span className="panel-icon">✎</span></div>
      <div className={`editor-wrap ${listening ? 'active' : ''}`}>
        <div className="editor-top"><span className={`status-dot ${listening ? 'pulse' : ''}`}/><span>{status}</span>{listening && <span className="duration">{time}</span>}</div>
        <textarea ref={textareaRef} aria-label="Your message" placeholder="Type a question, or tap the microphone to speak..." value={draft} onChange={e => onDraftChange(e.target.value)} spellCheck rows={10} />
        {interim && <div className="interim" aria-live="off"><span className="interim-label">Recognizing</span> {interim}</div>}
        <div className="editor-foot">
          <span className={draft.length > MAX_QUESTION_CHARS ? 'over-limit' : undefined}>{draft.length.toLocaleString()} / {MAX_QUESTION_CHARS.toLocaleString()} characters</span>
          <span>Editable even while listening</span>
        </div>
      </div>
      <div className="controls">
        <button className={`btn mic-btn ${listening ? 'recording' : ''}`} onClick={() => listening ? void stopListening() : startListening()} disabled={!supported || busy} aria-pressed={listening}>
          <span aria-hidden="true">{listening ? '■' : '🎙'}</span> {listening ? 'Stop listening' : 'Start speaking'}
        </button>
        <button className="btn subtle" onClick={onClear} disabled={busy} title="Clear draft, keep microphone active">Clear</button>
        <button className="btn primary" onClick={onSend} disabled={busy || (!draft.trim() && !interim.trim())}> {busy ? 'Sending…' : 'Send ↗'}</button>
      </div>
      <div className="answer-mode-wrap">
        <label htmlFor="answer-mode">Interview answer length</label>
        <div className="answer-mode-options" role="group" aria-label="Interview answer length">
          {ANSWER_MODES.map(mode => (
            <button type="button" key={mode} className={`answer-mode-button ${answerMode === mode ? 'selected' : ''}`}
              aria-pressed={answerMode === mode} disabled={busy} onClick={() => onAnswerModeChange(mode)}>
              {answerModeLabel(mode)}
            </button>
          ))}
        </div>
      </div>
      <div className="options-row"><label><input type="checkbox" checked={autoPause} onChange={e => changeAutoPause(e.target.checked)}/> Stop listening after 2.2s of silence (review before sending)</label></div>
      <div className="options-row">
        <label htmlFor="language">Recognition language</label>
        <select id="language" value={language} onChange={e => onLanguageChange(e.target.value)} disabled={listening}>{LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}</select>
      </div>
      <div className="tips">{!supported ? 'Live speech recognition is unavailable in this browser. Try Chrome.' : 'Live words appear below the editable text until finalized. You can edit the text at any time.'}<br/>Shortcut: <kbd>⌘ / Ctrl</kbd> + <kbd>Enter</kbd> to send.</div>
      {error && <div className="error-banner" role="alert">{error} {failedDraft && <button className="btn subtle" onClick={onSend} disabled={busy}>Retry question</button>}</div>}
    </section>
  );
}
