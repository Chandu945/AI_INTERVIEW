import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../lib/api';
import { REWRITES, type Message, type Rewrite } from '../lib/types';

const REMARK_PLUGINS = [remarkGfm];
const REWRITE_LABELS: Record<Rewrite, string> = { shorter: 'Shorter', simpler: 'Simpler', more_detail: 'More detail' };
const REWRITE_HINTS: Record<Rewrite, string> = {
  shorter: 'Say it again in about half the words',
  simpler: 'Say it again in everyday words and short sentences',
  more_detail: 'Say it again with the reasoning, an example and a trade-off',
};

type Props = {
  message: Message;
  index: number;
  latest: boolean;
  copied: boolean;
  fontSize: number;
  onCopy: (content: string, key: string) => void;
  /** Given for the latest answer only, once it's complete: shows the buttons that say it again. */
  onRewrite?: (how: Rewrite) => void;
};

/** One question or answer. Memoized, so while an answer streams in only that message re-renders. */
export const MessageItem = memo(function MessageItem({
  message,
  index,
  latest,
  copied,
  fontSize,
  onCopy,
  onRewrite,
}: Props) {
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
      {message.images?.length ? (
        <div className="message-images">
          {message.images.map(imageId => (
            <a key={imageId} href={api.imageUrl(imageId)} target="_blank" rel="noreferrer" title="Open the image">
              {/* On the backend, which next/image can't optimize. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={api.imageUrl(imageId)} alt="Shared with the question" loading="lazy" />
            </a>
          ))}
        </div>
      ) : null}
      {(message.content || !message.images?.length) && (
        <div className="message-text" style={{ fontSize: isQuestion ? fontSize + 2 : fontSize }}>
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{message.content}</ReactMarkdown>
        </div>
      )}
      {onRewrite && message.content && (
        <div className="rewrite-row" role="group" aria-label="Say this answer again">
          {REWRITES.map(how => (
            <button
              type="button"
              key={how}
              className="rewrite-button"
              title={REWRITE_HINTS[how]}
              onClick={() => onRewrite(how)}
            >
              {REWRITE_LABELS[how]}
            </button>
          ))}
        </div>
      )}
    </article>
  );
});
