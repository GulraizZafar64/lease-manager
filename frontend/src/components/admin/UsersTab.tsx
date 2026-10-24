import { useEffect, useState } from 'react';
import { num } from '../../domain/engine';
import { SETTINGS } from '../../domain/settings';
import { Store } from '../../domain/store';
import { Ent, PERMS, audit, entities, guard, nameOf, realRole, resolveNames, roleDefs, roleLabel, rolePerms, setRoleOverride } from '../../domain/enterprise';
import { go } from '../../domain/nav';
import { useAppState } from '../../hooks/useAppState';
import { toast } from '../../utils/uiStore';
import { fmtNum } from '../../utils/format';
import { fmtDate } from '../../utils/dates';
import type { AccessRequest, Permission, RoleKey, UserRecord } from '../../types/enterprise';

type SaveUser = (id: string, patch: Partial<UserRecord>, msg: string) => Promise<void>;
const roleEntries = (): [RoleKey, { label: string }][] => roleDefs().map(r => [r.id, { label: r.label }]);

function RequestRow({ r, mine, saveUser }: { r: AccessRequest; mine: RoleKey; saveUser: SaveUser }) {
    const [role, setRole] = useState<RoleKey>('viewer');
    return (
        <tr><td>{nameOf(r.id)}</td><td>{fmtDate((r.at || '').slice(0, 10))}</td><td className="wrap">{r.note || ''}</td><td><select data-req-role={r.id} style={{ width: 'auto' }} value={role} onChange={e => setRole(e.target.value as RoleKey)}>{roleEntries().filter(([k]) => k !== 'superadmin' || mine === 'superadmin').map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>{' '}<button className="btn btn-sm" data-grant={r.id} onClick={async () => { await saveUser(r.id, { role }, 'Access granted'); await Ent.requests.remove(r.id).catch(() => { }); }}>Grant</button></td></tr>
    );
}

function UserRow({ u, mine, ents, saveUser }: { u: UserRecord; mine: RoleKey; ents: string[]; saveUser: SaveUser }) {
    const [role, setRole] = useState<RoleKey>(u.role);
    const [sel, setSel] = useState<string[]>(() => ents.filter(e => (u.entities || []).includes(e)));
    const [limit, setLimit] = useState(String(u.limit || ''));
    const [status, setStatus] = useState<UserRecord['status']>(u.status !== 'disabled' ? 'active' : 'disabled');
    return (
        <tr data-u={u.id}><td>{nameOf(u.id)}{u.id === Store.actorId() ? <>{' '}<span className="note">(you)</span></> : null}</td>
            <td><select data-f="role" style={{ width: 'auto' }} disabled={u.role === 'superadmin' && mine !== 'superadmin'} value={role} onChange={e => setRole(e.target.value as RoleKey)}>{roleEntries().filter(([k]) => k !== 'superadmin' || mine === 'superadmin' || u.role === 'superadmin').map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></td>
            <td><select data-f="entities" multiple size={Math.min(3, ents.length)} style={{ width: '200px' }} value={sel} onChange={e => setSel(Array.from(e.target.selectedOptions).map(o => o.value))}>{ents.map(e => <option key={e}>{e}</option>)}</select></td>
            <td><input data-f="limit" type="number" value={limit} placeholder="No limit" style={{ width: '140px' }} onChange={e => setLimit(e.target.value)} /></td>
            <td><select data-f="status" style={{ width: 'auto' }} value={status} onChange={e => setStatus(e.target.value as UserRecord['status'])}><option value="active">Active</option><option value="disabled">Disabled</option></select></td>
            <td><button className="btn btn-sm" data-save={u.id} onClick={() => saveUser(u.id, { role, entities: sel, limit: num(limit) || '', status }, 'User updated')}>Save</button></td></tr>
    );
}

/** Administration › Users and roles. */
export function UsersTab() {
    useAppState();
    if (Store.mode !== 'db') return (
        <div className="banner"><div><strong>Users and roles have their own screens</strong><p>In this browser, people sign in with an email from Users, and what they can do comes from Roles and permissions.</p></div>
            <div className="banner-actions"><button className="btn btn-sm" onClick={() => go('users', {}, { reset: true })}>Open Users</button><button className="btn btn-ghost btn-sm" onClick={() => go('roles', {}, { reset: true })}>Open Roles and permissions</button></div></div>
    );
    return <ClaudeUsersTab />;
}

/** Users inside the Claude viewer, identified by their Claude account. */
function ClaudeUsersTab() {
    const users = Ent.users.items.slice(), reqs = Ent.requests.items.filter(r => !Ent.users.get(r.id));
    const idKey = users.map(u => u.id).concat(reqs.map(r => r.id)).join('\n');
    const [ready, setReady] = useState(false);
    const [, setNames] = useState(0);
    const [q, setQ] = useState('');
    const [hits, setHits] = useState<ClaudeUserProfile[] | null>(null);
    const [gen, setGen] = useState(0);
    useEffect(() => {
        let live = true;
        resolveNames(idKey ? idKey.split('\n') : []).then(() => { if (live) { setReady(true); setNames(n => n + 1); } });
        return () => { live = false; };
    }, [idKey]);
    if (!ready) return null;
    const mine = realRole(), ents = entities().map(e => e.name);

    const saveUser: SaveUser = async (id, patch, msg) => {
        if (!guard('admin.users')) return;
        const u = Object.assign({ id, addedBy: Store.actorId(), addedAt: new Date().toISOString(), status: 'active' }, Ent.users.get(id) || {}, patch) as UserRecord;
        if (u.role === 'superadmin' && realRole() !== 'superadmin') return toast('Only a super administrator can grant that role.');
        const supers = Ent.users.items.filter(x => x.role === 'superadmin' && x.status !== 'disabled' && x.id !== id);
        if (!supers.length && (u.role !== 'superadmin' || u.status === 'disabled') && (Ent.users.get(id) || { role: '' }).role === 'superadmin') return toast('Keep at least one active super administrator.');
        try {
            await Ent.users.save(u);
            await audit('user', `${msg}: ${nameOf(id)} as ${roleLabel(u.role)}${u.entities && u.entities.length ? ', entities ' + u.entities.join(', ') : ''}${u.limit ? ', limit ' + fmtNum(u.limit) : ''}${u.status === 'disabled' ? ', disabled' : ''}`);
            toast('User saved');
            // the original re-rendered the tab here, clearing the search and resetting the rows
            setHits(null); setQ(''); setGen(g => g + 1);
        } catch { /* the collection already reported the error */ }
    };
    const find = async () => {
        const user = Store.user; if (!user) return;
        const found = await user.search(q).catch(() => [] as ClaudeUserProfile[]);
        found.forEach(h => { Ent.names[h.id] = h.name || ''; });
        setHits(found);
    };

    return (
        <>
            <div className="banner"><div><strong>How access works</strong><p>People sign in with their Claude account; the page receives a verified user ID. Roles here control what each person can do in the app. Changing who may edit users is also limited by the page’s sharing level: only people the owner shares as Editor can save user changes. Multi-factor authentication applies at sign-in to Claude and your identity provider, not inside this page.</p></div></div>
            {reqs.length ? <><h3>Access requests</h3><table style={{ marginBottom: '16px' }}><tbody>{reqs.map(r => <RequestRow key={`${r.id}-${gen}`} r={r} mine={mine} saveUser={saveUser} />)}</tbody></table></> : null}
            <div className="section-head" style={{ padding: '0 0 10px', border: 'none' }}><h3>Users</h3>{Store.user ? <div className="btn-row"><input id="us-q" placeholder="Find a person in your organisation" style={{ width: '260px' }} value={q} onChange={e => setQ(e.target.value)} /><button className="btn btn-sm" id="us-find" onClick={find}>Find</button></div> : null}</div><div id="us-hits">{hits ? (hits.length ? <table style={{ marginBottom: '12px' }}><tbody>{hits.slice(0, 10).map(h => <tr key={h.id}><td>{h.name || 'Unnamed'}{h.guest ? <>{' '}<span className="note">(guest)</span></> : null}</td><td>{Ent.users.get(h.id) ? 'Already a user' : <button className="btn btn-sm" data-add={h.id} onClick={() => saveUser(h.id, { role: 'viewer' }, 'User added')}>Add as viewer</button>}</td></tr>)}</tbody></table> : <p className="note">No one found.</p>) : null}</div>
            <div className="scroll-x"><table><thead><tr><th>Name</th><th>Role</th><th>Entities (blank = all)</th><th className="num">Approval limit ({SETTINGS.functionalCurrency})</th><th>Status</th><th></th></tr></thead><tbody>
                {users.length ? users.map(u => <UserRow key={`${u.id}-${gen}-${JSON.stringify(u)}`} u={u} mine={mine} ents={ents} saveUser={saveUser} />) : <tr><td colSpan={6} className="empty">No users yet.</td></tr>}</tbody></table></div>
            <h3 style={{ marginTop: '20px' }}>Roles and permissions</h3><div className="scroll-x"><table><thead><tr><th>Permission</th>{roleEntries().map(([k, r]) => <th key={k}>{r.label}</th>)}</tr></thead><tbody>{(Object.entries(PERMS) as [Permission, string][]).map(([k, v]) => <tr key={k}><td>{v}</td>{roleEntries().map(([r]) => <td key={r} style={{ textAlign: 'center' }}>{rolePerms(r).includes(k) ? '✓' : ''}</td>)}</tr>)}</tbody></table></div>
            {mine === 'superadmin' ? <div className="fg" style={{ marginTop: '16px', maxWidth: '420px' }}><label htmlFor="us-prev">Preview the app as another role (this session only)</label><select id="us-prev" value={Ent.roleOverride || ''} onChange={e => { const v = e.target.value as RoleKey | ''; setRoleOverride(v || null); audit('role.preview', v ? `Previewing as ${v}` : 'Preview ended'); go('dashboard', {}, { reset: true }); }}><option value="">Off: use my own role</option>{roleEntries().map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select><div className="hint">Use this to test segregation of duties. It only narrows what you can do.</div></div> : null}
        </>
    );
}
