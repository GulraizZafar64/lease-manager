import { useEffect, useRef, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> & { onCommit: (el: HTMLInputElement) => void };

/** An uncontrolled input that reports the native `change` event (fired when the
    value is committed: blur or Enter), as the original page's `onchange` handlers did.
    React's onChange fires on every keystroke instead. Give it a `key` to reset it. */
export function CommitInput({ onCommit, ...rest }: Props) {
    const ref = useRef<HTMLInputElement>(null);
    const handler = useRef(onCommit);
    handler.current = onCommit;
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const f = () => handler.current(el);
        el.addEventListener('change', f);
        return () => el.removeEventListener('change', f);
    }, []);
    return <input ref={ref} {...rest} />;
}
