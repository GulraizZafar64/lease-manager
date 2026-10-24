/* Where role changes are saved: on the server (VITE_USE_API=true), where they apply to everyone
   in the company at once, or in this browser (interface preview). */
import { USE_API, api } from '../../api/client';
import { recheckIdentity, reloadRoles } from '../../api/auth';
import { Ent, audit, isBuiltinRole } from '../../domain/enterprise';
import { Store } from '../../domain/store';
import { uid } from '../../utils/format';
import type { RoleDef, RoleKey } from '../../types/enterprise';

export interface NewRole { label: string; desc: string; perms: RoleDef['perms'] }
export interface RoleSource {
    server: boolean;
    /** Returns the new role's id. */
    create(r: NewRole): Promise<RoleKey>;
    save(def: RoleDef): Promise<void>;
    /** A built-in role back to its default permissions. */
    reset(def: RoleDef): Promise<void>;
    remove(def: RoleDef): Promise<void>;
}

/* ---- This browser ---- */
async function saveLocal(def: RoleDef, msg: string) {
    await Ent.roles.save({ ...def, updatedAt: new Date().toISOString(), updatedBy: Store.actorName() });
    await audit('role', `${msg}: ${def.label} (${def.perms.length} permissions)`);
}
const localSource: RoleSource = {
    server: false,
    async create(r) {
        const id = 'r-' + r.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) + '-' + uid().slice(0, 4);
        await saveLocal({ id, label: r.label, desc: r.desc || 'Custom role.', perms: r.perms, custom: true }, 'Role created');
        return id;
    },
    save: def => saveLocal(def, 'Role permissions changed'),
    async reset(def) { await Ent.roles.remove(def.id); await audit('role', `Role reset to default: ${def.label}`); },
    async remove(def) { await Ent.roles.remove(def.id); await audit('role', `Role deleted: ${def.label}`); },
};

/* ---- Backend API (lease-manager/src/roles.js); the server records each change in the audit log ---- */
/** Roles again, and the signed-in person's own permissions (their role may be the one changed). */
const changed = async (): Promise<void> => { await Promise.all([reloadRoles(), recheckIdentity()]); };
const apiSource: RoleSource = {
    server: true,
    async create(r) {
        const role = await api.post<{ id: RoleKey }>('/roles', { label: r.label, description: r.desc, perms: r.perms });
        await changed();
        return role.id;
    },
    async save(def) {
        await api.put(`/roles/${def.id}`, isBuiltinRole(def.id) ? { perms: def.perms } : { perms: def.perms, label: def.label, description: def.desc });
        await changed();
    },
    async reset(def) { await api.post(`/roles/${def.id}/reset`); await changed(); },
    async remove(def) { await api.del(`/roles/${def.id}`); await changed(); },
};

export const roleSource = (): RoleSource => USE_API ? apiSource : localSource;
