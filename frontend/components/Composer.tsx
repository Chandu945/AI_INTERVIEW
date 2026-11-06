import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { Speech } from '../hooks/useSpeechRecognition';
import type { ImproveStatus } from '../hooks/useTranscriptImprover';
import { MAX_QUESTION_CHARS } from '../lib/api';
import { ANSWER_MODES, answerModeLabel, type AnswerMode, type VoiceSource } from '../lib/types';

const LANGUAGES = [
  { code: 'en-IN', label: 'English (India)' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'hi-IN', label: 'Hindi' },
  { code: 'te-IN', label: 'Telugu' },
];

// Shown in place of the mic status once dictation has stopped.
const IMPROVE_MESSAGES: Record<ImproveStatus, string> = {
  idle: '',
  improving: 'Improving the transcript with Gemini…',
  improved: 'Transcript improved by Gemini',
  'kept-edits': 'Kept your edits (the improved transcript was not applied)',
  failed: "Couldn't improve the transcript, so the live text was kept",
  'too-long': 'Long recording, so the live text was kept',
};

type Props = {
  draft: string;
  onDraftChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  speech: Speech;
  source: VoiceSource;
  onSourceChange: (source: VoiceSource) => void;
  /** Whether this browser can share a tab's sound. */
  tabSupported: boolean;
  /** Whether a tab is shared right now. */
  tabShared: boolean;
  onStopSharing: () => void;
  onStartDictation: () => void;
  onStopDictation: () => void;
  improve: boolean;
  onImproveChange: (on: boolean) => void;
  improveStatus: ImproveStatus;
  busy: boolean;
  answerMode: AnswerMode;
  onAnswerModeChange: (mode: AnswerMode) => void;
  language: string;
  onLanguageChange: (code: string) => void;
  autoSend: boolean;
  onAutoSendChange: (on: boolean) => void;
  error: string;
  failedDraft: string | null;
  onClear: () => void;
  onSend: () => void;
};

/** The left panel: the question box, Speak / Clear / Send, and the answer-length and voice settings. */
export function Composer({
  draft,
  onDraftChange,
  textareaRef,
  speech,
  source,
  onSourceChange,
  tabSupported,
  tabShared,
  onStopSharing,
  onStartDictation,
  onStopDictation,
  improve,
  onImproveChange,
  improveStatus,
  busy,
  answerMode,
  onAnswerModeChange,
  language,
  onLanguageChange,
  autoSend,
  onAutoSendChange,
  error,
  failedDraft,
  onClear,
  onSend,
}: Props) {
  const { listening, status, elapsed, interim, supported, autoPause, changeAutoPause } = speech;
  const shownStatus = !listening && improveStatus !== 'idle' ? IMPROVE_MESSAGES[improveStatus] : status;
  const fromTab = source === 'tab';
  // Words still being recognized are shown in gray right after the text, on a see-through copy of
  // the box's text laid over it: the same size, the same wrapping, and scrolled with it.
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const fitGhost = useCallback(() => {
    const box = textareaRef.current;
    const ghost = ghostRef.current;
    if (!box) return;
    if (!ghost) {
      box.style.paddingBottom = '';
      return;
    }
    ghost.style.width = `${box.clientWidth}px`;
    ghost.style.height = `${box.clientHeight}px`;
    // Room under the text for gray words that run past it, so the box scrolls just as far as the
    // copy and can bring them into view: grown or shrunk, never removed first, which would snap
    // the box's scroll position back.
    const base = parseFloat(getComputedStyle(box).paddingTop);
    let padding = parseFloat(box.style.paddingBottom) || base;
    for (let i = 0; i < 3; i++) {
      const missing = ghost.scrollHeight - box.scrollHeight;
      if (missing === 0 || (missing < 0 && padding <= base)) break;
      padding = Math.max(base, padding + missing);
      box.style.paddingBottom = padding > base ? `${padding}px` : '';
    }
  }, [textareaRef]);
  const scrollGhost = useCallback(() => {
    if (ghostRef.current && textareaRef.current) ghostRef.current.scrollTop = textareaRef.current.scrollTop;
  }, [textareaRef]);
  useEffect(() => {
    const box = textareaRef.current;
    if (!box) return;
    const observer = new ResizeObserver(() => {
      fitGhost();
      scrollGhost();
    });
    observer.observe(box, { box: 'border-box' }); // not its padding, which fitGhost changes
    return () => observer.disconnect();
  }, [fitGhost, scrollGhost, textareaRef]);
  // While listening, the newest words stay in view, unless you're editing elsewhere in the text.
  useLayoutEffect(() => {
    const box = textareaRef.current;
    if (!box) return;
    fitGhost();
    if (listening && (document.activeElement !== box || box.selectionStart === box.value.length))
      box.scrollTop = box.scrollHeight;
    scrollGhost();
  }, [draft, interim, listening, fitGhost, scrollGhost, textareaRef]);
  const time = `${Math.floor(elapsed / 60)
    .toString()
    .padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`;
  return (
    <section className="input-panel" aria-label="Unified text and voice input">
      <div className="panel-title">
        <div>
          <span className="eyebrow">YOUR WORKSPACE</span>
          <h2>Ask anything</h2>
          <p>Type, speak, or edit while speaking.</p>
        </div>
        <span className="panel-icon">✎</span>
      </div>
      <div className={`editor-wrap ${listening ? 'active' : ''}`}>
        <div className="editor-top">
          <span className={`status-dot ${listening ? 'pulse' : ''}`} />
          <span className="status-text" title={shownStatus}>
            {shownStatus}
          </span>
          {listening && <span className="duration">{time}</span>}
        </div>
        <div className="editor-text">
          <textarea
            ref={textareaRef}
            aria-label="Your message"
            placeholder={
              fromTab
                ? 'Type a question, or press Listen to tab to write down what a tab is saying...'
                : 'Type a question, or tap the microphone to speak...'
            }
            value={draft}
            onChange={e => onDraftChange(e.target.value)}
            onScroll={scrollGhost}
            spellCheck
            rows={10}
          />
          {interim && (
            <div className="ghost-text" ref={ghostRef} aria-hidden="true">
              {draft}
              <span className="ghost-words">{(draft && !/\s$/.test(draft) ? ' ' : '') + interim}</span>
            </div>
          )}
        </div>
        <div className="editor-foot">
          <span className={draft.length > MAX_QUESTION_CHARS ? 'over-limit' : undefined}>
            {draft.length.toLocaleString()} / {MAX_QUESTION_CHARS.toLocaleString()} characters
          </span>
          <span>Editable even while listening</span>
        </div>
      </div>
      <div className="controls">
        <button
          className={`btn mic-btn ${listening ? 'recording' : ''}`}
          onClick={() => (listening ? onStopDictation() : onStartDictation())}
          disabled={!supported || busy}
          aria-pressed={listening}
        >
          <span className="mic-icon" aria-hidden="true">
            {listening ? '■' : fromTab ? '🔊' : '🎙'}
          </span>{' '}
          {listening ? 'Stop listening' : fromTab ? 'Listen to tab' : 'Start speaking'}
        </button>
        <button className="btn subtle" onClick={onClear} disabled={busy} title="Clear draft, keep listening">
          Clear
        </button>
        {/* Pressable while listening, even before any words: sending waits for the last of them. */}
        <button className="btn primary" onClick={onSend} disabled={busy || (!listening && !draft.trim())}>
          {' '}
          {busy ? 'Sending…' : 'Send ↗'}
        </button>
      </div>
      <div className="answer-mode-wrap">
        <label htmlFor="answer-mode">Interview answer length</label>
        <div className="answer-mode-options" role="group" aria-label="Interview answer length">
          {ANSWER_MODES.map(mode => (
            <button
              type="button"
              key={mode}
              className={`answer-mode-button ${answerMode === mode ? 'selected' : ''}`}
              aria-pressed={answerMode === mode}
              disabled={busy}
              onClick={() => onAnswerModeChange(mode)}
            >
              {answerModeLabel(mode)}
            </button>
          ))}
        </div>
      </div>
      {tabSupported && (
        <div className="options-row">
          <label htmlFor="voice-source">Listen to</label>
          <span className="source-pick">
            {fromTab && tabShared && !listening && (
              <button type="button" className="text-button" onClick={onStopSharing}>
                Stop sharing
              </button>
            )}
            <select
              id="voice-source"
              value={source}
              onChange={e => onSourceChange(e.target.value as VoiceSource)}
              disabled={listening}
            >
              <option value="mic">Microphone</option>
              <option value="tab">A browser tab</option>
            </select>
          </span>
        </div>
      )}
      <div className="options-row">
        <label>
          <input type="checkbox" checked={improve} onChange={e => onImproveChange(e.target.checked)} /> Improve the
          transcript with Gemini as it listens
        </label>
      </div>
      <div className="options-row">
        <label>
          <input type="checkbox" checked={autoPause} onChange={e => changeAutoPause(e.target.checked)} /> Stop listening
          after 2.2s of silence
        </label>
      </div>
      <div className="options-row">
        <label>
          <input
            type="checkbox"
            checked={autoSend}
            disabled={!autoPause}
            onChange={e => onAutoSendChange(e.target.checked)}
          />{' '}
          …and send the question automatically (no review)
        </label>
      </div>
      <div className="options-row">
        <label htmlFor="language">Recognition language</label>
        <select id="language" value={language} onChange={e => onLanguageChange(e.target.value)} disabled={listening}>
          {LANGUAGES.map(l => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <div className="tips">
        {!supported
          ? 'Live speech recognition is unavailable in this browser. Try Chrome.'
          : fromTab
            ? 'Listen to tab: pick the tab in Chrome\'s list and keep "Also share tab audio" on. You still hear the tab as usual.'
            : 'Words appear in the box as they are heard, in gray until they are final. You can edit the text at any time.'}
        <br />
        Shortcut: <kbd>⌘ / Ctrl</kbd> + <kbd>Enter</kbd> to send.
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}{' '}
          {failedDraft && (
            <button className="btn subtle" onClick={onSend} disabled={busy}>
              Retry question
            </button>
          )}
        </div>
      )}
    </section>
  );
}
