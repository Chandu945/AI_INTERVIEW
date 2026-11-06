import type { RefObject } from 'react';
import type { Message, StreamMetrics } from '../lib/types';
import { MessageItem } from './MessageItem';

type Props = {
  messages: Message[];
  busy: boolean;
  focusMode: boolean;
  onToggleFocus: () => void;
  fontSize: number;
  onFontSizeChange: (size: number) => void;
  copiedKey: string | null;
  onCopy: (content: string, key: string) => void;
  streamMetrics: StreamMetrics | null;
  sessionInfoOpen: boolean;
  onToggleSessionInfo: () => void;
  conversationId: string | null;
  bodyRef: RefObject<HTMLDivElement | null>;
  bottomRef: RefObject<HTMLDivElement | null>;
  onPanelScroll: () => void;
};

/** The right panel: Focus Mode and font size controls, the questions and answers, and session info. */
export function ConversationPanel({
  messages,
  busy,
  focusMode,
  onToggleFocus,
  fontSize,
  onFontSizeChange,
  copiedKey,
  onCopy,
  streamMetrics,
  sessionInfoOpen,
  onToggleSessionInfo,
  conversationId,
  bodyRef,
  bottomRef,
  onPanelScroll,
}: Props) {
  return (
    <section className="conversation-panel" aria-label="AI conversation">
      <div className="conversation-head">
        <button
          className="btn subtle"
          onClick={onToggleFocus}
          aria-pressed={focusMode}
          title={focusMode ? 'Show all settings again' : 'Hide settings and highlight the latest answer'}
        >
          {focusMode ? 'Exit Focus' : 'Focus Mode'}
        </button>
        <div>
          <span className="eyebrow">GEMINI AI</span>
          <h2>Questions &amp; Answers</h2>
        </div>
        <label className="font-control">
          Font size{' '}
          <select value={fontSize} onChange={e => onFontSizeChange(Number(e.target.value))}>
            <option value={16}>Normal</option>
            <option value={20}>Large</option>
            <option value={24}>Extra large</option>
          </select>
        </label>
      </div>
      <div className="conversation-body" aria-live="polite" ref={bodyRef} onScroll={onPanelScroll}>
        {messages.length === 0 && (
          <div className="empty-state">
            <div className="empty-orb">✦</div>
            <h3>Ready when you are</h3>
            <p>Your conversation appears here. Start by typing or speaking on the left.</p>
          </div>
        )}
        {messages.map((message, i) => (
          <MessageItem
            key={i}
            message={message}
            index={i}
            latest={i >= messages.length - 2}
            copied={copiedKey === String(i)}
            fontSize={fontSize}
            onCopy={onCopy}
          />
        ))}
        {busy && (
          <div className="thinking">
            <span className="spinner" />{' '}
            {messages[messages.length - 1]?.content ? 'Generating answer...' : 'Waiting for Gemini...'}{' '}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="conversation-bottom">
        <span>
          {messages.length} messages
          {streamMetrics ? ` · First text ${streamMetrics.first ?? '—'} ms · Total ${streamMetrics.total} ms` : ''}
        </span>
        <button onClick={onToggleSessionInfo} className="text-button">
          {sessionInfoOpen ? 'Hide' : 'Show'} session info
        </button>
      </div>
      {sessionInfoOpen && (
        <div className="session-info">
          Conversation ID: {conversationId || 'New conversation'}
          <br />
          Messages are saved by the FastAPI backend after successful replies.
        </div>
      )}
    </section>
  );
}
