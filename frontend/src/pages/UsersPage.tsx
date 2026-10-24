import { useEffect } from 'react';
import type { ScreenProps } from './registry';
import { can, gate, rolePerms, roleDefs, roleLabel } from '../domain/enterprise';
import { userChangeProblem, userName } from '../domain/directory';
import { go, setParams } from '../domain/nav';
import { Store } from '../domain/store';
import { SETTINGS } from '../domain/settings';
import { useAppState } from '../hooks/useAppState';
import { confirmDialog } from '../components/common/ConfirmDialog';
import { UserForm } from '../components/users/UserForm';
import { TempPassword } from '../components/users/TempPassword';
import { userSource, type UserSource } from '../components/users/source';
import { RoleBadge, StatusPill, UserAvatar } from '../components/users/UserBits';
import { Modal, popover, toast } from '../utils/uiStore';
import { fmtNum } from '../utils/format';
import { fmtDateTime } from '../utils/dates';
import type { UserRecord } from '../types/enterprise';

const openForm = (src: UserSource, u?: UserRecord) => Modal.open(u ? `Edit ${userName(u)}` : 'Add user', <UserForm user={u} source={src} />, { wide: true });
const failed = (e: unknown) => toast(e instanceof Error ? e.message : 'Something went wrong. Try again.');
const isLocked = (u: UserRecord) => !!u.lockedUntil && new Date(u.lockedUntil) > new Date();

async function setStatus(src: UserSource, u: UserRecord, status: 'active' | 'disabled') {
    const next = { ...u, status };
    const problem = userChangeProblem(u, next, src.users());
    if (problem) return toast(problem);
    try { await src.save(u, next); } catch (e) { return failed(e); }
    toast(status === 'active' ? `${userName(u)} can sign in again` : `${userName(u)} can no longer sign in`);
}
function remove(src: UserSource, u: UserRecord) {
    const problem = userChangeProblem(u, null, src.users());
    if (problem) return toast(problem);
    confirmDialog('Delete user', <>Delete <b>{userName(u)}</b> ({u.email})? They will no longer be able to sign in. Their past work and audit entries are kept. To keep the account for later, disable it instead.</>, 'Delete user',
        async () => { try { await src.remove(u); toast('User deleted'); } catch (e) { failed(e); } });
}
function resetPassword(src: UserSource, u: UserRecord) {
    confirmDialog('Reset password', <>Give <b>{userName(u)}</b> a new temporary password? Their current password stops working and they are signed out. They choose a new password at their next sign-in.</>, 'Reset password',
        async () => { try { const pw = await src.resetPassword(u); Modal.open('Temporary password', <TempPassword user={u} password={pw} />); } catch (e) { failed(e); } });
}
function resetMfa(src: UserSource, u: UserRecord) {
    confirmDialog('Reset two-step sign-in', <>Reset two-step sign-in for <b>{userName(u)}</b>? Use this when they lost their phone or authenticator app. They are signed out and set up the app again at their next sign-in.</>, 'Reset',
        async () => { try { await src.resetMfa(u); toast(`${userName(u)} sets up two-step sign-in at the next sign-in`); } catch (e) { failed(e); } });
}
async function unlock(src: UserSource, u: UserRecord) {
    try { await src.unlock(u); toast(`${userName(u)} can sign in again`); } catch (e) { failed(e); }
}

function RowMenu({ src, u, self, manage }: { src: UserSource; u: UserRecord; self: boolean; manage: boolean }) {
    const run = (f: () => void) => () => { popover.close(); f(); };
    const notSelf = self ? <em>Not for your own account</em> : null;
    return (
        <div className="row-menu" role="menu">
            {src.server && isLocked(u) && <button role="menuitem" disabled={!manage} onClick={run(() => void unlock(src, u))}>Unlock<em>Locked after failed sign-ins</em></button>}
            {src.server && <button role="menuitem" disabled={!manage || self} onClick={run(() => resetPassword(src, u))}>Reset password{notSelf}</button>}
            {src.server && <button role="menuitem" disabled={!manage || self || !u.mfaEnabled} onClick={run(() => resetMfa(src, u))}>Reset two-step sign-in{self ? notSelf : !u.mfaEnabled ? <em>Not set up yet</em> : null}</button>}
            {u.status === 'active'
                ? <button role="menuitem" disabled={!manage || self} onClick={run(() => void setStatus(src, u, 'disabled'))}>Disable sign-in{notSelf}</button>
                : <button role="menuitem" disabled={!manage} onClick={run(() => void setStatus(src, u, 'active'))}>Enable sign-in</button>}
            <button role="menuitem" className="danger" disabled={!manage || self} onClick={run(() => remove(src, u))}>Delete user{notSelf}</button>
        </div>
    );
}

/** Status, and for people signing in through the server, where they are with sign-in. */
function SignInState({ u }: { u: UserRecord }) {
    if (isLocked(u)) return <><span className="status-pill locked">Locked</span><span className="user-signin-note">Too many failed sign-ins</span></>;
    return <><StatusPill status={u.status} />{u.status === 'active' && u.mustChangePassword && <span className="user-signin-note">{u.lastLoginAt ? 'Password reset: new one at next sign-in' : 'Not signed in yet'}</span>}</>;
}

/** Administration › Users: people who can sign in, their role, entities and limits. */
export function UsersPage({ params: p }: ScreenProps<'users'>) {
    useAppState();
    const src = userSource();
    useEffect(() => { void src.load(); }, [src]);
    const { loading, error } = src.status();
    const manage = can('admin.users');
    const me = Store.actorId();
    const all = src.users();
    const q = (p.q || '').trim().toLowerCase();
    const rows = all
        .filter(u => !q || [u.name, u.email, u.title, roleLabel(u.role)].some(v => (v || '').toLowerCase().includes(q)))
        .filter(u => !p.role || u.role === p.role)
        .filter(u => !p.status || u.status === p.status)
        .sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1) || userName(a).localeCompare(userName(b)));
    const active = all.filter(u => u.status === 'active').length;
    const approvers = all.filter(u => u.status === 'active' && rolePerms(u.role).concat(u.extraPerms || []).includes('approve')).length;
    const admins = all.filter(u => u.status === 'active' && rolePerms(u.role).includes('admin.users')).length;
    const filtered = !!(q || p.role || p.status);

    if (Store.mode === 'db') return <div className="banner"><div><strong>Users are managed in Administration</strong><p>Inside Claude, people sign in with their Claude account. Add them and set their roles in Administration › Users and roles.</p></div><div className="banner-actions"><button className="btn btn-sm" onClick={() => go('admin', { tab: 'users' }, { reset: true })}>Open Administration</button></div></div>;

    return (
        <>
            <div className="stat-row">
                <div className="stat"><span>Users</span><b>{all.length}</b></div>
                <div className="stat"><span>Active</span><b>{active}</b><em>{all.length - active} disabled</em></div>
                <div className="stat"><span>Can approve</span><b>{approvers}</b></div>
                <div className="stat"><span>Can manage users</span><b>{admins}</b></div>
            </div>
            <div className="card">
                <div className="section-head">
                    <div><h2>People</h2><p className="note">Who can sign in, with what role, for which entities.</p></div>
                    <div className="btn-row">
                        <button className="btn btn-ghost" onClick={() => go('roles', {}, { reset: true })}>Roles and permissions</button>
                        <button className="btn" id="us-add" {...gate('admin.users')} onClick={() => openForm(src)}>Add user</button>
                    </div>
                </div>
                <div className="users-toolbar">
                    <input type="search" placeholder="Search name, email, title or role" value={p.q || ''} onChange={e => setParams<'users'>({ q: e.target.value })} aria-label="Search users" />
                    <select value={p.role || ''} onChange={e => setParams<'users'>({ role: e.target.value })} aria-label="Filter by role">
                        <option value="">All roles</option>{roleDefs().map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                    </select>
                    <select value={p.status || ''} onChange={e => setParams<'users'>({ status: e.target.value })} aria-label="Filter by status">
                        <option value="">Any status</option><option value="active">Active</option><option value="disabled">Disabled</option>
                    </select>
                    <span className="note">{rows.length} of {all.length}</span>
                    {filtered && <button className="btn btn-ghost btn-sm" onClick={() => setParams<'users'>({ q: '', role: '', status: '' })}>Clear</button>}
                </div>
                <div className="scroll-x">
                    <table className="users-table">
                        <thead><tr><th>User</th><th>Role</th><th>Entities</th><th className="num">Approval limit</th><th>Status</th><th>Last sign-in</th><th aria-label="Actions"></th></tr></thead>
                        <tbody>
                            {rows.length ? rows.map(u => {
                                const self = u.id === me;
                                return (
                                    <tr key={u.id} className={u.status === 'disabled' ? 'is-disabled' : ''}>
                                        <td><div className="user-cell"><UserAvatar name={userName(u)} muted={u.status === 'disabled'} /><div><b>{userName(u)}{self && <span className="you-tag">You</span>}</b><span>{u.email}</span>{u.title && <span>{u.title}</span>}</div></div></td>
                                        <td><RoleBadge role={u.role} />{u.extraPerms && u.extraPerms.length ? <div className="note">+{u.extraPerms.length} permission{u.extraPerms.length > 1 ? 's' : ''}</div> : null}</td>
                                        <td className="ents">{u.entities && u.entities.length ? u.entities.join(', ') : <span className="note">All entities</span>}</td>
                                        <td className="num">{u.limit ? `${SETTINGS.functionalCurrency} ${fmtNum(Number(u.limit))}` : <span className="note">{rolePerms(u.role).concat(u.extraPerms || []).includes('approve') ? 'No limit' : '—'}</span>}</td>
                                        <td><SignInState u={u} /></td>
                                        <td className="note">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'Never'}</td>
                                        <td><div className="row-actions">
                                            <button className="btn btn-ghost btn-sm" disabled={!manage} onClick={() => openForm(src, u)}>Edit</button>
                                            <button className="btn btn-ghost btn-sm more-btn" aria-label={`More actions for ${userName(u)}`} aria-haspopup="menu" disabled={!manage} onClick={e => popover.open(e.currentTarget, <RowMenu src={src} u={u} self={self} manage={manage} />)}>⋯</button>
                                        </div></td>
                                    </tr>
                                );
                            }) : <tr><td colSpan={7} className="empty">{loading ? 'Loading users…' : error ? error : filtered ? 'No users match these filters.' : 'No users yet.'}</td></tr>}
                        </tbody>
                    </table>
                </div>
                <div className="table-note">{src.server
                    ? 'Passwords, two-step sign-in and lockout are handled by the server. New users get a temporary password, shown to you once, and set up an authenticator app at their first sign-in.'
                    : 'Passwords and sign-in security (MFA, lockout) are handled by the server once the API is connected. Until then sign-in only checks that the email belongs to an active user.'}</div>
            </div>
        </>
    );
}
