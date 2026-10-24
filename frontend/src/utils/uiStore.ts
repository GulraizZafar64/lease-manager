/* Imperative UI services shared by screens and domain code: toasts, the single
   app modal and the anchored popover. Each is a tiny external store rendered by
   a host component (components/common/*Host.tsx). */
import type { ReactNode } from 'react';

function createStore<T>(initial: T) {
    let state = initial;
    const listeners = new Set<() => void>();
    return {
        get: () => state,
        set(next: T) { state = next; listeners.forEach(l => l()); },
        subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    };
}

/* ---- Toasts ---- */
export interface ToastItem { id: number; msg: string }
export const toastStore = createStore<ToastItem[]>([]);
let toastSeq = 0;
export function toast(msg: string): void {
    const id = ++toastSeq;
    toastStore.set(toastStore.get().concat([{ id, msg }]));
    setTimeout(() => toastStore.set(toastStore.get().filter(t => t.id !== id)), 4200);
}

/* ---- Modal ---- */
export interface ModalState { id: number; title: string; content: ReactNode; wide: boolean; onClose: (() => void) | null }
export const modalStore = createStore<ModalState | null>(null);
let modalSeq = 0;
export const Modal = {
    /** Open the app modal, replacing anything already in it. */
    open(title: string, content: ReactNode, opts: { wide?: boolean; onClose?: () => void } = {}): void {
        modalStore.set({ id: ++modalSeq, title, content, wide: !!opts.wide, onClose: opts.onClose || null });
    },
    close(): void {
        const cur = modalStore.get();
        modalStore.set(null);
        if (cur && cur.onClose) cur.onClose();
    },
    isOpen: (): boolean => modalStore.get() !== null,
};

/* ---- Popover (filter menus, export menus) ---- */
export interface PopoverState { id: number; anchor: HTMLElement; content: ReactNode; left: number; top: number }
export const popoverStore = createStore<PopoverState | null>(null);
let popSeq = 0;
export const popover = {
    open(anchor: HTMLElement, content: ReactNode): void {
        const r = anchor.getBoundingClientRect();
        const left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - 282));
        const top = r.bottom + window.scrollY + 4;
        popoverStore.set({ id: ++popSeq, anchor, content, left, top });
    },
    close(): void { if (popoverStore.get()) popoverStore.set(null); },
};
