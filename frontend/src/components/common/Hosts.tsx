import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Modal, modalStore, popover, popoverStore, toastStore } from '../../utils/uiStore';

export function ToastHost() {
    const toasts = useSyncExternalStore(toastStore.subscribe, toastStore.get);
    return (
        <div className="toast-host" id="toast-host" aria-live="polite">
            {toasts.map(t => <div key={t.id} className="toast">{t.msg}</div>)}
        </div>
    );
}

export function ModalHost() {
    const m = useSyncExternalStore(modalStore.subscribe, modalStore.get);
    return (
        <div className={`modal${m ? ' active' : ''}`} id="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"
            onMouseDown={e => { if (e.target === e.currentTarget) Modal.close(); }}>
            <div className={`modal-content${m && m.wide ? ' wide' : ''}`}>
                <div className="modal-header">
                    <h3 id="modal-title">{m ? m.title : ''}</h3>
                    <button className="x-btn" id="modal-close" aria-label="Close" onClick={() => Modal.close()}>&times;</button>
                </div>
                <div className="modal-body" id="modal-body" key={m ? m.id : 0}>{m ? m.content : null}</div>
            </div>
        </div>
    );
}

export function PopoverHost() {
    const p = useSyncExternalStore(popoverStore.subscribe, popoverStore.get);
    const ref = useRef<HTMLDivElement>(null);
    const openId = p ? p.id : 0;
    useLayoutEffect(() => {
        const f = ref.current && ref.current.querySelector<HTMLElement>('input,button');
        if (f) f.focus({ preventScroll: true });
    }, [openId]);
    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            const cur = popoverStore.get(), t = e.target as Node;
            if (cur && ref.current && !ref.current.contains(t) && !cur.anchor.contains(t)) popover.close();
        };
        const onResize = () => popover.close();
        document.addEventListener('mousedown', onDown);
        window.addEventListener('resize', onResize);
        return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('resize', onResize); };
    }, []);
    if (!p) return null;
    return createPortal(
        <div ref={ref} key={p.id} className="popover" role="dialog" style={{ left: p.left + 'px', top: p.top + 'px' }}>{p.content}</div>,
        document.body,
    );
}

/** Escape closes the popover and the modal, as in the original page. */
export function useEscapeToClose(): void {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { popover.close(); if (Modal.isOpen()) Modal.close(); } };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, []);
}
