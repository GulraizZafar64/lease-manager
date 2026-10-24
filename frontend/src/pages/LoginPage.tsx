import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { signIn } from '../domain/session';
import { roleLabel } from '../domain/enterprise';
import { allActiveAccounts, findAccounts, isCompanyActive, type Account } from '../domain/platform';
import { userName } from '../domain/directory';
import '../styles/login.css';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const Icon = ({ d }: { d: string }) => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
export const ICON = {
    mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6',
    lock: 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM7 11V7a5 5 0 0 1 10 0v4',
    eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    eyeOff: 'M17.9 17.9A10.1 10.1 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9.1 9.1 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2M1 1l22 22',
    check: 'M20 6 9 17l-5-5',
    info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
    building: 'M3 21h18M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1',
    back: 'M19 12H5M12 19l-7-7 7-7',
};

export const FEATURES = [
    'Lease register, measurement and remeasurement',
    'Journals, payments and ERP-ready exports',
    'Disclosures, analytics and audit trail',
];
const initials = (name: string) => name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

/** Two-panel sign-in layout shared by company and platform sign-in. */
export function AuthLayout({ pitch, features, children }: { pitch: string; features: string[]; children: ReactNode }) {
    return (
        <div className="auth">
            <aside className="auth-brand">
                <div className="auth-logo"><div className="brand-mark" aria-hidden="true">16</div><div><b>IFRS 16 Lease Manager</b><span>Lessee and lessor accounting</span></div></div>
                <div className="auth-pitch">
                    <h2>{pitch}</h2>
                    <ul>{features.map(f => <li key={f}><span className="auth-tick"><Icon d={ICON.check} /></span>{f}</li>)}</ul>
                </div>
                <p className="auth-foot">Figures are only as good as the inputs and judgements. Review before posting.</p>
            </aside>
            <main className="auth-main">{children}</main>
        </div>
    );
}

export function PasswordField({ value, onChange, error, inputRef }: { value: string; onChange: (v: string) => void; error?: string; inputRef?: RefObject<HTMLInputElement> }) {
    const [show, setShow] = useState(false);
    return (
        <div className="fg">
            <label htmlFor="login-pass">Password</label>
            <div className={`auth-input${error ? ' invalid' : ''}`}>
                <Icon d={ICON.lock} />
                <input id="login-pass" ref={inputRef} type={show ? 'text' : 'password'} autoComplete="current-password" placeholder="Your password" value={value}
                    aria-invalid={!!error} aria-describedby={error ? 'login-pass-err' : undefined} onChange={e => onChange(e.target.value)} />
                <button type="button" className="auth-eye" aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show} onClick={() => setShow(v => !v)}>
                    <Icon d={show ? ICON.eyeOff : ICON.eye} />
                </button>
            </div>
            {error && <div className="auth-err" id="login-pass-err">{error}</div>}
        </div>
    );
}

const NOTICES: Record<string, string> = {
    bye: 'You have been signed out.',
    disabled: 'Your account is disabled. Ask an administrator of your company to enable it.',
    missing: 'Your account no longer exists. Sign in again or ask your company’s administrator.',
    company: 'Your company is no longer available. Contact your service provider.',
    inactive: 'Your company’s account has been made inactive, so you were signed out. Contact your service provider to reactivate it.',
};

/** Company sign-in: the email finds the company; someone in several companies picks one. */
export function LoginPage({ onSignedIn }: { onSignedIn: (a: Account) => void }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [remember, setRemember] = useState(true);
    const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
    const [choices, setChoices] = useState<Account[] | null>(null);
    const emailRef = useRef<HTMLInputElement>(null);
    const passRef = useRef<HTMLInputElement>(null);
    const notice = NOTICES[new URLSearchParams(window.location.search).get('reason') || ''];

    useEffect(() => { document.title = 'Sign in | IFRS 16 Lease Manager'; emailRef.current?.focus(); }, []);

    const finish = (a: Account) => { signIn(a.company.id, { id: a.user.id, name: userName(a.user), email: a.user.email }, remember); onSignedIn(a); };
    const demo = allActiveAccounts();
    const multiCompany = new Set(demo.map(a => a.company.id)).size > 1;

    const submit = (e: FormEvent) => {
        e.preventDefault();
        const errs: { email?: string; password?: string } = {};
        if (!email.trim()) errs.email = 'Enter your email address.';
        else if (!EMAIL_RE.test(email.trim())) errs.email = 'Enter a valid email address, like name@company.com.';
        if (!password) errs.password = 'Enter your password.';
        const accounts = errs.email ? [] : findAccounts(email);
        const open = accounts.filter(a => isCompanyActive(a.company));
        const active = open.filter(a => a.user.status === 'active');
        if (!errs.email && !accounts.length) errs.email = 'There is no user with this email. Ask your company’s administrator to add you.';
        else if (!errs.email && !open.length) errs.email = 'Your company’s account is inactive. Contact your service provider to reactivate it.';
        else if (!errs.email && !active.length) errs.email = 'This account is disabled. Ask your company’s administrator to enable it.';
        setErrors(errs);
        if (errs.email) { emailRef.current?.focus(); return; }
        if (errs.password) { passRef.current?.focus(); return; }
        if (active.length === 1) finish(active[0]); else setChoices(active);
    };

    if (choices) return (
        <AuthLayout pitch="Lease accounting, from contract to disclosure." features={FEATURES}>
            <div className="auth-card">
                <button type="button" className="auth-back" onClick={() => setChoices(null)}><Icon d={ICON.back} /> Back</button>
                <h1>Choose a company</h1>
                <p className="auth-sub">{email.trim().toLowerCase()} belongs to {choices.length} companies.</p>
                <div className="auth-companies">
                    {choices.map(a => (
                        <button key={a.company.id} type="button" className="auth-company" onClick={() => finish(a)}>
                            <span className="auth-company-ic"><Icon d={ICON.building} /></span>
                            <span className="auth-demo-text"><b>{a.company.name}</b><span>{roleLabel(a.user.role)}</span></span>
                        </button>
                    ))}
                </div>
            </div>
        </AuthLayout>
    );

    return (
        <AuthLayout pitch="Lease accounting, from contract to disclosure." features={FEATURES}>
            <form className="auth-card" onSubmit={submit} noValidate>
                <div className="auth-logo compact"><div className="brand-mark" aria-hidden="true">16</div><b>IFRS 16 Lease Manager</b></div>
                <h1>Sign in</h1>
                <p className="auth-sub">Welcome back. Sign in to your company’s lease workspace.</p>
                {notice && <div className="auth-notice" role="status">{notice}</div>}

                <div className="fg">
                    <label htmlFor="login-email">Work email</label>
                    <div className={`auth-input${errors.email ? ' invalid' : ''}`}>
                        <Icon d={ICON.mail} />
                        <input id="login-email" ref={emailRef} type="email" autoComplete="username" placeholder="name@company.com" value={email}
                            aria-invalid={!!errors.email} aria-describedby={errors.email ? 'login-email-err' : undefined}
                            onChange={e => { setEmail(e.target.value); if (errors.email) setErrors(o => ({ ...o, email: undefined })); }} />
                    </div>
                    {errors.email && <div className="auth-err" id="login-email-err">{errors.email}</div>}
                </div>
                <PasswordField value={password} inputRef={passRef} error={errors.password} onChange={v => { setPassword(v); if (errors.password) setErrors(o => ({ ...o, password: undefined })); }} />

                <label className="auth-check"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> Keep me signed in on this device</label>
                <button type="submit" className="btn auth-submit">Sign in</button>

                {demo.length ? <>
                    <div className="auth-or"><span>or use a demo account</span></div>
                    <div className="auth-demos" role="list">
                        {demo.map(a => (
                            <button type="button" role="listitem" key={a.company.id + a.user.id} className="auth-demo-user" onClick={() => finish(a)} title={`Sign in as ${userName(a.user)}${multiCompany ? ' at ' + a.company.name : ''}`}>
                                <span className="who-avatar" aria-hidden="true">{initials(userName(a.user))}</span>
                                <span className="auth-demo-text"><b>{userName(a.user)}</b><span>{roleLabel(a.user.role)}{multiCompany ? ` · ${a.company.name}` : ''}</span></span>
                            </button>
                        ))}
                    </div>
                </> : null}

                <div className="auth-note" role="note">
                    <Icon d={ICON.info} />
                    <p>Interface preview: passwords are not checked yet. Sign in with the email of any active user, or pick a demo account. You get that user’s company, role and permissions. Everything is kept in this browser only.</p>
                </div>
                <p className="auth-alt">Platform owner? <a href="/platform">Sign in to the platform console</a></p>
            </form>
        </AuthLayout>
    );
}
