/* Company sign-in against the backend API (VITE_USE_API=true): password, then the company when
   one password opens several, then the authenticator code (set up on first sign-in) and, for a
   temporary password, a new one. The browser-only sign-in is LoginPage. */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, onSessionEnded } from '../api/client';
import { fetchMe, fullySignedIn, serverLogout, setSwitchTarget, switchTarget, type CompanyChoice, type Me } from '../api/auth';
import { ChangePasswordStep, MfaEnrolStep, MfaVerifyStep, type AuthNext } from '../components/auth/AuthSteps';
import { signIn } from '../domain/session';
import { AuthLayout, FEATURES, ICON, Icon, PasswordField } from './LoginPage';
import '../styles/login.css';

const PITCH = 'Lease accounting, from contract to disclosure.';
const NOTICES: Record<string, string> = {
    bye: 'You have been signed out.',
    expired: 'Your session expired after a period without activity, or was ended. Sign in again.',
    ended: 'You were signed out, for example in another tab. Sign in again.',
    disabled: 'Your account has been disabled. Ask an administrator of your company to enable it.',
    inactive: 'Your company’s account has been made inactive, so you were signed out. Contact your service provider to reactivate it.',
};

type LoginReply = { next: 'choose_company'; companies: CompanyChoice[] } | { next: AuthNext; company: CompanyChoice };
type Stage = { kind: 'loading' } | { kind: 'form' } | { kind: 'choose'; companies: CompanyChoice[] } | { kind: 'step'; next: Exclude<AuthNext, 'done'> };

const errorText = (e: unknown, fallback: string) => e instanceof ApiError ? (e.code === 'validation' ? 'Enter a valid email address and your password.' : e.message) : fallback;

export function ApiLoginPage({ onSignedIn }: { onSignedIn: () => void }) {
    const [target, setTarget] = useState(switchTarget);
    const [stage, setStage] = useState<Stage>({ kind: 'loading' });
    const [email, setEmail] = useState(target ? target.email : '');
    const [password, setPassword] = useState('');
    const [remember, setRemember] = useState(true);
    const rememberRef = useRef(remember);
    rememberRef.current = remember;
    const [companyId, setCompanyId] = useState(target ? target.companyId : '');
    const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
    const [formError, setFormError] = useState('');
    const [notice, setNotice] = useState(() => NOTICES[new URLSearchParams(window.location.search).get('reason') || ''] || '');
    const [busy, setBusy] = useState(false);
    const emailRef = useRef<HTMLInputElement>(null);
    const passRef = useRef<HTMLInputElement>(null);

    const finish = useCallback((m: Me) => {
        signIn(m.company.id, { id: m.user.id, name: m.user.name, email: m.user.email }, rememberRef.current);
        setSwitchTarget(null);
        onSignedIn();
    }, [onSignedIn]);

    // Where to go from the session the server reports (also after a reload part-way through sign-in)
    const resume = useCallback(async () => {
        try {
            const m = await fetchMe();
            if (fullySignedIn(m)) return finish(m);
            setStage({ kind: 'step', next: !m.mfaPassed ? (m.user.mfaEnabled ? 'mfa_verify' : 'mfa_enrol') : 'change_password' });
        } catch (e) {
            if (e instanceof ApiError && e.code === 'network') setFormError(e.message);
            setStage({ kind: 'form' });
        }
    }, [finish]);
    useEffect(() => { document.title = 'Sign in | IFRS 16 Lease Manager'; void resume(); }, [resume]);
    useEffect(() => { if (stage.kind === 'form') (target ? passRef : emailRef).current?.focus(); }, [stage.kind, target]);
    // The half-finished sign-in timed out or was locked: start again
    useEffect(() => onSessionEnded(e => { setNotice(e.code === 'company_inactive' ? NOTICES.inactive : 'Your sign-in timed out. Start again.'); setPassword(''); setStage({ kind: 'form' }); }), []);

    const after = (next: AuthNext) => { if (next === 'done') void resume(); else setStage({ kind: 'step', next }); };
    const login = async (chosen?: string) => {
        setBusy(true); setFormError('');
        try {
            const r = await api.post<LoginReply>('/auth/login', { email: email.trim(), password, remember, ...(chosen ? { companyId: chosen } : {}) });
            if (r.next === 'choose_company') setStage({ kind: 'choose', companies: r.companies });
            else after(r.next);
        } catch (e) {
            setFormError(errorText(e, 'Could not sign in.'));
            setStage({ kind: 'form' });
        } finally { setBusy(false); }
    };
    const submit = (e: FormEvent) => {
        e.preventDefault();
        const errs: typeof errors = {};
        if (!email.trim()) errs.email = 'Enter your email address.';
        else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errs.email = 'Enter a valid email address, like name@company.com.';
        if (!password) errs.password = 'Enter your password.';
        setErrors(errs); setNotice('');
        if (errs.email) return emailRef.current?.focus();
        if (errs.password) return passRef.current?.focus();
        void login(companyId || undefined);
    };
    const startOver = async () => { await serverLogout(); setPassword(''); setStage({ kind: 'form' }); };
    const anyCompany = () => { setSwitchTarget(null); setTarget(null); setCompanyId(''); };

    if (stage.kind === 'loading') return <div className="auth-splash"><span className="spinner" /> Loading…</div>;
    return (
        <AuthLayout pitch={PITCH} features={FEATURES}>
            {stage.kind === 'choose' && (
                <div className="auth-card">
                    <button type="button" className="auth-back" onClick={() => setStage({ kind: 'form' })}><Icon d={ICON.back} /> Back</button>
                    <h1>Choose a company</h1>
                    <p className="auth-sub">{email.trim().toLowerCase()} belongs to {stage.companies.length} companies.</p>
                    {formError && <div className="auth-error-box" role="alert">{formError}</div>}
                    <div className="auth-companies">
                        {stage.companies.map(c => (
                            <button key={c.id} type="button" className="auth-company" disabled={busy} onClick={() => { setCompanyId(c.id); void login(c.id); }}>
                                <span className="auth-company-ic"><Icon d={ICON.building} /></span>
                                <span className="auth-demo-text"><b>{c.name}</b><span>{c.code}</span></span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
            {stage.kind === 'step' && stage.next === 'mfa_enrol' && <MfaEnrolStep base="/auth" onDone={after} />}
            {stage.kind === 'step' && stage.next === 'mfa_verify' && <MfaVerifyStep base="/auth" onDone={after} onBack={() => void startOver()} />}
            {stage.kind === 'step' && stage.next === 'change_password' && <ChangePasswordStep base="/auth" onDone={() => void resume()} />}
            {stage.kind === 'form' && (
                <form className="auth-card" onSubmit={submit} noValidate>
                    <div className="auth-logo compact"><div className="brand-mark" aria-hidden="true">16</div><b>IFRS 16 Lease Manager</b></div>
                    <h1>{target && companyId ? `Sign in to ${target.companyName}` : 'Sign in'}</h1>
                    <p className="auth-sub">{target && companyId ? 'Each company has its own password and authenticator code.' : 'Welcome back. Sign in to your company’s lease workspace.'}</p>
                    {notice && <div className="auth-notice" role="status">{notice}</div>}
                    {formError && <div className="auth-error-box" role="alert">{formError}</div>}

                    <div className="fg">
                        <label htmlFor="login-email">Work email</label>
                        <div className={`auth-input${errors.email ? ' invalid' : ''}`}>
                            <Icon d={ICON.mail} />
                            <input id="login-email" ref={emailRef} type="email" autoComplete="username" placeholder="name@company.com" value={email}
                                aria-invalid={!!errors.email} aria-describedby={errors.email ? 'login-email-err' : undefined}
                                onChange={e => { setEmail(e.target.value); setFormError(''); if (errors.email) setErrors(o => ({ ...o, email: undefined })); }} />
                        </div>
                        {errors.email && <div className="auth-err" id="login-email-err">{errors.email}</div>}
                    </div>
                    <PasswordField value={password} inputRef={passRef} error={errors.password} onChange={v => { setPassword(v); setFormError(''); if (errors.password) setErrors(o => ({ ...o, password: undefined })); }} />

                    <label className="auth-check"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> Keep me signed in on this device</label>
                    <button type="submit" className="btn auth-submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
                    {target && companyId
                        ? <p className="auth-alt"><button type="button" className="link-btn" onClick={anyCompany}>Sign in to a different company</button></p>
                        : <p className="auth-alt">Platform owner? <a href="/platform">Sign in to the platform console</a></p>}
                </form>
            )}
        </AuthLayout>
    );
}
