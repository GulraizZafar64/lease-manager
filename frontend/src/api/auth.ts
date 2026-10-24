/* Company sign-in against the backend API (VITE_USE_API=true): who is signed in, to which
   company, and what they may do, as the server reports it (GET /api/auth/me). The server's
   session is an HttpOnly cookie; the browser session record (domain/session.ts) mirrors it
   so per-company data keys work as before. Leases and other data stay in this browser. */
import { api } from './client';
import { notify } from '../domain/state';
import type { Permission, RoleKey, UserRecord } from '../types/enterprise';

export interface ServerCompany { id: string; code: string; name: string; status: 'active' | 'inactive'; currency: string }
export interface ServerUser {
    id: string; companyId: string; email: string; name: string; title: string | null; role: RoleKey; status: 'active' | 'disabled'; extraPerms: Permission[];
    mfaEnabled: boolean; mustChangePassword: boolean; approvalLimit: string | number | null; entityIds: string[];
    lockedUntil: string | null; lastLoginAt: string | null; createdAt: string;
}
/** A role as the company saved it on the server (built-in, possibly changed, or custom). */
export interface ServerRole {
    id: RoleKey; label: string; description: string; perms: Permission[]; custom: boolean; changed: boolean;
    updatedAt: string | null; updatedBy: string | null; users: number;
}
/** A company entity on the server (the browser's entities use its name). */
export interface ServerEntity { id: string; code: string; name: string; functional_currency: string; parent_id: string | null; country: string | null }
export interface Me { user: ServerUser; company: ServerCompany; mfaPassed: boolean; permissions: Permission[] }
/** Another company where the same email has an active account. */
export interface OtherCompany { id: string; code: string; name: string; role: RoleKey }
/** A company offered at sign-in when one password opens several. */
export interface CompanyChoice { id: string; code: string; name: string }

let me: Me | null = null;
let others: OtherCompany[] = [];
let ents: ServerEntity[] = [];
let roles: ServerRole[] = [];

/** The signed-in person as the server reports it, once loaded. */
export const serverMe = (): Me | null => me;
export const otherServerCompanies = (): OtherCompany[] => others;
/** The company's roles, once loaded (empty when not signed in through the API). */
export const serverRoles = (): ServerRole[] => roles;
/** Read the roles again after a change, so names and permissions show everywhere. */
export async function reloadRoles(): Promise<void> {
    roles = await api.get<ServerRole[]>('/roles');
    notify();
}
/** The company's entities the signed-in user may see. */
export const serverEntities = (): ServerEntity[] => ents;
/** After entities change (Administration › Entities). */
export const setServerEntities = (list: ServerEntity[]): void => { ents = list; };
export const entityNames = (ids: string[]): string[] => ids.map(id => ents.find(e => e.id === id)?.name).filter((n): n is string => !!n);
export const entityIds = (names: string[]): string[] => names.map(n => ents.find(e => e.name === n)?.id).filter((i): i is string => !!i);

/** A server user in the shape the rest of the app uses. */
export function toUserRecord(u: ServerUser): UserRecord {
    const limit = Number(u.approvalLimit);
    return {
        id: u.id, name: u.name, email: u.email, title: u.title || '', role: u.role, status: u.status, entities: entityNames(u.entityIds), limit: limit > 0 ? limit : '',
        extraPerms: u.extraPerms, addedAt: u.createdAt, lastLoginAt: u.lastLoginAt || undefined, mfaEnabled: u.mfaEnabled, mustChangePassword: u.mustChangePassword, lockedUntil: u.lockedUntil,
    };
}
/** Signed in all the way: code entered and no password change pending. */
export const fullySignedIn = (m: Me): boolean => m.mfaPassed && !m.user.mustChangePassword;

/** The signed-in user in the shape the rest of the app uses. */
export const serverUserRecord = (): UserRecord | undefined => me ? toUserRecord(me.user) : undefined;

/** Ask the server who is signed in. quiet: a 401 does not end the app's session (start-up and the login page check it themselves). */
export const fetchMe = (quiet = true): Promise<Me> => api.get<Me>('/auth/me', { quiet401: quiet });

/** Load the signed-in person and their other companies. */
export async function loadIdentity(): Promise<Me> {
    me = await fetchMe();
    if (fullySignedIn(me)) [others, ents, roles] = await Promise.all([
        api.get<OtherCompany[]>('/auth/companies', { quiet401: true }).catch(() => []),
        api.get<ServerEntity[]>('/entities', { quiet401: true }).catch(() => []),
        api.get<ServerRole[]>('/roles', { quiet401: true }).catch(() => []),
    ]);
    return me;
}

/** Re-check the session. A session that has ended is reported through onSessionEnded;
    a changed role or permissions take effect straight away. */
export async function recheckIdentity(): Promise<void> {
    let next: Me;
    try { next = await fetchMe(false); } catch { return; }
    const sig = (m: Me | null) => m ? [m.user.name, m.user.title, m.user.role, m.user.status, m.user.approvalLimit, m.user.entityIds.join(), m.permissions.join()].join('|') : '';
    const changed = sig(next) !== sig(me);
    me = next;
    // Someone may have changed a role: names and permissions shown for other roles too
    if (changed) await reloadRoles().catch(() => notify());
}

export async function serverLogout(): Promise<void> {
    try { await api.post('/auth/logout'); } catch { /* the session is gone either way */ }
    me = null; others = []; ents = []; roles = [];
}

/** While the app is open: re-check the session each minute while the person is active, and on
    returning to the tab. Idle tabs do not keep the session alive, so the server's idle timeout holds. */
export function watchSession(): () => void {
    let active = false;
    const touch = () => { active = true; };
    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'] as const;
    events.forEach(e => document.addEventListener(e, touch, { passive: true }));
    const timer = setInterval(() => { if (active && document.visibilityState === 'visible') { active = false; void recheckIdentity(); } }, 60000);
    const onVisible = () => { if (document.visibilityState === 'visible') void recheckIdentity(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { events.forEach(e => document.removeEventListener(e, touch)); clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
}

/* ---- Switch company: sign in again to the other company (each account has its own password and code) ---- */
const SWITCH_KEY = 'ifrs16.switchTo';
export interface SwitchTarget { email: string; companyId: string; companyName: string }
export function setSwitchTarget(t: SwitchTarget | null): void {
    try { if (t) sessionStorage.setItem(SWITCH_KEY, JSON.stringify(t)); else sessionStorage.removeItem(SWITCH_KEY); } catch { /* storage unavailable */ }
}
export function switchTarget(): SwitchTarget | null {
    try { const raw = sessionStorage.getItem(SWITCH_KEY); return raw ? JSON.parse(raw) as SwitchTarget : null; } catch { return null; }
}
