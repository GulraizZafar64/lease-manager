import { useRef, useState, type ChangeEvent } from 'react';
import { addMonths, num } from '../../domain/engine';
import { SETTINGS, type AppSettings } from '../../domain/settings';
import { Store } from '../../domain/store';
import { companyKey } from '../../domain/platform';
import { Ent, audit, guard, loadAudit, logHistory, realRole, type Collection } from '../../domain/enterprise';
import { blankLease, blankTerms } from '../../domain/lease';
import { go } from '../../domain/nav';
import { useAppState } from '../../hooks/useAppState';
import { confirmDialog } from '../common/ConfirmDialog';
import { Modal, toast } from '../../utils/uiStore';
import { saveFile } from '../../utils/files';
import { fmtDate, fmtDateTime, todayISO } from '../../utils/dates';
import { decryptText, encryptText, leasesToXML, saveSettingsAudited, type EncryptedBackup } from './common';
import { companyBackupText, restoreToServer, type BackupData } from '../../domain/serverBackup';
import { purgeServerAudit } from '../../api/records';
import { openMigration } from './MigrationWizard';
import type { Lease } from '../../types/lease';

type BackupKey = 'users' | 'batches' | 'exports' | 'drafts' | 'bank';
type Backup = { leases?: unknown; settings?: Partial<AppSettings>; cipher?: string } & Partial<Record<BackupKey, { id: string }[]>> & Partial<EncryptedBackup>;

/* ---- Portfolio exchange: JSON import ---- */
function ImportLeasesModal({ valid, skipped, dupIds, fileName, done }: { valid: Lease[]; skipped: number; dupIds: string[]; fileName: string; done: (n: number) => void }) {
    const [dup, setDup] = useState<'skip' | 'replace'>('skip');
    const ok = async () => {
        const rep = dupIds.length > 0 && dup === 'replace'; let n = 0;
        for (const l of valid) { if (dupIds.includes(l.id) && !rep) continue; const x: Lease = Object.assign(blankLease(), l, { terms: Object.assign(blankTerms(), l.terms) }); if (x.status === 'active' && SETTINGS.requireApproval && !dupIds.includes(l.id)) x.status = 'pending'; logHistory(x, `Imported from ${fileName}`); if (await Store.save(x)) n++; }
        Modal.close(); toast(`${n} leases imported`); audit('lease.import', `${n} leases from ${fileName}`); done(n); go('register', {}, { reset: true });
    };
    return (
        <>
            <p>{`${valid.length} leases in ${fileName}${skipped ? `; ${skipped} rows without an ID, terms or commencement date are skipped` : ''}.`}</p>
            {dupIds.length ? <><p className="note" style={{ marginTop: '8px' }}>{`${dupIds.length} IDs already exist: ${dupIds.slice(0, 12).join(', ')}${dupIds.length > 12 ? '…' : ''}`}</p><label className="check" style={{ marginTop: '8px' }}><input type="radio" name="dup" value="skip" checked={dup === 'skip'} onChange={() => setDup('skip')} /> Skip existing IDs</label><label className="check"><input type="radio" name="dup" value="replace" checked={dup === 'replace'} onChange={() => setDup('replace')} /> Replace existing leases</label></> : null}
            <p className="note" style={{ marginTop: '8px' }}>Imported leases are {SETTINGS.requireApproval ? 'submitted for approval' : 'activated'} unless they are drafts.</p>
            <div className="form-actions"><button className="btn btn-ghost" onClick={() => Modal.close()}>Cancel</button><button className="btn" id="ij-ok" onClick={ok}>Import</button></div>
        </>
    );
}
async function importLeaseJSON(text: string, fileName: string): Promise<number> {
    const d = JSON.parse(text) as unknown, list = Array.isArray(d) ? d : (d as { leases?: unknown } | null)?.leases;
    if (!Array.isArray(list)) throw new Error('No leases array');
    const valid = (list as Lease[]).filter(l => l && l.id && l.terms && l.terms.commencement);
    const dupIds = valid.filter(l => Store.all.some(x => x.id === l.id)).map(l => l.id);
    return new Promise(res => {
        Modal.open('Import leases', <ImportLeasesModal valid={valid} skipped={list.length - valid.length} dupIds={dupIds} fileName={fileName} done={res} />);
    });
}

/** Administration › Security and data. */
export function SecurityTab() {
    useAppState();
    const ret = SETTINGS.retention = SETTINGS.retention || { auditYears: 10, idleMinutes: 30 };
    const [idle, setIdle] = useState(String(ret.idleMinutes ?? 30));
    const [years, setYears] = useState(String(ret.auditYears));
    const [pass, setPass] = useState('');
    const fileRef = useRef<HTMLInputElement>(null), ifileRef = useRef<HTMLInputElement>(null);

    const onSave = async () => { if (!guard('admin.data')) return; ret.auditYears = Math.max(1, num(years)); ret.idleMinutes = Math.max(0, num(idle)); await saveSettingsAudited(`Retention ${ret.auditYears} years; idle lock ${ret.idleMinutes} min`); };
    const onPurge = () => {
        if (!guard('admin.data')) return;
        const cutoff = addMonths(todayISO(), -12 * Math.max(1, num(years)));
        confirmDialog('Purge audit log', `Delete audit entries dated before ${fmtDate(cutoff)}? This cannot be undone.`, 'Purge', async () => {
            // On the server: only past the retention period saved for the company; the purge is logged there
            if (Store.mode === 'api') { try { toast(`${await purgeServerAudit(cutoff)} entries purged`); } catch (e) { toast(e instanceof Error ? e.message : 'Not purged.'); } return; }
            const all = await loadAudit(5000), old = all.filter(a => a.at.slice(0, 10) < cutoff);
            for (const a of old) { if (Store.mode === 'db' && Store.db) await Store.db.doc(`ws/main/audit/${a.id}`).delete().catch(() => { }); }
            if (Store.mode !== 'db') { try { localStorage.setItem(companyKey('audit'), JSON.stringify(all.filter(a => a.at.slice(0, 10) >= cutoff).reverse())); } catch { /* storage unavailable */ } }
            await audit('retention.purge', `${old.length} audit entries before ${cutoff} deleted`); toast(`${old.length} entries purged`);
        });
    };
    const payload = () => JSON.stringify({ version: 3, exported: new Date().toISOString(), by: Store.actorName(), settings: SETTINGS, leases: Store.all, users: Ent.users.items, batches: Ent.batches.items, exports: Ent.exports.items, drafts: Ent.drafts.items, bank: Ent.bank.items });
    const stamp = async () => { SETTINGS.lastBackup = new Date().toISOString(); SETTINGS.lastBackupBy = Store.actorName(); await Store.saveSettings(); audit('backup', 'Backup downloaded'); };
    // Signed in through the API: the server's export of the whole company
    const backupText = async (): Promise<string | null> => { if (Store.mode !== 'api') return payload(); try { return await companyBackupText(); } catch (e) { toast(e instanceof Error ? e.message : 'The backup could not be made.'); return null; } };
    const onPlain = async () => { if (!guard('admin.data')) return; const text = await backupText(); if (text !== null && await saveFile(`IFRS16_backup_${todayISO()}.json`, text)) stamp(); };
    const onEnc = async () => { if (!guard('admin.data')) return; const pw = pass; if (pw.length < 12) return toast('Use a passphrase of at least 12 characters.'); const text = await backupText(); if (text === null) return; const enc = await encryptText(text, pw); if (await saveFile(`IFRS16_backup_${todayISO()}.json`, JSON.stringify(enc))) stamp(); };
    const onRestoreFile = async (e: ChangeEvent<HTMLInputElement>) => {
        const input = e.target, f = input.files && input.files[0]; if (!f) return;
        input.value = ''; // the original rebuilt the input on every render, so the same file could be chosen again
        try {
            let d = JSON.parse(await f.text()) as Backup;
            if (d.cipher) d = JSON.parse(await decryptText({ salt: d.salt || '', iv: d.iv || '', data: d.data || '' }, pass)) as Backup;
            const leases = d.leases;
            if (!Array.isArray(leases)) throw new Error('no leases');
            const data = d;
            if (Store.mode === 'api') {
                confirmDialog('Restore backup', `Restore ${leases.length} leases from ${f.name}? Leases with the same ID are replaced; bank statements, batches, ERP files and drafts are added when they are not already on the server.`, 'Restore', async () => {
                    toast(await restoreToServer(data as BackupData, f.name)); go('dashboard', {}, { reset: true });
                }, false);
                return;
            }
            confirmDialog('Restore backup', `Restore ${leases.length} leases${data.users ? `, ${data.users.length} users` : ''} from ${f.name}? Items with the same ID are replaced; others are kept.`, 'Restore', async () => {
                for (const l of leases as Lease[]) await Store.save(l);
                for (const k of ['users', 'batches', 'exports', 'drafts', 'bank'] as BackupKey[]) { const c = Ent[k] as Collection<{ id: string }>; for (const x of data[k] || []) await c.save(x).catch(() => { }); }
                if (data.settings) { Object.assign(SETTINGS, data.settings); await Store.saveSettings(); }
                await audit('restore', `Backup ${f.name} restored`); toast('Backup restored'); go('dashboard', {}, { reset: true });
            }, false);
        } catch (err) { toast(err instanceof Error && err.name === 'OperationError' ? 'Wrong passphrase.' : 'That file is not a valid backup.'); }
    };
    const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
        const input = e.target, f = input.files && input.files[0]; if (!f) return;
        input.value = '';
        try { await importLeaseJSON(await f.text(), f.name); } catch { toast('That file has no leases in a recognised format.'); }
    };

    return (
        <>
            <h3>Session</h3><div className="row3"><div className="fg"><label htmlFor="se-idle">Lock the screen after inactivity (minutes, 0 = never)</label><input type="number" id="se-idle" value={idle} onChange={e => setIdle(e.target.value)} /></div><div></div><div></div></div>
            <h3>Data retention</h3><div className="row3"><div className="fg"><label htmlFor="se-ret">Keep audit log entries for (years)</label><input type="number" id="se-ret" value={years} onChange={e => setYears(e.target.value)} /><div className="hint">Companies Act 2017 and tax law in Pakistan generally require records for at least 10 years; check your own obligations.</div></div><div className="fg"><label>&nbsp;</label><button className="btn btn-ghost" id="se-purge" onClick={onPurge}>Purge entries older than this</button></div><div></div></div>
            <div className="form-actions"><button className="btn" id="se-save" onClick={onSave}>Save</button></div>
            <h3>Backups and recovery</h3><p className="note" style={{ marginBottom: '10px' }}>{Store.mode === 'api' ? 'Your company’s data is kept on its server. A backup downloads all of it: settings, entities and rates, leases with their changes and payments, bank statements, batches, ERP files, drafts, users (without passwords or sign-in secrets) and the audit log.' : 'The shared workspace is stored by the Claude platform.'} Keep your own periodic backups as part of your disaster recovery plan: encrypted backups use AES-256-GCM with a key derived from your passphrase (PBKDF2, 250,000 iterations); the passphrase is never stored, so keep it safe.</p>
            <div className="row3"><div className="fg"><label htmlFor="se-pass">Backup passphrase</label><input type="password" id="se-pass" autoComplete="new-password" placeholder="At least 12 characters" value={pass} onChange={e => setPass(e.target.value)} /></div><div className="fg"><label>&nbsp;</label><div className="btn-row"><button className="btn" id="se-enc" onClick={onEnc}>Download encrypted backup</button><button className="btn btn-ghost" id="se-plain" onClick={onPlain}>Unencrypted JSON</button></div></div><div className="fg"><label>&nbsp;</label><button className="btn btn-ghost" id="se-restore" onClick={() => { if (guard('admin.data')) fileRef.current?.click(); }}>Restore a backup</button><input type="file" id="se-file" ref={fileRef} hidden accept=".json,.enc" onChange={onRestoreFile} /></div></div>
            <p className="note">Last backup: {SETTINGS.lastBackup ? fmtDateTime(SETTINGS.lastBackup) + ' by ' + (SETTINGS.lastBackupBy || '') : 'never'}.</p>
            <h3 style={{ marginTop: '14px' }}>Portfolio exchange</h3><div className="btn-row"><button className="btn btn-ghost" id="se-xml" onClick={() => { if (guard('report.export')) saveFile(`Leases_${todayISO()}.xml`, leasesToXML(Store.all)).then(ok => { if (ok) audit('export', 'Leases exported as XML'); }); }}>Export leases as XML</button><button className="btn btn-ghost" id="se-imp" onClick={() => { if (guard('lease.import')) ifileRef.current?.click(); }}>Import leases from JSON</button><input type="file" id="se-ifile" ref={ifileRef} hidden accept=".json" onChange={onImportFile} /></div>
            {Store.mode === 'api' ? <><h3 style={{ marginTop: '14px' }}>Moving from the browser app</h3><p className="note" style={{ marginBottom: '10px' }}>Bring a company’s leases, settings, people, records and audit log from the browser-only app (or the original lease manager page) to the server, once. Everything is checked first; nothing changes until you confirm. Needs a super administrator.</p>
                <div className="btn-row"><button className="btn btn-ghost" id="se-migrate" onClick={() => { if (realRole() === 'superadmin') openMigration(); else toast('Only a super administrator can bring data from the browser app.'); }}>Bring data from the browser app</button></div></> : null}
        </>
    );
}
