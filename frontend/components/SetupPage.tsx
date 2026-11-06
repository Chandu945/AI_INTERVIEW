import { useEffect, useRef, useState } from 'react';
import { ANSWER_MODES, INTERVIEW_TYPES, answerModeLabel, type AnswerMode, type InterviewType } from '../lib/types';

export type NewInterview = {
  targetRole: string;
  interviewType: InterviewType;
  instructions: string;
  jobDescription: string;
  resume: File | null;
};

type Props = {
  answerMode: AnswerMode;
  onAnswerModeChange: (mode: AnswerMode) => void;
  starting: boolean;
  error: string;
  setError: (message: string) => void;
  onStart: (form: NewInterview) => void;
};

const MAX_RESUME_BYTES = 5 * 1024 * 1024;

/** The New Interview form. It keeps its own fields; the page remounts it to start fresh. */
export function SetupPage({ answerMode, onAnswerModeChange, starting, error, setError, onStart }: Props) {
  const [targetRole, setTargetRole] = useState('GenAI Developer');
  const [interviewType, setInterviewType] = useState<InterviewType>('Technical');
  const [instructions, setInstructions] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  const [resume, setResume] = useState<File | null>(null);
  const resumeInputRef = useRef<HTMLInputElement | null>(null);

  // The file picker isn't controlled by React, so empty it whenever the attached resume is removed.
  useEffect(() => { if (!resume && resumeInputRef.current) resumeInputRef.current.value = ''; }, [resume]);

  return (
    <section className="setup-page"><div className="setup-card">
      <span className="eyebrow">START A NEW SESSION</span><h2>New Interview</h2><p className="setup-subtitle">Set up your interview before entering the focused workspace. A resume is optional and belongs only to this session.</p>
      <label className="setup-field">Target role<input value={targetRole} maxLength={100} onChange={e => setTargetRole(e.target.value)} placeholder="e.g. GenAI Developer" /></label>
      <fieldset className="setup-field">
        <legend>Interview type</legend>
        <div className="setup-choice-row">
          {INTERVIEW_TYPES.map(t => <button type="button" key={t} className={`choice ${interviewType === t ? 'selected' : ''}`} onClick={() => setInterviewType(t)}>{t}</button>)}
        </div>
      </fieldset>
      <div className="setup-field">
        <label htmlFor="setup-resume">Candidate resume <span className="optional">Optional · PDF or DOCX · up to 5 MB</span></label>
        <input
          ref={resumeInputRef} id="setup-resume" type="file" accept=".pdf,.docx"
          onChange={e => {
            const file = e.target.files?.[0] || null;
            if (file && file.size > MAX_RESUME_BYTES) { setError('Resume must be 5 MB or smaller'); e.target.value = ''; return; }
            setResume(file);
            setError('');
          }}
        />
        {resume && <span className="attached-file">📄 {resume.name} <button type="button" onClick={() => setResume(null)}>Remove</button></span>}
      </div>
      <div className="setup-field">
        <label>Answer mode</label>
        <div className="setup-choice-row">
          {ANSWER_MODES.map(m => <button type="button" key={m} className={`choice ${answerMode === m ? 'selected' : ''}`} onClick={() => onAnswerModeChange(m)}>{answerModeLabel(m)}</button>)}
        </div>
      </div>
      <label className="setup-field">Job description <span className="optional">Optional · paste the role requirements</span><textarea rows={4} maxLength={12000} value={jobDescription} onChange={e => setJobDescription(e.target.value)} placeholder="Paste a job description to tailor technical topics without inventing experience." /></label>
      <label className="setup-field">Additional instructions <span className="optional">Optional</span><textarea rows={3} maxLength={2000} value={instructions} onChange={e => setInstructions(e.target.value)} placeholder="e.g. Focus on my recent projects and keep answers conversational." /></label>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <button className="btn primary start-interview" onClick={() => onStart({ targetRole, interviewType, instructions, jobDescription, resume })} disabled={starting || !targetRole.trim()}>
        {starting ? 'Preparing interview…' : 'Start Interview →'}
      </button>
    </div></section>
  );
}
