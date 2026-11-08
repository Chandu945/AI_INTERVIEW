import type { AnswerMode, AnswerStyle, InterviewType, StreamEvent } from './types';

export const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
// Must match ChatRequest.message max_length in backend/main.py.
export const MAX_QUESTION_CHARS = 10000;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Every backend call, so the URLs live in one place. Each returns the raw Response. */
export const api = {
  listInterviews: () => fetch(`${API}/api/conversations`),
  getInterview: (id: string) => fetch(`${API}/api/conversations/${id}`),
  createInterview: (fields: {
    target_role: string;
    interview_type: InterviewType;
    mode: AnswerMode;
    style: AnswerStyle;
    instructions: string;
    job_description: string;
  }) => fetch(`${API}/api/conversations`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(fields) }),
  uploadResume: (id: string, file: File) => {
    const body = new FormData();
    body.append('file', file);
    return fetch(`${API}/api/conversations/${id}/resume`, { method: 'POST', body });
  },
  updateInterview: (id: string, fields: { title?: string; mode?: AnswerMode; style?: AnswerStyle }) =>
    fetch(`${API}/api/conversations/${id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(fields) }),
  deleteInterview: (id: string) => fetch(`${API}/api/conversations/${id}`, { method: 'DELETE' }),
  /** Starts a new interview with the same setup as this one (role, type, resume, and so on). */
  copyInterview: (id: string) => fetch(`${API}/api/conversations/${id}/copy`, { method: 'POST' }),
  /** Keeps an image to ask a question with. Resolves to its id, in `image_id`. */
  uploadImage: (id: string, image: Blob, name: string) => {
    const body = new FormData();
    body.append('file', image, name);
    return fetch(`${API}/api/conversations/${id}/images`, { method: 'POST', body });
  },
  /** Removes an image that was taken off a question before it was sent. */
  deleteImage: (imageId: string) => fetch(`${API}/api/images/${imageId}`, { method: 'DELETE' }),
  imageUrl: (imageId: string) => `${API}/api/images/${imageId}`,
  /** `context`: the end of the text so far, which the recording continues. */
  transcribe: (id: string, audio: Blob, signal?: AbortSignal, context = '') => {
    const body = new FormData();
    body.append('file', audio, 'question.wav');
    if (context) body.append('context', context);
    return fetch(`${API}/api/conversations/${id}/transcribe`, { method: 'POST', body, signal });
  },
  askQuestion: (
    body: {
      message: string;
      conversation_id: string | null;
      mode: AnswerMode;
      style: AnswerStyle;
      image_ids: string[];
    },
    signal: AbortSignal,
  ) => fetch(`${API}/api/chat/stream`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body), signal }),
  /** Asks a question by its recording (with its live words): Gemini writes it down and answers it. */
  askRecordedQuestion: (
    fields: {
      audio: Blob;
      heard: string;
      conversation_id: string;
      mode: AnswerMode;
      style: AnswerStyle;
      image_ids: string[];
    },
    signal: AbortSignal,
  ) => {
    const body = new FormData();
    body.append('file', fields.audio, 'question.wav');
    body.append('heard', fields.heard);
    body.append('conversation_id', fields.conversation_id);
    body.append('mode', fields.mode);
    body.append('style', fields.style);
    body.append('image_ids', fields.image_ids.join(','));
    return fetch(`${API}/api/chat/stream-recording`, { method: 'POST', body, signal });
  },
};

/**
 * FastAPI sends `detail` as a string for the app's own errors, but as a list of
 * { msg } objects when request validation fails.
 */
export function errorMessage(data: unknown, fallback: string): string {
  const detail = (data as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map(item => item?.msg).filter((msg): msg is string => typeof msg === 'string');
    if (messages.length) return messages.join('; ');
  }
  return fallback;
}

/** Reads a streamed answer (one JSON event per line) and calls onEvent for each event. */
export async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: StreamEvent) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const processLine = (line: string) => {
    if (line.trim()) onEvent(JSON.parse(line) as StreamEvent);
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) processLine(line);
  }
  buffer += decoder.decode();
  if (buffer.trim()) processLine(buffer);
}
