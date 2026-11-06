import type { AnswerMode, InterviewType, StreamEvent } from './types';

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
    instructions: string;
    job_description: string;
  }) => fetch(`${API}/api/conversations`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(fields) }),
  uploadResume: (id: string, file: File) => {
    const body = new FormData();
    body.append('file', file);
    return fetch(`${API}/api/conversations/${id}/resume`, { method: 'POST', body });
  },
  updateInterview: (id: string, fields: { title?: string; mode?: AnswerMode }) =>
    fetch(`${API}/api/conversations/${id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(fields) }),
  deleteInterview: (id: string) => fetch(`${API}/api/conversations/${id}`, { method: 'DELETE' }),
  transcribe: (id: string, audio: Blob, signal?: AbortSignal) => {
    const body = new FormData();
    body.append('file', audio, 'question.wav');
    return fetch(`${API}/api/conversations/${id}/transcribe`, { method: 'POST', body, signal });
  },
  askQuestion: (body: { message: string; conversation_id: string | null; mode: AnswerMode }, signal: AbortSignal) =>
    fetch(`${API}/api/chat/stream`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body), signal }),
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
