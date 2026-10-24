/* Where the Users screen's people come from: the backend API (VITE_USE_API=true), where
   passwords, two-step sign-in and lockout are real, or this browser (interface preview). */
import { ApiError, USE_API, api } from '../../api/client';
import { entityIds, recheckIdentity, serverEntities, toUserRecord, type ServerUser } from '../../api/auth';
import { deleteDirectoryUser, directoryUsers, saveDirectoryUser } from '../../domain/directory';
import { entities } from '../../domain/enterprise';
import { notify } from '../../domain/state';
import type { UserRecord } from '../../types/enterprise';

export interface UserSource {
    /** True when people sign in through the server. */
    server: boolean;
    users(): UserRecord[];
    /** Loading state of the list (the browser list is always loaded). */
    status(): { loading: boolean; error: string };
    load(): Promise<void>;
    entityNames(): string[];
    /** Add or change a person; a new person on the server gets a temporary password, returned once. */
    save(before: UserRecord | undefined, after: UserRecord): Promise<{ temporaryPassword?: string }>;
    remove(u: UserRecord): Promise<void>;
    /** Server only: sign-in help for a person. */
    resetPassword(u: UserRecord): Promise<string>;
    resetMfa(u: UserRecord): Promise<void>;
    unlock(u: UserRecord): Promise<void>;
}

/* ---- This browser ---- */
const localOnly = () => Promise.reject(new Error('Available when sign-in runs on the server.'));
const localSource: UserSource = {
    server: false,
    users: directoryUsers,
    status: () => ({ loading: false, error: '' }),
    load: async () => { /* kept in memory */ },
    entityNames: () => entities().map(e => e.name),
    save: async (before, after) => { await saveDirectoryUser(before, after); return {}; },
    remove: deleteDirectoryUser,
    resetPassword: localOnly, resetMfa: localOnly, unlock: localOnly,
};

/* ---- Backend API (lease-manager/src/admin.js) ---- */
let list: UserRecord[] = [];
let state = { loading: true, error: '' };

/** The fields the server takes, changed ones only when editing (some are not allowed on your own account). */
function body(before: UserRecord | undefined, after: UserRecord): Record<string, unknown> {
    const full: Record<string, unknown> = {
        email: (after.email || '').trim(), name: (after.name || '').trim(), title: (after.title || '').trim() || null, role: after.role,
        entityIds: entityIds(after.entities || []), approvalLimit: after.limit === '' || after.limit === undefined ? null : Number(after.limit), extraPerms: after.extraPerms || [],
    };
    if (!before) return full;
    const was = body(undefined, before), out: Record<string, unknown> = {};
    for (const k of Object.keys(full)) if (JSON.stringify(full[k]) !== JSON.stringify(was[k])) out[k] = full[k];
    if (after.status !== before.status) out.status = after.status;
    return out;
}
async function reload(): Promise<void> {
    try {
        list = (await api.get<ServerUser[]>('/users')).map(toUserRecord);
        state = { loading: false, error: '' };
    } catch (e) {
        state = { loading: false, error: e instanceof ApiError ? e.message : 'Could not load users.' };
    }
    notify();
}
/** After a change: the list again, and the signed-in person's own details (name, limit, entities). */
const changed = async (): Promise<void> => { await Promise.all([reload(), recheckIdentity()]); };

const apiSource: UserSource = {
    server: true,
    users: () => list,
    status: () => state,
    load: reload,
    entityNames: () => serverEntities().map(e => e.name),
    async save(before, after) {
        if (!before) {
            const r = await api.post<{ user: ServerUser; temporaryPassword: string }>('/users', body(undefined, after));
            await changed();
            return { temporaryPassword: r.temporaryPassword };
        }
        const b = body(before, after);
        if (Object.keys(b).length) await api.patch<ServerUser>(`/users/${before.id}`, b);
        await changed();
        return {};
    },
    async remove(u) { await api.del(`/users/${u.id}`); await changed(); },
    async resetPassword(u) { const r = await api.post<{ temporaryPassword: string }>(`/users/${u.id}/reset-password`); await reload(); return r.temporaryPassword; },
    async resetMfa(u) { await api.post(`/users/${u.id}/reset-mfa`); await reload(); },
    async unlock(u) { await api.post(`/users/${u.id}/unlock`); await reload(); },
};

export const userSource = (): UserSource => USE_API ? apiSource : localSource;
