/* Users of the signed-in company, kept in this browser (no server yet), and the
   administration rules the server applies (lease-manager/src/admin.js). */
import { Ent, audit, realRole, roleLabel } from './enterprise';
import { Store } from './store';
import type { UserRecord } from '../types/enterprise';

/** Users managed in this app: those with an email address. */
export const directoryUsers = (): UserRecord[] => Ent.users.items.filter(u => !!u.email);
export const userName = (u: UserRecord): string => u.name || u.label || u.email || 'Unnamed user';

/** Why the signed-in user may not make this change, or '' if they may (mirrors the server's rules).
    users: the company's people (this browser's, or the server's list). */
export function userChangeProblem(before: UserRecord | undefined, after: UserRecord | null, users: UserRecord[] = directoryUsers()): string {
    const me = Store.actorId(), mine = realRole();
    const touchesSuper = (before && before.role === 'superadmin') || (after && after.role === 'superadmin');
    if (touchesSuper && mine !== 'superadmin') return 'Only a super administrator can add, change or remove super administrators.';
    if (before && before.id === me) {
        if (!after) return 'You cannot delete your own account.';
        if (after.role !== before.role) return 'You cannot change your own role.';
        if (after.status === 'disabled') return 'You cannot disable your own account.';
        if ((after.extraPerms || []).slice().sort().join() !== (before.extraPerms || []).slice().sort().join()) return 'You cannot change your own permissions.';
    }
    if (before && before.role === 'superadmin' && before.status === 'active' && (!after || after.role !== 'superadmin' || after.status !== 'active')) {
        const others = users.filter(u => u.role === 'superadmin' && u.status === 'active' && u.id !== before.id);
        if (!others.length) return 'Keep at least one active super administrator.';
    }
    if (after && after.email) {
        const e = after.email.trim().toLowerCase();
        const dup = users.find(u => (u.email || '').toLowerCase() === e);
        if (dup && dup.id !== after.id) return `${userName(dup)} already uses that email address.`;
    }
    return '';
}

export async function saveDirectoryUser(before: UserRecord | undefined, after: UserRecord): Promise<void> {
    await Ent.users.save({ ...after, updatedAt: new Date().toISOString() });
    const what = !before ? 'User added' : before.status !== after.status ? (after.status === 'disabled' ? 'User disabled' : 'User enabled') : 'User updated';
    await audit('user', `${what}: ${userName(after)} (${after.email}) as ${roleLabel(after.role)}${after.entities && after.entities.length ? ', entities ' + after.entities.join(', ') : ''}`);
}

export async function deleteDirectoryUser(u: UserRecord): Promise<void> {
    await Ent.users.remove(u.id);
    await audit('user', `User deleted: ${userName(u)} (${u.email})`);
}
