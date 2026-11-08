import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type RefObject } from 'react';
import { MAX_IMAGES, isImage, type Attachment } from '../hooks/useImageAttachments';
import type { Speech } from '../hooks/useSpeechRecognition';
import type { ImproveStatus } from '../hooks/useTranscriptImprover';
import { MAX_QUESTION_CHARS } from '../lib/api';
import {
  ANSWER_MODES,
  ANSWER_STYLES,
  answerModeLabel,
  answerStyleLabel,
  type AnswerMode,
  type AnswerStyle,
  type VoiceSource,
} from '../lib/types';

const STYLE_HINTS: Record<AnswerStyle, string> = {
  simple: 'Everyday words and short sentences, the way you would explain it to a person',
  balanced: 'Plain, natural sentences with the right technical terms, a step deeper than Simple',
  technical: 'Precise technical terms and more depth, for senior or deep technical interviews',
};

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
  failed: "Gemini couldn't write some of it down, so Chrome's words were kept there",
};

type Props = {
  draft: string;
  onDraftChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  speech: Speech;
  /** Words shown in gray after the text: still being recognized, or waiting for Gemini. */
  preview: string;
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
  answerStyle: AnswerStyle;
  onAnswerStyleChange: (style: AnswerStyle) => void;
  language: string;
  onLanguageChange: (code: string) => void;
  autoSend: boolean;
  onAutoSendChange: (on: boolean) => void;
  error: string;
  failedDraft: string | null;
  onClear: () => void;
  onSend: () => void;
  /** Images to ask the question with (a screenshot of a coding problem, say). */
  attachments: Attachment[];
  onAddImages: (files: File[]) => void;
  onRemoveImage: (key: number) => void;
};

/** The left panel: the question box, Speak / Clear / Send, and the answer-length and voice settings. */
export function Composer({
  draft,
  onDraftChange,
  textareaRef,
  speech,
  preview,
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
  answerStyle,
  onAnswerStyleChange,
  language,
  onLanguageChange,
  autoSend,
  onAutoSendChange,
  error,
  failedDraft,
  onClear,
  onSend,
  attachments,
  onAddImages,
  onRemoveImage,
}: Props) {
  const { listening, status, elapsed, supported, autoPause, changeAutoPause } = speech;
  const shownStatus = !listening && improveStatus !== 'idle' ? IMPROVE_MESSAGES[improveStatus] : status;
  const fromTab = source === 'tab';
  // What Send needs: something to send (words, an image, or a question being spoken), and no answer under way.
  const canSend = !busy && (listening || Boolean(draft.trim()) || Boolean(preview) || attachments.length > 0);
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
  }, [draft, preview, listening, fitGhost, scrollGhost, textareaRef]);
  // Images come from the Add image button, a paste, or a drop on the box.
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const [dropping, setDropping] = useState(false);
  const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');
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
      <div
        className={`editor-wrap ${listening ? 'active' : ''} ${attachments.length ? 'has-images' : ''} ${dropping ? 'dropping' : ''}`}
        onDragOver={event => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
        }}
        onDrop={event => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          setDropping(false);
          onAddImages([...event.dataTransfer.files]);
        }}
      >
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
              // Not while gray words are shown, which would be drawn over it.
              preview
                ? ''
                : fromTab
                  ? 'Type a question or paste a screenshot, or press Listen to tab to write down what a tab is saying...'
                  : 'Type a question, paste a screenshot, or tap the microphone to speak...'
            }
            value={draft}
            onChange={e => onDraftChange(e.target.value)}
            onKeyDown={event => {
              // Enter sends, as in a chat; Shift+Enter starts a new line. (⌘/Ctrl+Enter is the page's own shortcut.)
              if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
              if (event.nativeEvent.isComposing) return; // still choosing a character in an input method
              event.preventDefault();
              if (canSend) onSend();
            }}
            onPaste={event => {
              // A pasted screenshot is attached; pasted text goes in as usual.
              const images = [...event.clipboardData.files].filter(isImage);
              if (!images.length) return;
              event.preventDefault();
              onAddImages(images);
            }}
            onScroll={scrollGhost}
            spellCheck
            rows={10}
          />
          {preview && (
            <div className="ghost-text" ref={ghostRef} aria-hidden="true">
              {draft}
              <span className="ghost-words">{(draft && !/\s$/.test(draft) ? ' ' : '') + preview}</span>
            </div>
          )}
        </div>
        {attachments.length > 0 && (
          <ul className="attachments" aria-label="Images with the question">
            {attachments.map(attachment => (
              <li
                key={attachment.key}
                className={`attachment ${attachment.status}`}
                title={attachment.error || attachment.name}
              >
                {/* A local file or one on the backend, which next/image can't optimize. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={attachment.url} alt={attachment.name} />
                {attachment.status === 'uploading' && <span className="spinner" aria-label="Uploading" />}
                {attachment.status === 'failed' && (
                  <span className="attachment-failed" aria-label={attachment.error}>
                    !
                  </span>
                )}
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => onRemoveImage(attachment.key)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="editor-foot">
          <span className={draft.length > MAX_QUESTION_CHARS ? 'over-limit' : undefined}>
            {draft.length.toLocaleString()} / {MAX_QUESTION_CHARS.toLocaleString()} characters
          </span>
          <button
            type="button"
            className="text-button attach-button"
            onClick={() => pickerRef.current?.click()}
            disabled={busy || attachments.length >= MAX_IMAGES}
            title="Ask about a screenshot, a diagram or a photo: add it here, paste it, or drop it on the box"
          >
            <span aria-hidden="true">🖼</span> Add image
          </button>
          <input
            ref={pickerRef}
            type="file"
            accept="image/*,.heic,.heif"
            multiple
            hidden
            aria-label="Images to add"
            onChange={event => {
              onAddImages([...(event.target.files ?? [])]);
              event.target.value = ''; // so the same image can be picked again
            }}
          />
        </div>
      </div>
      <div className="controls">
        <button
          className={`btn mic-btn ${listening ? 'recording' : ''}`}
          onClick={() => {
            if (listening) onStopDictation();
            else onStartDictation();
            // With a mouse, the cursor goes back to the question box, so Enter sends the question rather than
            // pressing this button again. Not on touch screens, where it would bring up the keyboard.
            if (window.matchMedia('(pointer: fine)').matches) textareaRef.current?.focus();
          }}
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
        <button className="btn primary" onClick={onSend} disabled={!canSend}>
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
      <div className="answer-mode-wrap">
        <label>Answer style</label>
        <div className="answer-mode-options" role="group" aria-label="Answer style">
          {ANSWER_STYLES.map(style => (
            <button
              type="button"
              key={style}
              className={`answer-mode-button ${answerStyle === style ? 'selected' : ''}`}
              aria-pressed={answerStyle === style}
              title={STYLE_HINTS[style]}
              disabled={busy}
              onClick={() => onAnswerStyleChange(style)}
            >
              {answerStyleLabel(style)}
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
        Shortcut: <kbd>Enter</kbd> to send, <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line.
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}{' '}
          {failedDraft !== null && (
            <button className="btn subtle" onClick={onSend} disabled={busy}>
              Retry question
            </button>
          )}
        </div>
      )}
    </section>
  );
}
