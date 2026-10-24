/* Sign-in steps after the password, against the backend API: set up an authenticator
   app (MFA), enter a code, and replace a temporary password. Used by platform sign-in
   ('/platform/auth') and company sign-in ('/auth'). */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { ApiError, api } from '../../api/client';

export type AuthBase = '/auth' | '/platform/auth';
/** What the server asks for next after a sign-in step. */
export type AuthNext = 'mfa_enrol' | 'mfa_verify' | 'change_password' | 'done';

const message = (e: unknown, fallback: string) => e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;

function CodeField({ value, onChange, error, autoFocus = true }: { value: string; onChange: (v: string) => void; error?: string; autoFocus?: boolean }) {
    return (
        <div className="fg">
            <label htmlFor="mfa-code">6-digit code</label>
            <input id="mfa-code" className={`code-input${error ? ' invalid' : ''}`} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456"
                autoFocus={autoFocus} value={value} aria-invalid={!!error} onChange={e => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            {error ? <div className="auth-err">{error}</div> : <div className="hint">From your authenticator app. Codes change every 30 seconds.</div>}
        </div>
    );
}

/** First sign-in: link an authenticator app, then confirm with a code. */
export function MfaEnrolStep({ base, onDone }: { base: AuthBase; onDone: (next: AuthNext) => void }) {
    const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
    const [loadError, setLoadError] = useState('');
    const [code, setCode] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const started = useRef(false);
    useEffect(() => {
        if (started.current) return; // React StrictMode runs effects twice in development; one secret only
        started.current = true;
        api.post<{ secret: string; otpauthUrl: string }>(`${base}/mfa/setup`)
            .then(async r => setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 184 }) }))
            .catch(e => { if (e instanceof ApiError && e.code === 'mfa_exists') onDone('mfa_verify'); else setLoadError(message(e, 'Could not start set-up.')); });
    }, [base, onDone]);
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (code.length !== 6) return setError('Enter the 6-digit code.');
        setBusy(true); setError('');
        try { onDone((await api.post<{ next: AuthNext }>(`${base}/mfa/verify`, { code })).next); }
        catch (err) { setError(message(err, 'That code is not valid.')); setCode(''); }
        finally { setBusy(false); }
    };
    return (
        <form className="auth-card" onSubmit={submit} noValidate>
            <span className="pf-tag">Two-step sign-in</span>
            <h1>Set up two-step sign-in</h1>
            <p className="auth-sub">Each sign-in will ask for a code from an authenticator app on your phone, such as Microsoft Authenticator, Google Authenticator or 1Password.</p>
            {loadError && <div className="auth-err" role="alert">{loadError}</div>}
            {!setup && !loadError && <p className="note">Preparing…</p>}
            {setup && <>
                <ol className="mfa-steps">
                    <li>Open your authenticator app and add an account.</li>
                    <li>Scan this code, or enter the key below.</li>
                </ol>
                <div className="mfa-qr"><img src={setup.qr} width={184} height={184} alt="QR code for your authenticator app" /></div>
                <div className="mfa-key"><span>Key</span><code>{setup.secret.match(/.{1,4}/g)?.join(' ')}</code></div>
                <ol className="mfa-steps" start={3}><li>Enter the code the app shows.</li></ol>
                <CodeField value={code} onChange={v => { setCode(v); setError(''); }} error={error} autoFocus={false} />
                <button type="submit" className="btn auth-submit" disabled={busy}>{busy ? 'Checking…' : 'Verify and continue'}</button>
            </>}
        </form>
    );
}

/** Later sign-ins: the code from the authenticator app. */
export function MfaVerifyStep({ base, onDone, onBack }: { base: AuthBase; onDone: (next: AuthNext) => void; onBack: () => void }) {
    const [code, setCode] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (code.length !== 6) return setError('Enter the 6-digit code.');
        setBusy(true); setError('');
        try { onDone((await api.post<{ next: AuthNext }>(`${base}/mfa/verify`, { code })).next); }
        catch (err) { setError(message(err, 'That code is not valid.')); setCode(''); }
        finally { setBusy(false); }
    };
    return (
        <form className="auth-card" onSubmit={submit} noValidate>
            <h1>Enter your code</h1>
            <p className="auth-sub">Open your authenticator app and enter the 6-digit code for this account.</p>
            <CodeField value={code} onChange={v => { setCode(v); setError(''); }} error={error} />
            <button type="submit" className="btn auth-submit" disabled={busy}>{busy ? 'Checking…' : 'Verify'}</button>
            <p className="auth-alt"><button type="button" className="link-btn" onClick={onBack}>Use a different account</button></p>
            <p className="hint" style={{ textAlign: 'center' }}>Lost your phone? Ask an administrator to reset two-step sign-in.</p>
        </form>
    );
}

/** Replace a temporary password (first sign-in or after a reset). */
export function ChangePasswordStep({ base, onDone, minLength = 12 }: { base: AuthBase; onDone: () => void; minLength?: number }) {
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [confirm, setConfirm] = useState('');
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const errs: Record<string, string> = {};
        if (!current) errs.current = 'Enter the temporary password you were given.';
        if (next.length < minLength) errs.next = `Use at least ${minLength} characters.`;
        else if (next !== confirm) errs.confirm = 'The passwords do not match.';
        setErrors(errs);
        if (Object.keys(errs).length) return;
        setBusy(true);
        try { await api.post(`${base}/password`, { current, next }); onDone(); }
        catch (err) {
            const ae = err instanceof ApiError ? err : null;
            setErrors(ae && ae.code === 'bad_password' ? { current: ae.message } : { next: message(err, 'Could not change the password.') });
        } finally { setBusy(false); }
    };
    const field = (id: string, label: string, value: string, set: (v: string) => void, auto: string, hint?: string) => (
        <div className="fg">
            <label htmlFor={`pw-${id}`}>{label}</label>
            <input id={`pw-${id}`} type="password" autoComplete={auto} value={value} aria-invalid={!!errors[id]} onChange={e => { set(e.target.value); setErrors(o => ({ ...o, [id]: '' })); }} />
            {errors[id] ? <div className="auth-err">{errors[id]}</div> : hint ? <div className="hint">{hint}</div> : null}
        </div>
    );
    return (
        <form className="auth-card" onSubmit={submit} noValidate>
            <span className="pf-tag">New password</span>
            <h1>Choose your password</h1>
            <p className="auth-sub">Replace the temporary password with one only you know. Other devices signed in with the old one are signed out.</p>
            {field('current', 'Temporary password', current, setCurrent, 'current-password')}
            {field('next', 'New password', next, setNext, 'new-password', `At least ${minLength} characters; avoid common words and your name.`)}
            {field('confirm', 'Repeat new password', confirm, setConfirm, 'new-password')}
            <button type="submit" className="btn auth-submit" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
        </form>
    );
}
