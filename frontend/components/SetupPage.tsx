import { useEffect, useRef, useState } from 'react';
import {
  ANSWER_MODES,
  ANSWER_STYLES,
  INTERVIEW_TYPES,
  answerModeLabel,
  answerStyleLabel,
  type AnswerMode,
  type AnswerStyle,
  type InterviewType,
} from '../lib/types';

export type NewInterview = {
  targetRole: string;
  interviewType: InterviewType;
  answerMode: AnswerMode;
  answerStyle: AnswerStyle;
  instructions: string;
  jobDescription: string;
  resume: File | null;
};

type Props = {
  starting: boolean;
  /** Why the interview couldn't start (say, the resume couldn't be read). */
  error: string;
  onStart: (form: NewInterview) => void;
  onCancel: () => void;
};

const MAX_RESUME_BYTES = 5 * 1024 * 1024;
const MAX_JOB_DESCRIPTION = 12_000;
const MAX_INSTRUCTIONS = 2_000;
// The role, type, answer length and style of the last interview set up in this browser, to start from.
const LAST_SETUP_KEY = 'ai-interact.last-setup';

const TYPE_TEXT: Record<InterviewType, string> = {
  Technical: 'Concepts, tools and system design',
  HR: 'Behavioral questions, answered from your resume',
  Mixed: 'Technical and behavioral questions',
};
// How long each answer takes to say (see MODE_GUIDANCE in backend/main.py).
const LENGTH_TEXT: Record<AnswerMode, string> = {
  quick: 'A few sentences, about 15–30 seconds to say',
  balanced: 'A short paragraph, about 30–60 seconds',
  detailed: 'With an example and tradeoffs, about a minute or more',
};

const STYLE_TEXT: Record<AnswerStyle, string> = {
  simple: 'Everyday words and short sentences, the way you would explain it to a person',
  technical: 'Precise technical terms and more depth, for senior or deep technical interviews',
};

type LastSetup = { targetRole: string; interviewType: InterviewType; answerMode: AnswerMode; answerStyle: AnswerStyle };

function lastSetup(): LastSetup {
  const setup: LastSetup = {
    targetRole: 'GenAI Developer',
    interviewType: 'Technical',
    answerMode: 'balanced',
    answerStyle: 'simple',
  };
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_SETUP_KEY) || '{}') as Partial<LastSetup>;
    if (typeof saved.targetRole === 'string' && saved.targetRole.trim()) setup.targetRole = saved.targetRole;
    if (INTERVIEW_TYPES.includes(saved.interviewType as InterviewType)) setup.interviewType = saved.interviewType!;
    if (ANSWER_MODES.includes(saved.answerMode as AnswerMode)) setup.answerMode = saved.answerMode!;
    if (ANSWER_STYLES.includes(saved.answerStyle as AnswerStyle)) setup.answerStyle = saved.answerStyle!;
  } catch {
    /* nothing saved, or storage is blocked */
  }
  return setup;
}

function remember(setup: LastSetup) {
  try {
    localStorage.setItem(LAST_SETUP_KEY, JSON.stringify(setup));
  } catch {
    /* storage is blocked: the defaults are used next time */
  }
}

const fileSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The New interview form. It keeps its own fields; the page remounts it to start afresh. */
export function SetupPage({ starting, error, onStart, onCancel }: Props) {
  const [initial] = useState(lastSetup);
  const [targetRole, setTargetRole] = useState(initial.targetRole);
  const [interviewType, setInterviewType] = useState<InterviewType>(initial.interviewType);
  const [answerMode, setAnswerMode] = useState<AnswerMode>(initial.answerMode);
  const [answerStyle, setAnswerStyle] = useState<AnswerStyle>(initial.answerStyle);
  const [instructions, setInstructions] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  const [resume, setResume] = useState<File | null>(null);
  const [resumeError, setResumeError] = useState('');
  const [dragging, setDragging] = useState(false);
  const resumeInputRef = useRef<HTMLInputElement | null>(null);

  // The file picker isn't controlled by React, so empty it whenever the attached resume is removed.
  useEffect(() => {
    if (!resume && resumeInputRef.current) resumeInputRef.current.value = '';
  }, [resume]);

  const pickResume = (file: File | null) => {
    setResumeError('');
    if (!file) return;
    if (!/\.(pdf|docx)$/i.test(file.name)) {
      setResumeError('Use a PDF or Word (.docx) file.');
    } else if (file.size > MAX_RESUME_BYTES) {
      setResumeError(`That file is ${fileSize(file.size)}. The limit is 5 MB.`);
    } else {
      setResume(file);
      return;
    }
    if (resumeInputRef.current) resumeInputRef.current.value = '';
  };

  const start = () => {
    const role = targetRole.trim();
    if (!role || starting) return;
    remember({ targetRole: role, interviewType, answerMode, answerStyle });
    onStart({ targetRole: role, interviewType, answerMode, answerStyle, instructions, jobDescription, resume });
  };

  const jobWords = jobDescription.trim() ? jobDescription.trim().split(/\s+/).length : 0;

  return (
    <section className="setup-page">
      <button type="button" className="back-link" onClick={onCancel}>
        <span aria-hidden="true">←</span> Interviews
      </button>
      <div className="page-head">
        <div>
          <h2>New interview</h2>
          <p>Tell Gemini about the role, so its answers fit it. Only the role is needed.</p>
        </div>
      </div>

      <div className="setup-layout">
        <div className="setup-form">
          <section className="setup-section">
            <label className="field-label" htmlFor="setup-role">
              Role
            </label>
            <input
              id="setup-role"
              className="text-field"
              value={targetRole}
              maxLength={100}
              onChange={event => setTargetRole(event.target.value)}
              placeholder="e.g. Senior Backend Engineer"
            />
          </section>

          <fieldset className="setup-section">
            <legend className="field-label">Interview type</legend>
            <div className="option-grid">
              {INTERVIEW_TYPES.map(type => (
                <label key={type} className={`option-card ${interviewType === type ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="interview-type"
                    checked={interviewType === type}
                    onChange={() => setInterviewType(type)}
                  />
                  <span className="option-title">{type}</span>
                  <span className="option-text">{TYPE_TEXT[type]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="setup-section">
            <legend className="field-label">Answer length</legend>
            <div className="option-grid">
              {ANSWER_MODES.map(mode => (
                <label key={mode} className={`option-card ${answerMode === mode ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="answer-length"
                    checked={answerMode === mode}
                    onChange={() => setAnswerMode(mode)}
                  />
                  <span className="option-title">{answerModeLabel(mode)}</span>
                  <span className="option-text">{LENGTH_TEXT[mode]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="setup-section">
            <legend className="field-label">Answer style</legend>
            <div className="option-grid">
              {ANSWER_STYLES.map(style => (
                <label key={style} className={`option-card ${answerStyle === style ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="answer-style"
                    checked={answerStyle === style}
                    onChange={() => setAnswerStyle(style)}
                  />
                  <span className="option-title">{answerStyleLabel(style)}</span>
                  <span className="option-text">{STYLE_TEXT[style]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <section className="setup-section">
            <h3 className="field-label">
              Your background <span className="optional">Optional</span>
            </h3>
            <p className="field-note">Answers draw on these, and never make up experience you don’t have.</p>
            <div
              className={`dropzone ${dragging ? 'dragging' : ''} ${resume ? 'filled' : ''}`}
              onDragOver={event => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={event => {
                event.preventDefault();
                setDragging(false);
                pickResume(event.dataTransfer.files[0] ?? null);
              }}
            >
              <input
                ref={resumeInputRef}
                id="setup-resume"
                className="visually-hidden"
                type="file"
                accept=".pdf,.docx"
                onChange={event => pickResume(event.target.files?.[0] ?? null)}
              />
              {resume ? (
                <div className="file-chip">
                  <span className="file-icon" aria-hidden="true">
                    📄
                  </span>
                  <span className="file-name">{resume.name}</span>
                  <span className="file-size">{fileSize(resume.size)}</span>
                  <button type="button" className="text-button" onClick={() => setResume(null)}>
                    Remove
                  </button>
                </div>
              ) : (
                <label htmlFor="setup-resume" className="dropzone-label">
                  <span>
                    <strong>Drop your resume here</strong> or <span className="link-text">browse</span>
                  </span>
                  <small>PDF or Word (.docx), up to 5 MB</small>
                </label>
              )}
            </div>
            {resumeError && (
              <p className="field-error" role="alert">
                {resumeError}
              </p>
            )}
            <label className="field-label sub" htmlFor="setup-job">
              Job description
            </label>
            <textarea
              id="setup-job"
              className="text-field"
              rows={5}
              maxLength={MAX_JOB_DESCRIPTION}
              value={jobDescription}
              onChange={event => setJobDescription(event.target.value)}
              placeholder="Paste the job description, so answers focus on what the role needs."
            />
            <span className="field-count">
              {jobDescription.length.toLocaleString()} / {MAX_JOB_DESCRIPTION.toLocaleString()}
            </span>
          </section>

          <details className="setup-section setup-more">
            <summary>
              Extra instructions <span className="optional">Optional</span>
            </summary>
            <textarea
              className="text-field"
              aria-label="Extra instructions"
              rows={3}
              maxLength={MAX_INSTRUCTIONS}
              value={instructions}
              onChange={event => setInstructions(event.target.value)}
              placeholder="e.g. Focus on my recent projects and keep answers conversational."
            />
          </details>
        </div>

        <aside className="setup-summary" aria-label="Summary">
          <h3>Summary</h3>
          <dl>
            <div>
              <dt>Role</dt>
              <dd>{targetRole.trim() || '—'}</dd>
            </div>
            <div>
              <dt>Interview type</dt>
              <dd>{interviewType}</dd>
            </div>
            <div>
              <dt>Answer length</dt>
              <dd>{answerModeLabel(answerMode)}</dd>
            </div>
            <div>
              <dt>Answer style</dt>
              <dd>{answerStyleLabel(answerStyle)}</dd>
            </div>
            <div>
              <dt>Resume</dt>
              <dd>{resume ? resume.name : 'None'}</dd>
            </div>
            <div>
              <dt>Job description</dt>
              <dd>{jobWords ? `${jobWords.toLocaleString()} words` : 'None'}</dd>
            </div>
          </dl>
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          <button
            type="button"
            className="btn primary start-button"
            onClick={start}
            disabled={starting || !targetRole.trim()}
          >
            {starting ? 'Preparing interview…' : 'Start interview →'}
          </button>
          <p className="summary-note">You can change the answer length and style during the interview too.</p>
        </aside>
      </div>
    </section>
  );
}
