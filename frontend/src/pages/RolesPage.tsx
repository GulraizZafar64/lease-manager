import { useEffect, useState, type FormEvent } from 'react';
import type { ScreenProps } from './registry';
import {
    ALL_PERMS, PERMS, PERM_GROUPS, audit, isBuiltinRole, policy, realRole, roleChanged, roleDef, roleDefs, roleLabel, rolePerms, setRoleOverride,
} from '../domain/enterprise';
import { userName } from '../domain/directory';
import { userSource } from '../components/users/source';
import { roleSource } from '../components/users/roleSource';
import { ApiError, USE_API } from '../api/client';
import { reloadRoles } from '../api/auth';
import { go, setParams } from '../domain/nav';
import { useAppState } from '../hooks/useAppState';
import { confirmDialog } from '../components/common/ConfirmDialog';
import { UserAvatar } from '../components/users/UserBits';
import { Modal, toast } from '../utils/uiStore';
import { fmtDateTime } from '../utils/dates';
import type { Permission, RoleDef, RoleKey } from '../types/enterprise';

/** Every role can view leases; the app has nothing to show without it. */
const REQUIRED: Permission = 'lease.view';
const PERM_HELP: Partial<Record<Permission, string>> = {
    'approve': 'Also needs the role to be listed in the approval policy tier for the amount.',
    'admin.users': 'Add people, change their roles and entity access.',
    'admin.data': 'Backups, restore, retention and bulk deletes.',
    'period.override': 'Post into periods locked in the approval policy; every use is logged.',
};

/** People with the role (this browser's users, or the server's). */
const usersWithRole = (id: RoleKey) => userSource().users().filter(u => u.role === id);

function policyUses(id: RoleKey): string[] {
    const p = policy();
    return (Object.keys(p) as (keyof typeof p)[]).filter(k => p[k].some(t => t.roles.includes(id)));
}

const failed = (e: unknown) => toast(e instanceof Error ? e.message : 'Something went wrong. Try again.');

/* ---- New role ---- */
function NewRoleForm({ from }: { from?: RoleKey }) {
    const [label, setLabel] = useState(from ? `${roleLabel(from)} (copy)` : '');
    const [desc, setDesc] = useState(from ? roleDef(from)?.desc || '' : '');
    const [base, setBase] = useState<RoleKey | ''>(from || 'viewer');
    const [err, setErr] = useState('');
    const [busy, setBusy] = useState(false);
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const name = label.trim();
        if (!name) return setErr('Give the role a name.');
        if (roleDefs().some(r => r.label.toLowerCase() === name.toLowerCase())) return setErr('A role with this name already exists.');
        const perms = base ? rolePerms(base) : [REQUIRED];
        setBusy(true);
        try {
            const id = await roleSource().create({ label: name, desc: desc.trim(), perms: Array.from(new Set([REQUIRED, ...perms])) });
            Modal.close();
            go('roles', { id }, { reset: true });
            toast(`${name} created`);
        } catch (ex) {
            if (ex instanceof ApiError && ex.code === 'duplicate_role') setErr(ex.message); else failed(ex);
        } finally { setBusy(false); }
    };
    return (
        <form onSubmit={submit} noValidate>
            <div className="fg"><label htmlFor="nr-name">Role name <span className="req">*</span></label><input id="nr-name" autoFocus value={label} placeholder="e.g. Regional controller" onChange={e => { setLabel(e.target.value); setErr(''); }} />{err && <div className="field-err">{err}</div>}</div>
            <div className="fg"><label htmlFor="nr-desc">Description</label><input id="nr-desc" value={desc} placeholder="What people with this role do" onChange={e => setDesc(e.target.value)} /></div>
            <div className="fg"><label htmlFor="nr-base">Start with the permissions of</label>
                <select id="nr-base" value={base} onChange={e => setBase(e.target.value)}><option value="">No permissions (view only)</option>{roleDefs().map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
                <div className="hint">You can change every permission after creating the role.</div></div>
            <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={() => Modal.close()}>Cancel</button><button type="submit" className="btn" disabled={busy}>{busy ? 'Creating…' : 'Create role'}</button></div>
        </form>
    );
}
const openNewRole = (from?: RoleKey) => Modal.open(from ? 'Duplicate role' : 'New role', <NewRoleForm from={from} />);

/* ---- Role editor ---- */
function RoleEditor({ role, canEdit }: { role: RoleDef; canEdit: boolean }) {
    const locked = role.id === 'superadmin';
    const [perms, setPerms] = useState<Permission[]>(() => rolePerms(role.id));
    const [label, setLabel] = useState(role.label);
    const [desc, setDesc] = useState(role.desc);
    const saved = rolePerms(role.id);
    const dirty = perms.slice().sort().join() !== saved.slice().sort().join() || (!!role.custom && (label !== role.label || desc !== role.desc));
    const editable = canEdit && !locked;
    const members = usersWithRole(role.id);
    const uses = policyUses(role.id);

    const toggle = (p: Permission, on: boolean) => setPerms(prev => on ? prev.concat([p]) : prev.filter(x => x !== p));
    const toggleGroup = (ps: Permission[], on: boolean) => setPerms(prev => on ? Array.from(new Set(prev.concat(ps))) : prev.filter(x => !ps.includes(x) || x === REQUIRED));
    const [busy, setBusy] = useState(false);
    const save = async () => {
        if (role.custom && !label.trim()) return toast('Give the role a name.');
        if (role.custom && roleDefs().some(r => r.id !== role.id && r.label.toLowerCase() === label.trim().toLowerCase())) return toast('A role with this name already exists.');
        setBusy(true);
        try {
            await roleSource().save({ id: role.id, label: role.custom ? label.trim() : role.label, desc: role.custom ? desc.trim() : role.desc, perms: Array.from(new Set([REQUIRED, ...perms])), custom: role.custom });
            toast(USE_API && members.length ? `Role saved. It applies to ${members.length} user${members.length > 1 ? 's' : ''} straight away.` : 'Role saved');
        } catch (e) { failed(e); } finally { setBusy(false); }
    };
    const reset = () => confirmDialog('Reset role', <>Reset <b>{role.label}</b> to its default permissions? {members.length ? `${members.length} user${members.length > 1 ? 's' : ''} with this role will be affected.` : ''}</>, 'Reset to default', async () => {
        try { await roleSource().reset(role); setPerms(rolePerms(role.id)); toast('Role reset'); } catch (e) { failed(e); }
    });
    const remove = () => {
        if (members.length) return toast(`${members.length} user${members.length > 1 ? 's have' : ' has'} this role. Give them another role first.`);
        if (uses.length) return toast(`The approval policy uses this role (${uses.join(', ')}). Remove it there first.`);
        confirmDialog('Delete role', <>Delete the role <b>{role.label}</b>? This cannot be undone.</>, 'Delete role', async () => {
            try { await roleSource().remove(role); go('roles', {}, { reset: true }); toast('Role deleted'); } catch (e) { failed(e); }
        });
    };
    const preview = () => { setRoleOverride(role.id); audit('role.preview', `Previewing as ${role.label}`); go('dashboard', {}, { reset: true }); toast(`Previewing as ${role.label}. End it from your account menu.`); };

    return (
        <div className="card role-editor">
            <div className="role-editor-head">
                {role.custom && editable
                    ? <div className="role-name-edit"><input aria-label="Role name" value={label} onChange={e => setLabel(e.target.value)} /><input aria-label="Description" value={desc} onChange={e => setDesc(e.target.value)} /></div>
                    : <div><h2>{role.label} {role.custom ? <span className="badge badge-neutral">Custom</span> : <span className="badge badge-info">Built-in</span>}{roleChanged(role.id) && <span className="badge badge-pending">Changed</span>}</h2><p className="note">{role.desc}</p></div>}
                <div className="btn-row">
                    {canEdit && role.id !== 'superadmin' && <button className="btn btn-ghost btn-sm" onClick={preview}>Preview as this role</button>}
                    {canEdit && <button className="btn btn-ghost btn-sm" onClick={() => openNewRole(role.id)}>Duplicate</button>}
                    {canEdit && role.custom && <button className="btn btn-ghost btn-sm btn-icon-danger" onClick={remove}>Delete</button>}
                </div>
            </div>

            <div className="role-meta">
                <button type="button" className="role-members" onClick={() => go('users', { role: role.id }, { reset: true })} title="Show these users">
                    <span className="avatar-stack">{members.slice(0, 5).map(u => <UserAvatar key={u.id} name={userName(u)} size={26} />)}</span>
                    {members.length ? `${members.length} user${members.length > 1 ? 's' : ''}` : 'No users'}
                </button>
                <span className="note">{perms.length} of {ALL_PERMS.length} permissions</span>
                {uses.length ? <span className="note">Approver in policy: {uses.join(', ')}</span> : null}
                {role.updatedAt && <span className="note">Changed {fmtDateTime(role.updatedAt)}{role.updatedBy ? ` by ${role.updatedBy}` : ''}</span>}
            </div>

            {locked && <div className="banner info-banner"><div><strong>Super administrator always has every permission</strong><p>So that someone can always manage users, roles and settings, this role cannot be changed.</p></div></div>}
            {!canEdit && <div className="banner"><div><strong>View only</strong><p>Only a super administrator can change roles and permissions.</p></div></div>}

            <div className="perm-groups">
                {PERM_GROUPS.map(([g, ps]) => {
                    const on = ps.filter(p => perms.includes(p)).length;
                    return (
                        <section key={g} className="perm-group">
                            <header><h4>{g}</h4><span className="note">{on}/{ps.length}</span>
                                {editable && <button type="button" className="link-btn" onClick={() => toggleGroup(ps, on < ps.length)}>{on < ps.length ? 'Select all' : 'Clear'}</button>}</header>
                            {ps.map(p => {
                                const required = p === REQUIRED;
                                const checked = perms.includes(p);
                                return (
                                    <label key={p} className={`perm-row${checked ? ' on' : ''}${!editable || required ? ' locked' : ''}`}>
                                        <span className="perm-text"><b>{PERMS[p]}</b><code>{p}</code>{PERM_HELP[p] && <em>{PERM_HELP[p]}</em>}{required && <em>Every role has this.</em>}</span>
                                        <span className="switch"><input type="checkbox" role="switch" checked={checked} disabled={!editable || required} onChange={e => toggle(p, e.target.checked)} /><i aria-hidden="true" /></span>
                                    </label>
                                );
                            })}
                        </section>
                    );
                })}
            </div>

            {editable && <div className="role-actions">
                {isBuiltinRole(role.id) && roleChanged(role.id) && <button className="btn btn-ghost" onClick={reset}>Reset to default</button>}
                <span className="spacer" />
                {dirty && <span className="note">Unsaved changes</span>}
                <button className="btn btn-ghost" disabled={!dirty} onClick={() => { setPerms(saved); setLabel(role.label); setDesc(role.desc); }}>Discard</button>
                <button className="btn" disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
            </div>}
        </div>
    );
}

/* ---- All roles side by side ---- */
function Compare({ roles, onPick }: { roles: RoleDef[]; onPick: (id: RoleKey) => void }) {
    return (
        <div className="card">
            <div className="section-head"><div><h2>Compare roles</h2><p className="note">Select a role name to edit it.</p></div></div>
            <div className="scroll-x"><table className="perm-matrix">
                <thead><tr><th>Permission</th>{roles.map(r => <th key={r.id} className="c"><button className="link-btn" onClick={() => onPick(r.id)}>{r.label}</button></th>)}</tr></thead>
                <tbody>{PERM_GROUPS.map(([g, ps]) => [
                    <tr key={g} className="grp"><td colSpan={roles.length + 1}>{g}</td></tr>,
                    ...ps.map(p => <tr key={p}><td>{PERMS[p]}</td>{roles.map(r => <td key={r.id} className="c">{rolePerms(r.id).includes(p) ? <span className="tick" aria-label="Yes">✓</span> : <span className="dash" aria-label="No">·</span>}</td>)}</tr>),
                ])}</tbody>
            </table></div>
        </div>
    );
}

/** Administration › Roles and permissions. */
export function RolesPage({ params: p }: ScreenProps<'roles'>) {
    useAppState();
    useEffect(() => { void userSource().load(); if (USE_API) reloadRoles().catch(() => { /* the roles loaded at sign-in stay */ }); }, []);
    const roles = roleDefs();
    const canEdit = realRole() === 'superadmin';
    const view = p.view === 'compare' ? 'compare' : 'edit';
    const sel = roles.find(r => r.id === p.id) || roles.find(r => r.id === 'admin') || roles[0];
    const pick = (id: RoleKey) => setParams<'roles'>({ id, view: 'edit' });

    return (
        <>
            <div className="dash-intro">
                <p className="note">{USE_API
                    ? 'Roles decide what people can do. They are saved on the server for your company and apply to everyone with the role straight away.'
                    : 'Roles decide what people can do. Built-in roles match the server; custom roles are kept in this browser until the API is connected.'}</p>
                <div className="btn-row">
                    <div className="seg"><button aria-pressed={view === 'edit'} onClick={() => setParams<'roles'>({ view: 'edit' })}>Edit roles</button><button aria-pressed={view === 'compare'} onClick={() => setParams<'roles'>({ view: 'compare' })}>Compare</button></div>
                    {canEdit && <button className="btn btn-sm" onClick={() => openNewRole()}>New role</button>}
                </div>
            </div>
            {view === 'compare' ? <Compare roles={roles} onPick={pick} /> : (
                <div className="roles-layout">
                    <nav className="role-list" aria-label="Roles">
                        {roles.map(r => {
                            const n = usersWithRole(r.id).length;
                            return (
                                <button key={r.id} className={`role-item${r.id === sel.id ? ' active' : ''}`} aria-current={r.id === sel.id ? 'true' : undefined} onClick={() => pick(r.id)}>
                                    <span className="role-item-top"><b>{r.label}</b>{r.custom ? <span className="badge badge-neutral">Custom</span> : roleChanged(r.id) ? <span className="badge badge-pending">Changed</span> : null}</span>
                                    <span className="role-item-meta">{rolePerms(r.id).length} permissions · {n} user{n === 1 ? '' : 's'}</span>
                                    <span className="perm-bar" aria-hidden="true"><i style={{ width: `${(rolePerms(r.id).length / ALL_PERMS.length) * 100}%` }} /></span>
                                </button>
                            );
                        })}
                        {canEdit && <button className="role-item add" onClick={() => openNewRole()}>+ New role</button>}
                    </nav>
                    <RoleEditor key={`${sel.id}|${sel.updatedAt || ''}|${rolePerms(sel.id).join()}`} role={sel} canEdit={canEdit} />
                </div>
            )}
        </>
    );
}
