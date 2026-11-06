import { useCallback, useRef, useState } from 'react';

/**
 * The question being typed or dictated. draftRef always holds the latest text, for
 * callbacks (like speech recognition) that outlive a single render.
 */
export function useDraft() {
  const [draft, setDraft] = useState('');
  const draftRef = useRef('');

  const updateDraft = useCallback((value: string) => {
    draftRef.current = value;
    setDraft(value);
  }, []);

  const appendWords = useCallback((words: string) => {
    const text = words.trim();
    if (!text) return;
    const previous = draftRef.current;
    updateDraft(previous + (previous && !/\s$/.test(previous) ? ' ' : '') + text);
  }, [updateDraft]);

  return { draft, draftRef, updateDraft, appendWords };
}
