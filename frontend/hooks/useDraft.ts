import { useCallback, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

/**
 * The question being typed or dictated. draftRef always holds the latest text, for
 * callbacks (like speech recognition) that outlive a single render.
 */
export function useDraft() {
  const [draft, setDraft] = useState('');
  const draftRef = useRef('');

  // Shown at once (flushSync), so the text box never lags behind draftRef. Otherwise a key
  // pressed just after dictation added words would be applied to the old text, and those words
  // would be lost.
  const updateDraft = useCallback((value: string) => {
    draftRef.current = value;
    flushSync(() => setDraft(value));
  }, []);

  const appendWords = useCallback(
    (words: string) => {
      const text = words.trim();
      if (!text) return;
      const previous = draftRef.current;
      updateDraft(previous + (previous && !/\s$/.test(previous) ? ' ' : '') + text);
    },
    [updateDraft],
  );

  return { draft, draftRef, updateDraft, appendWords };
}
