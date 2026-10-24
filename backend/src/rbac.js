// Roles and permissions. Enforced on every API route on the server.
export const ROLES = {
    superadmin: 'Super administrator', admin: 'Administrator', controller: 'Controller (checker)', preparer: 'Lease accountant (maker)',
    treasury: 'Treasury', auditor: 'Auditor', viewer: 'Viewer'
};
export const PERMS = ['lease.view', 'lease.edit', 'lease.change', 'lease.delete', 'lease.import', 'approve', 'payment.record', 'bank.reconcile', 'payment.batch',
    'gl.export', 'report.export', 'audit.view', 'admin.users', 'admin.settings', 'admin.data', 'period.override', 'ai.use', 'ai.approve'];
export const ROLE_PERMS = {
    superadmin: PERMS, admin: PERMS,
    controller: ['lease.view', 'approve', 'report.export', 'audit.view', 'gl.export', 'ai.use', 'ai.approve', 'period.override'],
    preparer: ['lease.view', 'lease.edit', 'lease.change', 'lease.delete', 'lease.import', 'payment.record', 'report.export', 'gl.export', 'ai.use'],
    treasury: ['lease.view', 'payment.record', 'bank.reconcile', 'payment.batch', 'report.export', 'ai.use'],
    auditor: ['lease.view', 'report.export', 'audit.view', 'ai.use'],
    viewer: ['lease.view']
};
/** What each built-in role is for (shown on the Roles screen). */
export const ROLE_DESC = {
    superadmin: 'Everything, including managing administrators and security settings.',
    admin: 'Users, entities, policies and settings; all accounting actions.',
    controller: 'Approves leases, changes, payment batches and ERP exports within an approval limit.',
    preparer: 'Creates and edits leases, submits changes, records payments, imports contracts.',
    treasury: 'Bank statements, reconciliation and payment batches.',
    auditor: 'Read-only access to everything including the audit log; can export reports.',
    viewer: 'Read-only dashboards, register and reports.'
};
/** Every role keeps this permission; the app has nothing to show without it. */
export const REQUIRED_PERM = 'lease.view';
export const isBuiltinRole = id => Object.hasOwn(ROLES, id);
// A role's permissions: the super administrator has all; others as the company saved them (user.role_perms,
// loaded with the user from the roles table), else the built-in default.
export const rolePermsOf = (role, saved) => role === 'superadmin' ? PERMS.slice() : (saved || ROLE_PERMS[role] || []).filter(p => PERMS.includes(p));
// The role's permissions plus any granted to the user on top of it
const held = user => rolePermsOf(user.role, user.role_perms).concat((user.extra_perms || []).filter(p => PERMS.includes(p)));
export const can = (user, perm) => !!user && user.status === 'active' && held(user).includes(perm);
/** Everything the user may do, for the client to show and hide controls (the server still checks each call). */
export const permissionsOf = user => user && user.status === 'active' ? [...new Set(held(user))] : [];
// Only a super administrator may create, change or remove super administrators.
export function canManageRole(actor, targetRole) {
    if (!can(actor, 'admin.users')) return false;
    return targetRole !== 'superadmin' || actor.role === 'superadmin';
}
export class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code || 'error'; } }
export const forbid = (msg = 'Your role does not allow this.') => new HttpError(403, msg, 'forbidden');
// Entity scoping: users with no entity assignments see all entities.
export function entityFilter(user) { return user.entityIds && user.entityIds.length ? user.entityIds : null; }
export function assertEntity(user, entityId) {
    const f = entityFilter(user);
    if (f && !f.includes(entityId)) throw new HttpError(404, 'Not found', 'not_found'); // do not reveal existence
}
