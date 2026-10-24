import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AuthLayout, ICON, Icon, PasswordField } from '../pages/LoginPage';
import { PLATFORM_OWNER, getPlatformSession, platformSignIn, platformSignOut } from '../domain/platform';
import { ApiError, USE_API, api, onSessionEnded } from '../api/client';
import { ChangePasswordStep, MfaEnrolStep, MfaVerifyStep, type AuthNext } from '../components/auth/AuthSteps';
import { confirmDialog } from '../components/common/ConfirmDialog';
import { initTheme } from '../domain/startup';
import { ModalHost, PopoverHost, ToastHost, useEscapeToClose } from '../components/common/Hosts';
import { UserAvatar } from '../components/users/UserBits';
import { CompanyForm } from './CompanyForm';
import { apiSource, localSource, type CompanyRow, type PlatformSource } from './source';
import { Modal, toast } from '../utils/uiStore';
import { fmtDate } from '../utils/dates';
import '../styles/login.css';
import '../styles/platform.css';

const base = (): string => import.meta.env.BASE_URL.replace(/\/$/, '');
const setPath = (p: string) => { if (window.location.pathname !== base() + p) window.history.replaceState(null, '', base() + p); };
const PITCH = 'Run lease accounting for every company you serve.';
const FEATURES = ['Add customer companies', 'Appoint each company’s super administrators', 'Each company’s data kept separate'];

interface Account { name: string; email: string }

/* ---- Sign-in form (both modes) ---- */
function PlatformLoginForm({ onSubmit, demo, notice }: { onSubmit: (email: string, password: string) => Promise<string | void>; demo?: () => void; notice?: string }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [errors, setErrors] = useState<{ email?: string; password?: string; form?: string }>({});
    const [busy, setBusy] = useState(false);
    const emailRef = useRef<HTMLInputElement>(null);
    useEffect(() => { document.title = 'Platform sign-in | IFRS 16 Lease Manager'; emailRef.current?.focus(); }, []);
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const errs: typeof errors = {};
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errs.email = 'Enter your email address.';
        if (!password) errs.password = 'Enter your password.';
        setErrors(errs);
        if (errs.email || errs.password) return;
        setBusy(true);
        const problem = await onSubmit(email.trim(), password);
        setBusy(false);
        if (problem) setErrors({ form: problem });
    };
    return (
        <form className="auth-card" onSubmit={submit} noValidate>
            <span className="pf-tag">Platform console</span>
            <h1>Platform sign-in</h1>
            <p className="auth-sub">For the owner of this service. Company users sign in on the normal login page.</p>
            {notice && <div className="auth-notice" role="status">{notice}</div>}
            {errors.form && <div className="auth-error-box" role="alert">{errors.form}</div>}
            <div className="fg">
                <label htmlFor="pf-email">Email</label>
                <div className={`auth-input${errors.email ? ' invalid' : ''}`}><Icon d={ICON.mail} /><input id="pf-email" ref={emailRef} type="email" autoComplete="username" placeholder="you@yourcompany.com" value={email} onChange={e => setEmail(e.target.value)} aria-invalid={!!errors.email} /></div>
                {errors.email && <div className="auth-err">{errors.email}</div>}
            </div>
            <PasswordField value={password} error={errors.password} onChange={setPassword} />
            <button type="submit" className="btn auth-submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
            {demo && <><div className="auth-or"><span>or</span></div>
                <button type="button" className="btn btn-ghost auth-submit" onClick={demo}>Continue as {PLATFORM_OWNER.name} (demo)</button>
                <div className="auth-note" role="note"><Icon d={ICON.info} /><p>Interface preview: the platform owner is {PLATFORM_OWNER.email} and passwords are not checked yet. Companies and their data are kept in this browser only.</p></div></>}
            <p className="auth-alt">Company user? <a href={base() + '/login'}>Sign in to your company</a></p>
        </form>
    );
}

/* ---- Companies console (both modes) ---- */
type StatusFilter = '' | 'active' | 'inactive';

function Console({ source, account, onLogout }: { source: PlatformSource; account: Account; onLogout: () => void }) {
    const [rows, setRows] = useState<CompanyRow[] | null>(null);
    const [loadError, setLoadError] = useState('');
    const [filter, setFilter] = useState<StatusFilter>('');
    const reload = useCallback(() => source.list().then(r => { setRows(r); setLoadError(''); }, e => setLoadError(e instanceof Error ? e.message : 'Could not load companies.')), [source]);
    useEffect(() => { document.title = 'Companies | Platform console'; void reload(); }, [reload]);

    const all = rows || [];
    const isActive = (c: CompanyRow) => c.status === 'active';
    const activeCount = all.filter(isActive).length;
    const list = all.filter(c => !filter || (filter === 'active') === isActive(c));
    const totals = all.filter(isActive).reduce((t, r) => ({ users: t.users + r.usersActive, supers: t.supers + r.superAdmins.length, leases: t.leases + r.leases }), { users: 0, supers: 0, leases: 0 });
    const add = () => Modal.open('Add company', <CompanyForm source={source} onCreated={() => void reload()} />, { wide: true });
    const setStatus = async (c: CompanyRow, status: 'active' | 'inactive') => {
        try { await source.setStatus(c.id, status); toast(status === 'active' ? `${c.name} is active again; its users can sign in` : `${c.name} is inactive`); }
        catch (e) { toast(e instanceof Error ? e.message : 'Could not change the status.'); }
        void reload();
    };
    const toggle = (c: CompanyRow) => isActive(c)
        ? confirmDialog('Deactivate company', <>Deactivate <b>{c.name}</b>? Its {c.usersActive} user{c.usersActive === 1 ? '' : 's'} will be signed out and cannot sign in until you activate it again. Its leases, users and settings are kept.</>, 'Deactivate', () => void setStatus(c, 'inactive'))
        : void setStatus(c, 'active');

    return (
        <div className="pf">
            <header className="pf-bar">
                <div className="pf-brand"><div className="brand-mark" aria-hidden="true">16</div><div><b>IFRS 16 Lease Manager</b><span>Platform console</span></div></div>
                <div className="pf-user">
                    <UserAvatar name={account.name} size={30} />
                    <div><b>{account.name}</b><span>{account.email}</span></div>
                    <button className="btn btn-ghost btn-sm" onClick={onLogout}>Log out</button>
                </div>
            </header>
            <main className="pf-main">
                <div className="pf-head">
                    <div><h1>Companies</h1><p className="note">Each company has its own users, roles, leases and settings. You add the company and its super administrators; they manage everything else.</p></div>
                    <button className="btn" id="pf-add" onClick={add}>Add company</button>
                </div>
                <div className="stat-row">
                    <div className="stat"><span>Companies</span><b>{all.length}</b><em>{activeCount} active · {all.length - activeCount} inactive</em></div>
                    <div className="stat"><span>Active users</span><b>{totals.users}</b><em>In active companies</em></div>
                    <div className="stat"><span>Super administrators</span><b>{totals.supers}</b></div>
                    <div className="stat"><span>Leases</span><b>{totals.leases}</b></div>
                </div>
                <div className="card">
                    <div className="pf-toolbar">
                        <div className="seg" role="group" aria-label="Filter by status">
                            {([['', `All (${all.length})`], ['active', `Active (${activeCount})`], ['inactive', `Inactive (${all.length - activeCount})`]] as [StatusFilter, string][]).map(([k, l]) => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
                        </div>
                        {loadError && <span className="field-err" role="alert">{loadError} <button className="link-btn" onClick={() => void reload()}>Retry</button></span>}
                    </div>
                    <div className="scroll-x"><table className="pf-table">
                        <thead><tr><th>Company</th><th>Status</th><th>Super administrators</th><th className="num">Users</th><th className="num">Leases</th><th>Currency</th><th>Added</th><th aria-label="Actions"></th></tr></thead>
                        <tbody>{rows === null && !loadError ? <tr><td colSpan={8} className="empty">Loading companies…</td></tr>
                            : list.length ? list.map(c => (
                                <tr key={c.id} className={isActive(c) ? '' : 'is-inactive'}>
                                    <td><div className="pf-co"><span className="pf-co-ic" aria-hidden="true"><Icon d={ICON.building} /></span><div><b>{c.name}{c.demo && <span className="badge badge-neutral">Demo</span>}</b><span>{c.code}</span></div></div></td>
                                    <td><span className={`status-pill ${isActive(c) ? 'active' : 'disabled'}`}>{isActive(c) ? 'Active' : 'Inactive'}</span>{!isActive(c) && c.statusChangedAt ? <div className="note">since {fmtDate(c.statusChangedAt.slice(0, 10))}</div> : null}</td>
                                    <td><div className="pf-supers">{c.superAdmins.length ? c.superAdmins.map(u => <span key={u.id} className="pf-super" title={u.email}><UserAvatar name={u.name || u.email || '?'} size={24} />{u.name}<em>{u.email}</em></span>) : <span className="note">None active</span>}</div></td>
                                    <td className="num">{c.usersActive}{c.usersTotal > c.usersActive ? <span className="note"> / {c.usersTotal}</span> : null}</td>
                                    <td className="num">{c.leases}</td>
                                    <td>{c.currency}</td>
                                    <td className="note">{fmtDate(c.createdAt.slice(0, 10))}</td>
                                    <td className="num">{isActive(c)
                                        ? <button className="btn btn-ghost btn-sm btn-icon-danger" data-deactivate={c.id} onClick={() => toggle(c)}>Deactivate</button>
                                        : <button className="btn btn-sm" data-activate={c.id} onClick={() => toggle(c)}>Activate</button>}</td>
                                </tr>
                            )) : <tr><td colSpan={8} className="empty">{filter ? `No ${filter} companies.` : 'No companies yet. Add your first customer.'}</td></tr>}</tbody>
                    </table></div>
                    <div className="table-note">{source.server ? 'Companies are stored on the server. Temporary passwords for new super administrators are shown once, when you add the company.' : 'Companies and their data live in this browser until the platform runs on a server.'}</div>
                </div>
            </main>
        </div>
    );
}

/* ---- Interface preview: everything in this browser ---- */
function LocalPlatform() {
    const [signedIn, setSignedIn] = useState(() => !!getPlatformSession());
    useEffect(() => { setPath(signedIn ? '/platform' : '/platform/login'); }, [signedIn]);
    if (!signedIn) return (
        <AuthLayout pitch={PITCH} features={FEATURES}>
            <PlatformLoginForm demo={() => { platformSignIn(true); setSignedIn(true); }}
                onSubmit={async email => { if (email.toLowerCase() !== PLATFORM_OWNER.email) return 'This email is not a platform owner account.'; platformSignIn(true); setSignedIn(true); }} />
        </AuthLayout>
    );
    const s = getPlatformSession();
    return <Console source={localSource} account={{ name: s ? s.name : PLATFORM_OWNER.name, email: s ? s.email : PLATFORM_OWNER.email }} onLogout={() => { platformSignOut(); setSignedIn(false); }} />;
}

/* ---- Backend API: real passwords, MFA and companies on the server ---- */
type Stage = { kind: 'loading' } | { kind: 'login'; notice?: string } | { kind: 'step'; next: Exclude<AuthNext, 'done'> } | { kind: 'console'; account: Account };
interface Me { admin: { email: string; name: string; mfaEnabled: boolean; mustChangePassword: boolean }; mfaPassed: boolean }

function ApiPlatform() {
    const [stage, setStage] = useState<Stage>({ kind: 'loading' });
    // Where to go from the session the server reports
    const resume = useCallback(async (notice?: string) => {
        try {
            const me = await api.get<Me>('/platform/auth/me', { quiet401: true });
            if (!me.mfaPassed) setStage({ kind: 'step', next: me.admin.mfaEnabled ? 'mfa_verify' : 'mfa_enrol' });
            else if (me.admin.mustChangePassword) setStage({ kind: 'step', next: 'change_password' });
            else setStage({ kind: 'console', account: { name: me.admin.name, email: me.admin.email } });
        } catch (e) {
            setStage({ kind: 'login', notice: e instanceof ApiError && e.code === 'network' ? e.message : notice });
        }
    }, []);
    useEffect(() => { void resume(); }, [resume]);
    useEffect(() => onSessionEnded(() => setStage({ kind: 'login', notice: 'Your session ended. Sign in again.' })), []);
    useEffect(() => { if (stage.kind !== 'loading') setPath(stage.kind === 'console' ? '/platform' : '/platform/login'); }, [stage.kind]);
    const after = (next: AuthNext) => { if (next === 'done') void resume(); else setStage({ kind: 'step', next }); };
    const logout = async () => { try { await api.post('/platform/auth/logout'); } catch { /* signed out anyway */ } setStage({ kind: 'login', notice: 'You have been signed out.' }); };

    if (stage.kind === 'loading') return <div className="auth-splash"><span className="spinner" /> Loading…</div>;
    if (stage.kind === 'console') return <Console source={apiSource} account={stage.account} onLogout={() => void logout()} />;
    return (
        <AuthLayout pitch={PITCH} features={FEATURES}>
            {stage.kind === 'login' && <PlatformLoginForm notice={stage.notice} onSubmit={async (email, password) => {
                try { after((await api.post<{ next: AuthNext }>('/platform/auth/login', { email, password })).next); }
                catch (e) { return e instanceof Error ? e.message : 'Could not sign in.'; }
            }} />}
            {stage.kind === 'step' && stage.next === 'mfa_enrol' && <MfaEnrolStep base="/platform/auth" onDone={after} />}
            {stage.kind === 'step' && stage.next === 'mfa_verify' && <MfaVerifyStep base="/platform/auth" onDone={after} onBack={() => void logout()} />}
            {stage.kind === 'step' && stage.next === 'change_password' && <ChangePasswordStep base="/platform/auth" onDone={() => void resume()} />}
        </AuthLayout>
    );
}

/** The platform owner's console at /platform: sign in, see companies, add companies, make them active or inactive. */
export function PlatformApp() {
    useEscapeToClose();
    useEffect(() => { initTheme(); }, []);
    return (
        <>
            {USE_API ? <ApiPlatform /> : <LocalPlatform />}
            <ModalHost />
            <ToastHost />
            <PopoverHost />
        </>
    );
}
