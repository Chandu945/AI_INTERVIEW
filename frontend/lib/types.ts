/** The Interviews page (the start page), the New interview form, or an interview. */
export type View = 'home' | 'setup' | 'interview';
export type AnswerMode = 'quick' | 'balanced' | 'detailed';
export type InterviewType = 'Technical' | 'HR' | 'Mixed';
/** What dictation listens to: the microphone, or the sound of a shared browser tab. */
export type VoiceSource = 'mic' | 'tab';
/** A question or answer. A question may come with images (their ids on the backend). */
export type Message = { role: 'user' | 'assistant'; content: string; images?: string[] };

/** An interview as listed by the backend. */
export type Session = {
  id: string;
  title: string;
  resume_name: string | null;
  mode?: AnswerMode;
  target_role?: string;
  interview_type?: string;
  created_at: string;
  updated_at: string;
  /** How many questions it has, and the last one asked (in the list only). */
  questions?: number;
  last_question?: string | null;
};

/** One line of a streamed answer (see /api/chat/stream in backend/main.py). */
export type StreamEvent = {
  /**
   * 'question': a recorded question, as Gemini wrote it down. 'restart': Gemini broke off, and the
   * answer starts again from the beginning.
   */
  type: 'start' | 'question' | 'restart' | 'delta' | 'done' | 'error';
  conversation_id?: string;
  text?: string;
  message?: string;
  first_token_ms?: number | null;
  total_ms?: number;
};

export type StreamMetrics = { first: number | null; total: number };

export const ANSWER_MODES: AnswerMode[] = ['quick', 'balanced', 'detailed'];
export const INTERVIEW_TYPES: InterviewType[] = ['Technical', 'HR', 'Mixed'];

/** "quick" is shown as "Short"; the other lengths are just capitalized. */
export function answerModeLabel(mode: AnswerMode) {
  return mode === 'quick' ? 'Short' : mode[0].toUpperCase() + mode.slice(1);
}
