import { useState, type FormEvent } from 'react';
import { CURRENCIES, CURRENCY_NAMES } from '../domain/settings';
import { slug, type NewCompany } from '../domain/platform';
import { ApiError } from '../api/client';
import { Modal, toast } from '../utils/uiStore';
import type { CreatedCompany, PlatformSource } from './source';

interface AdminDraft { name: string; email: string }

const copyText = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => toast(`${what} copied`), () => toast('Copy it from the box'));

function Created({ result, server }: { result: CreatedCompany; server: boolean }) {
    const { company, superAdmins } = result;
    const link = `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}/login`;
    return (
        <div className="pf-created">
            <div className="pf-created-icon" aria-hidden="true">✓</div>
            <h3>{company.name} is ready</h3>
            <p className="note">The company starts with empty data. Its super administrator{superAdmins.length > 1 ? 's' : ''} can sign in now and add users, roles and leases.</p>
            {server
                ? <div className="pf-temp-note" role="note"><b>Temporary passwords are shown only now.</b> Send each person theirs securely. At first sign-in they set up an authenticator app and choose their own password.</div>
                : null}
            <ul className="pf-admin-list">{superAdmins.map(a => (
                <li key={a.email}>
                    <div><b>{a.name}</b><span>{a.email}</span></div>
                    {a.temporaryPassword && <div className="pf-temp"><code>{a.temporaryPassword}</code><button type="button" className="btn btn-ghost btn-sm" onClick={() => copyText(a.temporaryPassword || '', 'Password')}>Copy</button></div>}
                </li>
            ))}</ul>
            <label className="pf-label" htmlFor="pf-link">Sign-in link</label>
            <div className="pf-copy"><input id="pf-link" readOnly value={link} onFocus={e => e.currentTarget.select()} /><button type="button" className="btn btn-ghost" onClick={() => copyText(link, 'Link')}>Copy</button></div>
            {!server && <p className="hint">They sign in with the email above. Passwords are not checked until sign-in runs on a server.</p>}
            <div className="form-actions"><button type="button" className="btn" onClick={() => Modal.close()}>Done</button></div>
        </div>
    );
}

/** Platform console › Add company. */
export function CompanyForm({ source, onCreated }: { source: PlatformSource; onCreated: () => void }) {
    const [name, setName] = useState('');
    const [code, setCode] = useState('');
    const [codeEdited, setCodeEdited] = useState(false);
    const [currency, setCurrency] = useState('PKR');
    const [admins, setAdmins] = useState<AdminDraft[]>([{ name: '', email: '' }]);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState<CreatedCompany | null>(null);

    if (done) return <Created result={done} server={source.server} />;

    const clear = (...keys: string[]) => setErrors(e => { const n = { ...e }; keys.forEach(k => delete n[k]); return n; });
    const setAdmin = (i: number, patch: Partial<AdminDraft>) => { setAdmins(list => list.map((a, j) => j === i ? { ...a, ...patch } : a)); clear(patch.name !== undefined ? `name${i}` : `email${i}`, ''); };
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const draft: NewCompany = { name, code: code || slug(name), currency, admins };
        const errs = source.problems(draft);
        setErrors(errs);
        if (Object.keys(errs).length) return;
        setBusy(true);
        try { setDone(await source.create(draft)); onCreated(); }
        catch (err) {
            const ae = err instanceof ApiError ? err : null;
            if (ae && ae.code === 'duplicate_code') setErrors({ code: ae.message });
            else if (ae && ae.code === 'duplicate_name') setErrors({ name: ae.message });
            else setErrors({ '': err instanceof Error ? err.message : 'Could not create the company.' });
        } finally { setBusy(false); }
    };

    return (
        <form className="pf-form" onSubmit={submit} noValidate>
            <div className="row2">
                <div className="fg"><label htmlFor="cf-name">Company name <span className="req">*</span></label>
                    <input id="cf-name" autoFocus value={name} placeholder="e.g. Acme Holdings Ltd" onChange={e => { setName(e.target.value); if (!codeEdited) setCode(slug(e.target.value)); clear('name', 'code'); }} aria-invalid={!!errors.name} />
                    {errors.name ? <div className="field-err">{errors.name}</div> : <div className="hint">Also used as the company’s first reporting entity.</div>}</div>
                <div className="fg"><label htmlFor="cf-code">Company code <span className="req">*</span></label>
                    <input id="cf-code" value={code} placeholder="acme" onChange={e => { setCode(e.target.value); setCodeEdited(true); clear('code'); }} aria-invalid={!!errors.code} />
                    {errors.code ? <div className="field-err">{errors.code}</div> : <div className="hint">Short and unique; letters, numbers and dashes.</div>}</div>
            </div>
            <div className="fg" style={{ maxWidth: '50%' }}><label htmlFor="cf-ccy">Functional currency</label>
                <select id="cf-ccy" value={currency} onChange={e => setCurrency(e.target.value)}>{CURRENCIES.map(c => <option key={c} value={c}>{c} – {CURRENCY_NAMES[c]}</option>)}</select></div>

            <fieldset className="pf-admins"><legend>Super administrators</legend>
                <p className="hint" style={{ marginTop: 0, marginBottom: '10px' }}>They run the company: users, roles, settings and approvals. Add one or more.</p>
                {admins.map((a, i) => (
                    <div key={i} className="pf-admin-row">
                        <div className="fg"><label htmlFor={`cf-an-${i}`}>Full name</label><input id={`cf-an-${i}`} value={a.name} onChange={e => setAdmin(i, { name: e.target.value })} aria-invalid={!!errors[`name${i}`]} />{errors[`name${i}`] && <div className="field-err">{errors[`name${i}`]}</div>}</div>
                        <div className="fg"><label htmlFor={`cf-ae-${i}`}>Email</label><input id={`cf-ae-${i}`} type="email" value={a.email} placeholder="name@company.com" onChange={e => setAdmin(i, { email: e.target.value })} aria-invalid={!!errors[`email${i}`]} />{errors[`email${i}`] && <div className="field-err">{errors[`email${i}`]}</div>}</div>
                        <button type="button" className="btn btn-ghost btn-sm pf-remove" aria-label={`Remove super administrator ${i + 1}`} disabled={admins.length === 1} onClick={() => setAdmins(list => list.filter((_, j) => j !== i))}>Remove</button>
                    </div>
                ))}
                {errors[''] && <div className="field-err">{errors['']}</div>}
                <button type="button" className="link-btn pf-add-admin" onClick={() => setAdmins(list => list.concat([{ name: '', email: '' }]))}>+ Add another super administrator</button>
            </fieldset>

            <div className="form-actions">
                <button type="button" className="btn btn-ghost" onClick={() => Modal.close()}>Cancel</button>
                <button type="submit" className="btn" disabled={busy}>{busy ? 'Creating…' : 'Create company'}</button>
            </div>
        </form>
    );
}
