import { useRef, useState } from 'react';

type Props = {
  title: string;
  /** Called once, with the new title, or null if it was left as it was or Esc was pressed. */
  onDone: (title: string | null) => void;
};

/** Renames an interview in place: Enter or clicking elsewhere saves, Esc cancels. */
export function TitleEditor({ title, onDone }: Props) {
  const [value, setValue] = useState(title);
  const doneRef = useRef(false);
  const finish = (save: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const next = value.trim();
    onDone(save && next && next !== title ? next : null);
  };
  return (
    <input
      className="title-input"
      aria-label="Interview title"
      value={value}
      maxLength={100}
      autoFocus
      onFocus={event => event.target.select()}
      onChange={event => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={event => {
        if (event.key === 'Enter') finish(true);
        else if (event.key === 'Escape') finish(false);
      }}
    />
  );
}
