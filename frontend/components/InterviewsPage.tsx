import { useEffect, useState } from 'react';
import { DATE_GROUPS, dateGroup, friendlyTime } from '../lib/dates';
import { INTERVIEW_TYPES, type InterviewType, type Session } from '../lib/types';
import { ConfirmDialog } from './ConfirmDialog';
import { TitleEditor } from './TitleEditor';

export type TypeFilter = 'All' | InterviewType;

type Props = {
  sessions: Session[];
  /** Whether the list has loaded, so "no interviews yet" isn't shown while it loads. */
  loaded: boolean;
  search: string;
  onSearchChange: (search: string) => void;
  filter: TypeFilter;
  onFilterChange: (filter: TypeFilter) => void;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onCopy: (id: string) => void;
  onDelete: (id: string) => void;
  onNewInterview: () => void;
  error: string;
};

const typeOf = (session: Session) => (session.interview_type || 'Technical') as InterviewType;

/** The start page: every interview, latest first and grouped by day, to open, rename, repeat or delete. */
export function InterviewsPage({
  sessions,
  loaded,
  search,
  onSearchChange,
  filter,
  onFilterChange,
  onOpen,
  onRename,
  onCopy,
  onDelete,
  onNewInterview,
  error,
}: Props) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // The one to delete, if asked. It stays set while its dialog closes, so the dialog keeps its name.
  const [deleting, setDeleting] = useState<Session | null>(null);
  const [confirming, setConfirming] = useState(false);

  // An open menu closes on a click elsewhere or Esc.
  useEffect(() => {
    if (!menuFor) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !(event.target as Element).closest?.('.row-menu'))
        setMenuFor(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menuFor]);

  const query = search.trim().toLowerCase();
  const shown = sessions.filter(
    session =>
      (filter === 'All' || typeOf(session) === filter) &&
      [session.title, session.target_role, session.interview_type, session.last_question]
        .join(' ')
        .toLowerCase()
        .includes(query),
  );
  const now = new Date();
  const groups = DATE_GROUPS.map(name => ({
    name,
    items: shown.filter(session => dateGroup(session.updated_at, now) === name),
  })).filter(group => group.items.length);
  const count = (type: TypeFilter) => sessions.filter(session => type === 'All' || typeOf(session) === type).length;

  const act = (action: () => void) => {
    setMenuFor(null);
    action();
  };

  return (
    <section className="home-page">
      <div className="page-head">
        <div>
          <h2>Interviews</h2>
          <p>Your practice interviews, saved on this computer.</p>
        </div>
        <button type="button" className="btn primary" onClick={onNewInterview}>
          + New interview
        </button>
      </div>

      {sessions.length > 0 && (
        <div className="home-toolbar">
          <input
            type="search"
            className="search-input"
            value={search}
            onChange={event => onSearchChange(event.target.value)}
            placeholder="Search titles, roles and questions…"
            aria-label="Search interviews"
          />
          <div className="filter-chips" role="group" aria-label="Interview type">
            {(['All', ...INTERVIEW_TYPES] as TypeFilter[]).map(type => (
              <button
                type="button"
                key={type}
                className={`chip ${filter === type ? 'selected' : ''}`}
                aria-pressed={filter === type}
                onClick={() => onFilterChange(type)}
              >
                {type} <span className="chip-count">{count(type)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      {groups.map(group => (
        <section key={group.name} className="interview-group" aria-label={group.name}>
          <h3>{group.name}</h3>
          <ul className="interview-list">
            {group.items.map(session => {
              const questions = session.questions ?? 0;
              return (
                <li key={session.id} className="interview-row">
                  {renaming === session.id ? (
                    <div className="interview-open editing">
                      <TitleEditor
                        title={session.title}
                        onDone={title => {
                          setRenaming(null);
                          if (title) onRename(session.id, title);
                        }}
                      />
                    </div>
                  ) : (
                    <button type="button" className="interview-open" onClick={() => onOpen(session.id)}>
                      <span className="interview-title">{session.title}</span>
                      <span className="interview-time">{friendlyTime(session.updated_at, now)}</span>
                      <span className="interview-meta">
                        {session.target_role || 'Interview'}
                        <span className={`type-pill type-${typeOf(session).toLowerCase()}`}>{typeOf(session)}</span>
                        <span>
                          {questions ? `${questions} question${questions === 1 ? '' : 's'}` : 'No questions yet'}
                        </span>
                        {session.resume_name && (
                          <span className="resume-tag">
                            <span aria-hidden="true">📄</span> {session.resume_name}
                          </span>
                        )}
                      </span>
                      {session.last_question && (
                        <span className="interview-last">Last question: {session.last_question}</span>
                      )}
                    </button>
                  )}
                  <div className="row-menu">
                    <button
                      type="button"
                      className="menu-button"
                      aria-label={`More actions for ${session.title}`}
                      aria-haspopup="menu"
                      aria-expanded={menuFor === session.id}
                      onClick={() => setMenuFor(menuFor === session.id ? null : session.id)}
                    >
                      ⋯
                    </button>
                    {menuFor === session.id && (
                      <div className="menu" role="menu">
                        <button type="button" role="menuitem" onClick={() => act(() => onOpen(session.id))}>
                          Open
                        </button>
                        <button type="button" role="menuitem" onClick={() => act(() => setRenaming(session.id))}>
                          Rename
                        </button>
                        <button type="button" role="menuitem" onClick={() => act(() => onCopy(session.id))}>
                          Start new with same setup
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="danger"
                          onClick={() =>
                            act(() => {
                              setDeleting(session);
                              setConfirming(true);
                            })
                          }
                        >
                          Delete…
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {loaded && sessions.length === 0 && (
        <div className="empty-card">
          <span className="empty-mark" aria-hidden="true">
            ✦
          </span>
          <h3>No interviews yet</h3>
          <p>Set up a practice interview: choose the role, add your resume if you like, and start asking questions.</p>
          <button type="button" className="btn primary" onClick={onNewInterview}>
            + New interview
          </button>
        </div>
      )}
      {sessions.length > 0 && shown.length === 0 && (
        <div className="empty-card compact">
          <p>No interviews match your search.</p>
          <button
            type="button"
            className="btn subtle"
            onClick={() => {
              onSearchChange('');
              onFilterChange('All');
            }}
          >
            Show all interviews
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        title="Delete this interview?"
        confirmLabel="Delete"
        danger
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          if (deleting) onDelete(deleting.id);
        }}
      >
        “{deleting?.title}” and its questions, answers and resume will be deleted. This can’t be undone.
      </ConfirmDialog>
    </section>
  );
}
