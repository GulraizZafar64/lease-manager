import { useState, type FormEvent } from 'react';
import { PERMS, PERM_GROUPS, realRole, roleDef, roleDefs, rolePerms } from '../../domain/enterprise';
import { userChangeProblem, userName } from '../../domain/directory';
import { ApiError } from '../../api/client';
import { TempPassword } from './TempPassword';
import type { UserSource } from './source';
import { SETTINGS } from '../../domain/settings';
import { Store } from '../../domain/store';
import { Modal, toast } from '../../utils/uiStore';
import { uid } from '../../utils/format';
import type { Permission, RoleKey, UserRecord } from '../../types/enterprise';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Add or edit a user (Users screen). */
export function UserForm({ user, source }: { user?: UserRecord; source: UserSource }) {
    const isSelf = !!user && user.id === Store.actorId();
    const mine = realRole();
    const [name, setName] = useState(user?.name || '');
    const [email, setEmail] = useState(user?.email || '');
    const [title, setTitle] = useState(user?.title || '');
    const [role, setRole] = useState<RoleKey>(user?.role || 'viewer');
    const [status, setStatus] = useState<'active' | 'disabled'>(user?.status || 'active');
    const [ents, setEnts] = useState<string[]>(user?.entities || []);
    const [limit, setLimit] = useState(user && user.limit ? String(user.limit) : '');
    const [extra, setExtra] = useState<Permission[]>(user?.extraPerms || []);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [showExtra, setShowExtra] = useState(!!(user?.extraPerms && user.extraPerms.length));
    const [busy, setBusy] = useState(false);
    const [created, setCreated] = useState<{ user: UserRecord; password: string } | null>(null);

    if (created) return <TempPassword user={created.user} password={created.password} added />;

    const roles = roleDefs().filter(r => r.id !== 'superadmin' || mine === 'superadmin' || user?.role === 'superadmin');
    const perms = rolePerms(role);
    const canApprove = perms.includes('approve') || extra.includes('approve');
    const allEntities = source.entityNames();
    const toggle = <T,>(list: T[], v: T, on: boolean): T[] => on ? list.concat([v]) : list.filter(x => x !== v);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const errs: Record<string, string> = {};
        if (!name.trim()) errs.name = 'Enter the person’s name.';
        if (!email.trim()) errs.email = 'Enter an email address.';
        else if (!EMAIL_RE.test(email.trim())) errs.email = 'Enter a valid email address.';
        else {
            const dup = source.users().find(u => u.id !== user?.id && (u.email || '').toLowerCase() === email.trim().toLowerCase());
            if (dup) errs.email = `${userName(dup)} already uses this email address.`;
        }
        if (limit && !(Number(limit) >= 0)) errs.limit = 'Enter a positive amount, or leave blank for no limit.';
        setErrors(errs);
        if (Object.keys(errs).length) return;
        const next: UserRecord = {
            ...(user || { id: 'u-' + uid(), addedAt: new Date().toISOString(), addedBy: Store.actorId() }),
            name: name.trim(), email: email.trim().toLowerCase(), title: title.trim(), role, status,
            entities: ents, limit: limit ? Number(limit) : '', extraPerms: extra.filter(p => !perms.includes(p)),
        };
        const problem = userChangeProblem(user, next, source.users());
        if (problem) { toast(problem); return; }
        setBusy(true);
        try {
            const r = await source.save(user, next);
            if (r.temporaryPassword) { setCreated({ user: next, password: r.temporaryPassword }); return; }
            Modal.close();
            toast(user ? 'User updated' : `${next.name} added`);
        } catch (err) {
            if (err instanceof ApiError && err.code === 'duplicate_email') setErrors({ email: err.message });
            else toast(err instanceof Error ? err.message : 'Could not save.');
        } finally { setBusy(false); }
    };

    const def = roleDef(role);
    return (
        <form className="user-form" onSubmit={submit} noValidate>
            <div className="row2">
                <div className="fg"><label htmlFor="uf-name">Full name <span className="req">*</span></label><input id="uf-name" value={name} autoFocus onChange={e => setName(e.target.value)} aria-invalid={!!errors.name} />{errors.name && <div className="field-err">{errors.name}</div>}</div>
                <div className="fg"><label htmlFor="uf-email">Email <span className="req">*</span></label><input id="uf-email" type="email" value={email} onChange={e => { setEmail(e.target.value); if (errors.email) setErrors(o => ({ ...o, email: '' })); }} aria-invalid={!!errors.email} />{errors.email ? <div className="field-err">{errors.email}</div> : <div className="hint">{source.server && user ? 'Used to sign in. Changing it signs the person out.' : source.server ? 'Used to sign in. They get a temporary password, shown to you once.' : 'Used to sign in.'}</div>}</div>
            </div>
            <div className="row2">
                <div className="fg"><label htmlFor="uf-title">Job title</label><input id="uf-title" value={title} placeholder="e.g. Lease Accountant" onChange={e => setTitle(e.target.value)} /></div>
                <div className="fg"><label htmlFor="uf-status">Status</label>
                    <select id="uf-status" value={status} disabled={isSelf} onChange={e => setStatus(e.target.value as 'active' | 'disabled')}><option value="active">Active: can sign in</option><option value="disabled">Disabled: cannot sign in</option></select>
                    {isSelf && <div className="hint">You cannot disable your own account.</div>}</div>
            </div>
            <div className="fg"><label htmlFor="uf-role">Role <span className="req">*</span></label>
                <select id="uf-role" value={role} disabled={isSelf || (user?.role === 'superadmin' && mine !== 'superadmin')} onChange={e => setRole(e.target.value)}>
                    {roles.map(r => <option key={r.id} value={r.id}>{r.label}{r.custom ? ' (custom)' : ''}</option>)}
                </select>
                <div className="hint">{isSelf ? 'You cannot change your own role. ' : ''}{def ? def.desc : ''} {perms.length} of {Object.keys(PERMS).length} permissions.</div>
            </div>
            <fieldset><legend>Entity access</legend>
                <div className="check-grid">{allEntities.map(n => <label key={n} className="check"><input type="checkbox" checked={ents.includes(n)} onChange={e => setEnts(toggle(ents, n, e.target.checked))} /> {n}</label>)}</div>
                <div className="hint" style={{ marginBottom: '10px' }}>{ents.length ? `Limited to ${ents.length} entit${ents.length === 1 ? 'y' : 'ies'}; leases of other entities are hidden.` : 'None ticked: access to all entities.'}</div>
            </fieldset>
            {canApprove && <div className="fg"><label htmlFor="uf-limit">Approval limit ({SETTINGS.functionalCurrency})</label><input id="uf-limit" type="number" min="0" step="any" value={limit} placeholder="No limit" onChange={e => setLimit(e.target.value)} />{errors.limit ? <div className="field-err">{errors.limit}</div> : <div className="hint">The largest item this person may approve. Blank means no limit.</div>}</div>}
            <div className="fg">
                <button type="button" className="link-btn" aria-expanded={showExtra} onClick={() => setShowExtra(v => !v)}>{showExtra ? '▾' : '▸'} Additional permissions{extra.length ? ` (${extra.length})` : ''}</button>
                {showExtra && <div className="extra-perms">
                    <div className="hint">{isSelf ? 'You cannot change your own permissions.' : 'Grant individual permissions on top of the role. Role preview ignores these.'}</div>
                    {PERM_GROUPS.map(([g, ps]) => {
                        const avail = ps.filter(p => !perms.includes(p));
                        return avail.length ? <div key={g} className="extra-group"><b>{g}</b>{avail.map(p => <label key={p} className="check"><input type="checkbox" checked={extra.includes(p)} disabled={isSelf} onChange={e => setExtra(toggle(extra, p, e.target.checked))} /> {PERMS[p]}</label>)}</div> : null;
                    })}
                    {perms.length === Object.keys(PERMS).length && <p className="note">This role already has every permission.</p>}
                </div>}
            </div>
            <div className="form-actions">
                <button type="button" className="btn btn-ghost" onClick={() => Modal.close()}>Cancel</button>
                <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving…' : user ? 'Save changes' : 'Add user'}</button>
            </div>
        </form>
    );
}
