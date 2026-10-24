import { useState } from 'react';
import { backupSource, browserSources, planMigration, runMigration, type BrowserSource, type MigrationPlan, type MigrationResult, type StepState } from '../../domain/migration';
import { roleLabel } from '../../domain/enterprise';
import { Modal, toast } from '../../utils/uiStore';
import { fmtDateTime } from '../../utils/dates';
import { decryptText } from './common';

type Stage = 'source' | 'checking' | 'preview' | 'running' | 'done';
const STEP_BADGE: Record<StepState['state'], [string, string]> = { waiting: ['neutral', 'Waiting'], running: ['pending', 'Working…'], done: ['ok', 'Done'], failed: ['bad', 'Stopped'] };
const count = (d: BrowserSource['data']) => [
    `${(d.leases || []).length} leases`, d.users && d.users.length ? `${d.users.length} people` : '', d.bank && d.bank.length ? `${d.bank.length} statements` : '',
    d.batches && d.batches.length ? `${d.batches.length} batches` : '', d.audit && d.audit.length ? `${d.audit.length} audit entries` : '',
].filter(Boolean).join(', ');

function Steps({ steps }: { steps: StepState[] }) {
    return <table className="mig-steps"><tbody>{steps.map(s => <tr key={s.label}><td>{s.label}</td><td><span className={`badge badge-${STEP_BADGE[s.state][0]}`}>{STEP_BADGE[s.state][1]}</span></td><td className="wrap note">{s.note || ''}</td></tr>)}</tbody></table>;
}

/** Bring a company's browser data to the server, once: choose where it is, check, confirm. */
function MigrationWizard() {
    const [sources] = useState(browserSources);
    const [pick, setPick] = useState(sources[0] ? sources[0].key : 'file');
    const [file, setFile] = useState<File | null>(null);
    const [pass, setPass] = useState('');
    const [stage, setStage] = useState<Stage>('source');
    const [err, setErr] = useState('');
    const [plan, setPlan] = useState<MigrationPlan | null>(null);
    const [settings, setSettings] = useState(true);
    const [addPeople, setAddPeople] = useState<Set<string>>(new Set());
    const [replace, setReplace] = useState(false);
    const [steps, setSteps] = useState<StepState[]>([]);
    const [result, setResult] = useState<MigrationResult | null>(null);

    const check = async () => {
        setErr('');
        try {
            let src: BrowserSource | undefined;
            if (pick === 'file') {
                if (!file) return setErr('Choose a backup file.');
                let d = JSON.parse(await file.text()) as Record<string, unknown>;
                if (d.cipher) { if (!pass) return setErr('This backup is encrypted. Enter its passphrase.'); d = JSON.parse(await decryptText({ salt: String(d.salt || ''), iv: String(d.iv || ''), data: String(d.data || '') }, pass)); }
                src = backupSource(file.name, d);
            } else src = sources.find(s => s.key === pick);
            if (!src) return;
            setStage('checking');
            const p = await planMigration(src);
            setPlan(p); setAddPeople(new Set(p.people.filter(x => x.add).map(x => x.user.id))); setStage('preview');
        } catch (e) {
            setStage('source');
            setErr(e instanceof Error && e.name === 'OperationError' ? 'Wrong passphrase.' : e instanceof SyntaxError ? 'That file is not a backup.' : e instanceof Error ? e.message : 'The data could not be checked.');
        }
    };
    const bring = async () => {
        if (!plan) return;
        setStage('running');
        const r = await runMigration(plan, { settings, addPeople, replaceExisting: replace }, setSteps);
        setResult(r); setStage('done');
    };
    const togglePerson = (id: string, on: boolean) => setAddPeople(prev => { const n = new Set(prev); if (on) n.add(id); else n.delete(id); return n; });
    const copy = (pw: string) => navigator.clipboard.writeText(pw).then(() => toast('Password copied'), () => toast('Select the password and copy it'));

    if (stage === 'source' || stage === 'checking') return (
        <>
            <p className="note">Leases, settings, people and records from the browser-only app (or the original lease manager page) are brought into this company on the server. Everything is checked first; nothing changes until you confirm.</p>
            <div className="mig-sources">
                {sources.map(s => <label key={s.key} className="check"><input type="radio" name="mig-src" value={s.key} checked={pick === s.key} onChange={() => setPick(s.key)} /> <span><b>{s.label}</b>, saved in this browser: {count(s.data)}{s.migrated ? <span className="note">{` (brought over on ${fmtDateTime(s.migrated.at)} by ${s.migrated.by})`}</span> : null}</span></label>)}
                {!sources.length ? <p className="note">No browser data was found at this address. Use a backup file downloaded from the browser app (Administration › Security and data, or Settings › Download backup).</p> : null}
                <label className="check"><input type="radio" name="mig-src" value="file" id="mig-file-opt" checked={pick === 'file'} onChange={() => setPick('file')} /> <span><b>A backup file</b> from the browser app</span></label>
            </div>
            {pick === 'file' ? <div className="row2"><div className="fg"><label htmlFor="mig-file">Backup file</label><input type="file" id="mig-file" accept=".json,.enc" onChange={e => setFile(e.target.files && e.target.files[0])} /></div><div className="fg"><label htmlFor="mig-pass">Passphrase (encrypted backups only)</label><input type="password" id="mig-pass" autoComplete="off" value={pass} onChange={e => setPass(e.target.value)} /></div></div> : null}
            {err ? <div className="banner bad"><div><p>{err}</p></div></div> : null}
            <div className="form-actions"><button className="btn btn-ghost" onClick={() => Modal.close()}>Cancel</button><button className="btn" id="mig-check" disabled={stage === 'checking'} onClick={check}>{stage === 'checking' ? <><span className="spinner"></span> Checking…</> : 'Check'}</button></div>
        </>
    );

    if (stage === 'preview' && plan) {
        const L = plan.leases, r = plan.records, bringing = L.ok.length + (replace ? L.existing.length : 0);
        return (
            <>
                {plan.source.migrated ? <div className="banner warn"><div><strong>Brought over before</strong><p>{`On ${fmtDateTime(plan.source.migrated.at)} by ${plan.source.migrated.by}. Running it again adds only what is not on the server yet.`}</p></div></div> : <div className="banner"><div><p>Nothing has changed yet. Check what will be brought over from <b>{plan.source.label}</b>.</p></div></div>}
                <h4 className="mig-h">Settings</h4>
                <label className="check"><input type="checkbox" id="mig-settings" checked={settings} onChange={e => setSettings(e.target.checked)} /> Use the browser app’s settings: accounting policies, approval policy, period lock, chart of accounts, rates, bank accounts and ERP options</label>
                <p className="note">{plan.entitiesToAdd.length ? `Entities to add: ${plan.entitiesToAdd.join(', ')}.` : 'Every entity is already here.'} Entities and dated rates are only added, never removed.{plan.rolesToAdd.length ? ` Custom roles to add: ${plan.rolesToAdd.map(x => x.label).join(', ')}.` : ''}</p>
                <h4 className="mig-h">People</h4>
                {plan.people.length ? <div className="scroll-x" style={{ maxHeight: '28vh' }}><table id="mig-people"><thead><tr><th>Name</th><th>Email</th><th>Role in the browser app</th><th>On the server</th></tr></thead><tbody>{plan.people.map(p => (
                    <tr key={p.user.id}><td>{p.user.name || p.user.label || ''}</td><td>{p.user.email || ''}</td><td>{(plan.source.data.roles || []).find(x => x.id === p.user.role)?.label || roleLabel(p.user.role)}</td>
                        <td>{p.server ? <span className="badge badge-ok">Has an account</span> : p.why && !p.user.email ? <span className="note">{p.why}</span> : <label className="check"><input type="checkbox" data-person={p.user.id} checked={addPeople.has(p.user.id)} onChange={e => togglePerson(p.user.id, e.target.checked)} /> Add, with a temporary password{p.why ? <span className="note">{` (${p.why})`}</span> : null}</label>}</td></tr>
                ))}</tbody></table></div> : <p className="note">No people in this data.</p>}
                <h4 className="mig-h">Leases</h4>
                <p id="mig-leases">{`${L.ok.length} new, ${L.existing.length} already on the server, ${L.problems.length} with problems.`}</p>
                {L.existing.length ? <div className="btn-row"><label className="check"><input type="radio" name="mig-dup" checked={!replace} onChange={() => setReplace(false)} /> Keep the server’s copy of {L.existing.join(', ')}</label><label className="check"><input type="radio" name="mig-dup" id="mig-replace" checked={replace} onChange={() => setReplace(true)} /> Replace it with the browser’s</label></div> : null}
                {L.problems.length ? <><p className="note">These stay in the browser; fix them there (or on the server afterwards) and run this again:</p><div className="scroll-x" style={{ maxHeight: '20vh' }}><table id="mig-problems"><tbody>{L.problems.map(x => <tr key={x.id}><td>{x.id}</td><td className="wrap">{x.message.replace(`${x.id}: `, '')}</td></tr>)}</tbody></table></div></> : null}
                <h4 className="mig-h">Records and history</h4>
                <p className="note">{`${r.bank} bank statements, ${r.batches} payment batches, ${r.exports} ERP files and ${r.drafts} drafts, added when not already here; batches and drafts that were approved need approving again. ${plan.auditEntries} audit log entries are kept as an archive, shown in the audit log.`}</p>
                <div className="form-actions"><button className="btn btn-ghost" onClick={() => setStage('source')}>Back</button><button className="btn" id="mig-go" disabled={!bringing && !settings && !addPeople.size && !r.bank && !r.batches && !r.exports && !r.drafts && !plan.auditEntries} onClick={bring}>Bring over</button></div>
            </>
        );
    }

    return (
        <>
            <Steps steps={steps} />
            {stage === 'done' && result ? <>
                <div className={`banner ${result.ok ? 'ok' : 'bad'}`}><div><strong>{result.ok ? 'Brought over' : 'Stopped'}</strong><p>{result.ok ? 'The company’s data is on the server. The browser copy is left as it was; keep it until you have checked the leases here.' : 'The steps marked done are on the server. Fix the reason shown and run this again: it adds only what is not there yet.'}</p></div></div>
                {result.passwords.length ? <><h4 className="mig-h">Temporary passwords</h4><p className="note"><b>Shown only now.</b> Send each person theirs securely, not in the same message as their email address. At sign-in they set up an authenticator app and choose their own password.</p>
                    <div className="scroll-x"><table id="mig-passwords"><tbody>{result.passwords.map(p => <tr key={p.email}><td>{p.name}</td><td>{p.email}</td><td><code>{p.password}</code></td><td><button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(p.password)}>Copy</button></td></tr>)}</tbody></table></div></> : null}
                <div className="form-actions"><button className="btn" id="mig-close" onClick={() => Modal.close()}>Close</button></div>
            </> : <p className="note"><span className="spinner"></span> Working… keep this window open.</p>}
        </>
    );
}

export function openMigration(): void {
    Modal.open('Bring data from the browser app', <MigrationWizard />, { wide: true });
}
