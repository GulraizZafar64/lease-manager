/* Sign-in session record kept in this browser: which company and user, so each company's
   data has its own storage keys. With the API (VITE_USE_API=true) the server's HttpOnly
   cookie is the real session and this record mirrors it (api/auth.ts, pages/ApiLoginPage.tsx).
   Without it, sign-in matches the email to an active user in Users and passwords are not checked. */
import { notify } from './state';

export interface Session { companyId: string; userId: string; name: string; email: string; signedInAt: string; /** Sign-in recorded in the company's audit log and user list. */ recorded?: boolean }

const KEY = 'ifrs16.session';
let memory: Session | null = null;

function read(storage: () => Storage): Session | null {
    try { const raw = storage().getItem(KEY); const s = raw ? JSON.parse(raw) as Session : null; return s && s.userId && s.companyId ? s : null; } catch { return null; }
}

/** The current session; sessions from before companies and user accounts existed do not count. */
export function getSession(): Session | null {
    return memory || read(() => sessionStorage) || read(() => localStorage);
}

function store(s: Session, remember: boolean): void {
    memory = s;
    try { (remember ? localStorage : sessionStorage).setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable: keep it in memory */ }
}

export function signIn(companyId: string, user: { id: string; name?: string; email?: string }, remember: boolean): Session {
    const s: Session = { companyId, userId: user.id, name: user.name || '', email: user.email || '', signedInAt: new Date().toISOString() };
    store(s, remember);
    notify();
    return s;
}

/** Whether the current session was kept with "Keep me signed in". */
export function sessionRemembered(): boolean { try { return !!localStorage.getItem(KEY); } catch { return false; } }

/** Note that this sign-in has been recorded, so a reload does not record it again. */
export function markSessionRecorded(): void {
    const s = getSession(); if (!s || s.recorded) return;
    store({ ...s, recorded: true }, sessionRemembered());
}

export function signOut(): void {
    memory = null;
    try { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
    notify();
}

const base = (): string => import.meta.env.BASE_URL.replace(/\/$/, '');
export const LOGIN_PATH = (): string => base() + '/login';

/** Show /login in the address bar, remembering the page that was asked for. */
export function toLoginUrl(rememberPage = true): void {
    const here = window.location.pathname + window.location.search;
    if (window.location.pathname === LOGIN_PATH()) return;
    const next = rememberPage && window.location.pathname !== base() + '/' ? '?next=' + encodeURIComponent(here) : '';
    window.history.replaceState(null, '', LOGIN_PATH() + next);
}

/** The page to open after signing in: the one that was asked for, else the overview. */
export function afterLoginUrl(): string {
    const n = new URLSearchParams(window.location.search).get('next');
    return n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith(LOGIN_PATH()) ? n : base() + '/';
}
