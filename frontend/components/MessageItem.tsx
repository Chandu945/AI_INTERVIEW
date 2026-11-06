import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message } from '../lib/types';

const REMARK_PLUGINS = [remarkGfm];

type Props = {
  message: Message;
  index: number;
  latest: boolean;
  copied: boolean;
  fontSize: number;
  onCopy: (content: string, key: string) => void;
};

/** One question or answer. Memoized, so while an answer streams in only that message re-renders. */
export const MessageItem = memo(function MessageItem({ message, index, latest, copied, fontSize, onCopy }: Props) {
  const isQuestion = message.role === 'user';
  return (
    <article className={`message ${message.role}${latest ? ' latest' : ''}`}>
      <div className="message-label">
        <span className="message-heading">
          <span className="message-label-icon">{isQuestion ? '?' : '✦'}</span>
          {isQuestion ? 'Question' : 'Answer'}
        </span>
        <button
          type="button"
          className="copy-button"
          onClick={() => onCopy(message.content, String(index))}
          aria-label={`Copy ${isQuestion ? 'question' : 'answer'}`}
        >
          <span aria-hidden="true">{copied ? '✓' : '⧉'}</span> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="message-text" style={{ fontSize: isQuestion ? fontSize + 2 : fontSize }}>
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{message.content}</ReactMarkdown>
      </div>
    </article>
  );
});
