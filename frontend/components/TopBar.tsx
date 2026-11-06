import type { View } from '../lib/types';

type Props = {
  view: View;
  disabled: boolean;
  onNewInterview: () => void;
  onHistory: () => void;
};

export function TopBar({ view, disabled, onNewInterview, onHistory }: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">✦</span>
        <div>
          <h1>AI Interact</h1>
          <p>Interview practice with Gemini</p>
        </div>
      </div>
      <nav className="top-actions" aria-label="Main navigation">
        <button
          className={`btn ${view === 'setup' ? 'primary' : 'subtle'}`}
          onClick={onNewInterview}
          disabled={disabled}
        >
          + New Interview
        </button>
        <button className={`btn ${view === 'history' ? 'primary' : 'subtle'}`} onClick={onHistory} disabled={disabled}>
          History
        </button>
        {view === 'interview' && (
          <span className="online">
            <span className="online-dot" /> Interview workspace
          </span>
        )}
      </nav>
    </header>
  );
}
