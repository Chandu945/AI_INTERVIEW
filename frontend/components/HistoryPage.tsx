import type { Session } from '../lib/types';

type Props = {
  sessions: Session[];
  search: string;
  onSearchChange: (search: string) => void;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onNewInterview: () => void;
  error: string;
};

export function HistoryPage({
  sessions,
  search,
  onSearchChange,
  onOpen,
  onRename,
  onDelete,
  onNewInterview,
  error,
}: Props) {
  const query = search.toLowerCase();
  const shown = sessions.filter(s =>
    [s.title, s.target_role, s.interview_type, s.created_at].join(' ').toLowerCase().includes(query),
  );
  return (
    <section className="history-page">
      <div className="history-page-head">
        <div>
          <span className="eyebrow">YOUR SAVED SESSIONS</span>
          <h2>Interview History</h2>
          <p>Open a previous session to review or continue the conversation.</p>
        </div>
        <button className="btn primary" onClick={onNewInterview}>
          + New Interview
        </button>
      </div>
      <input
        className="history-search"
        value={search}
        onChange={e => onSearchChange(e.target.value)}
        placeholder="Search interview titles, roles, or dates…"
        aria-label="Search interview history"
      />
      <div className="history-grid">
        {shown.map(session => (
          <article key={session.id} className="history-card">
            <button className="history-card-open" onClick={() => onOpen(session.id)}>
              <strong>{session.title}</strong>
              <span>
                {session.target_role || 'Interview'} · {session.interview_type || 'Technical'} ·{' '}
                {session.resume_name ? 'Resume attached' : 'No resume'}
              </span>
              <small>Last updated {session.updated_at?.slice(0, 10)}</small>
            </button>
            <div className="history-actions">
              <button onClick={() => onRename(session.id, session.title)}>Rename</button>
              <button onClick={() => onDelete(session.id)}>Delete</button>
            </div>
          </article>
        ))}
        {sessions.length === 0 && (
          <div className="history-empty">No saved interviews yet. Start a new interview to create one.</div>
        )}
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
