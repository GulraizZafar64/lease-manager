import { useLayoutEffect } from 'react';

const lastTab = new WeakMap<Element, string>();
const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Fade in a tab's content when the selected tab in any `.tabs` strip changes. */
export function useTabTransitions(version: number): void {
    useLayoutEffect(() => {
        document.querySelectorAll('.screen.active .tabs').forEach(strip => {
            const active = strip.querySelector('.tab.active');
            const id = active ? active.getAttribute('data-t') || active.textContent || '' : '';
            const prev = lastTab.get(strip);
            lastTab.set(strip, id);
            const body = strip.nextElementSibling;
            if (prev === undefined || prev === id || !body || reducedMotion()) return;
            body.animate(
                [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
                { duration: 240, easing: 'cubic-bezier(.2,.7,.2,1)' },
            );
        });
    }, [version]);
}
