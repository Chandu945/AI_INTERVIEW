/** The Interviews page (the start page), the New interview form, or an interview. */
export type View = 'home' | 'setup' | 'interview';
/** The answer length: shown as Short, Medium and Detailed. */
export type AnswerMode = 'quick' | 'balanced' | 'detailed';
/** How answers explain things: from everyday words (simple) to precise technical depth (technical). */
export type AnswerStyle = 'simple' | 'balanced' | 'technical';
export type InterviewType = 'Technical' | 'HR' | 'Mixed';
/** Ways to say the latest answer again, from the buttons under it (see /api/chat/rewrite). */
export type Rewrite = 'shorter' | 'simpler' | 'more_detail';
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
  style?: AnswerStyle;
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
export const ANSWER_STYLES: AnswerStyle[] = ['simple', 'balanced', 'technical'];
export const INTERVIEW_TYPES: InterviewType[] = ['Technical', 'HR', 'Mixed'];
export const REWRITES: Rewrite[] = ['shorter', 'simpler', 'more_detail'];

// The API and the database call them by their first names, "quick", "balanced" and "detailed".
const ANSWER_MODE_LABELS: Record<AnswerMode, string> = { quick: 'Short', balanced: 'Medium', detailed: 'Detailed' };

export function answerModeLabel(mode: AnswerMode) {
  return ANSWER_MODE_LABELS[mode];
}

export function answerStyleLabel(style: AnswerStyle) {
  return style[0].toUpperCase() + style.slice(1);
}
