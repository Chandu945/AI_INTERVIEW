import { useState } from 'react';
import type { Session } from '../lib/types';
import { TitleEditor } from './TitleEditor';

type Props = {
  /** The interview being held; null on the other pages. */
  interview: Session | null;
  /** While an answer is being written, the interview can't be left or renamed. */
  busy: boolean;
  onBack: () => void;
  onRename: (title: string) => void;
};

/**
 * The bar across the top. On the Interviews page and the New interview form it shows the app's
 * name; during an interview, only the way back to Interviews and the interview's title and
 * details, so nothing there pulls you out of it by mistake.
 */
export function TopBar({ interview, busy, onBack, onRename }: Props) {
  const [renaming, setRenaming] = useState(false);
  if (!interview)
    return (
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ✦
          </span>
          <div>
            <h1>AI Interact</h1>
            <p>Interview practice with Gemini</p>
          </div>
        </div>
      </header>
    );
  const details = [interview.target_role, interview.interview_type].filter(Boolean).join(' · ');
  return (
    <header className="topbar interview-bar">
      <span className="brand-mark small" aria-hidden="true">
        ✦
      </span>
      <button type="button" className="back-button" onClick={onBack} disabled={busy} aria-label="Back to interviews">
        <span aria-hidden="true">←</span> Interviews
      </button>
      <div className="interview-heading">
        {renaming ? (
          <TitleEditor
            title={interview.title}
            onDone={title => {
              setRenaming(false);
              if (title) onRename(title);
            }}
          />
        ) : (
          <button
            type="button"
            className="title-button"
            onClick={() => setRenaming(true)}
            disabled={busy}
            title="Rename this interview"
          >
            <h1>{interview.title}</h1>
            <span className="pencil" aria-hidden="true">
              ✎
            </span>
          </button>
        )}
        <p>
          {details}
          {interview.resume_name && (
            <span className="resume-tag">
              <span aria-hidden="true">📄</span> {interview.resume_name}
            </span>
          )}
        </p>
      </div>
    </header>
  );
}
