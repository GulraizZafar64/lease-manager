import type { ScreenProps } from './registry';
import { addDays, addMonths } from '../domain/engine';
import { SETTINGS, type ErpConfig } from '../domain/settings';
import { Store } from '../domain/store';
import { AS_OF } from '../domain/state';
import { Ent, audit, guard, nameOf } from '../domain/enterprise';
import { ERP, entryKey, validateEntries } from '../domain/erp';
import { fxJournals, journalsFor } from '../domain/journals';
import { setParams } from '../domain/nav';
import { useAppState } from '../hooks/useAppState';
import { CommitInput } from '../components/ops/CommitInput';
import { exportFileUnchecked, saveFile, toCSV } from '../utils/files';
import { fmtNum, sum, uid } from '../utils/format';
import { fmtDate, fmtDateTime } from '../utils/dates';
import type { ExportRecord } from '../types/enterprise';

const EX_BADGE: Record<ExportRecord['status'], string> = { generated: 'pending', posted: 'ok', failed: 'bad' };
const EX_TEXT: Record<ExportRecord['status'], string> = { generated: 'Awaiting confirmation', posted: 'Posted', failed: 'Failed' };

type OptKey = Exclude<keyof ErpConfig, 'target'>;

export function ErpPage({ params: p }: ScreenProps<'erp'>) {
    useAppState();
    const cfg = SETTINGS.erp = SETTINGS.erp || { target: 'sap', company: '1000', docType: 'SA', journal: 'MISC', batch: 'LEASES', ledger: '', group: '' };
    // As in the original, the defaults are written into the view params on first render, so the
    // period stays fixed (changing From later does not move To).
    p.from = p.from || AS_OF.slice(0, 8) + '01'; p.to = p.to || addDays(addMonths(p.from, 1), -1); p.target = p.target || cfg.target; p.skipDup = p.skipDup ?? true; p.fx = p.fx ?? true;
    const { from, to, target, skipDup, fx: withFx } = p;
    const prof = ERP[target];
    let js = Store.leases.flatMap(l => journalsFor(l, from, to));
    if (withFx) js = js.concat(fxJournals(from, to));
    js.forEach(j => { j.key = entryKey(j); });
    const prior = new Map<string, ExportRecord>(); Ent.exports.items.filter(x => x.target === target && x.status !== 'failed').forEach(x => (x.keys || []).forEach(k => prior.set(k, x)));
    const dups = js.filter(j => prior.has(j.key || '')), fresh = skipDup ? js.filter(j => !prior.has(j.key || '')) : js;
    const errs = validateEntries(fresh), locked = SETTINGS.lockedThrough && to <= SETTINGS.lockedThrough;
    const hist = Ent.exports.items.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const opt = (k: OptKey, label: string) => <div className="fg"><label htmlFor={`o-${k}`}>{label}</label><CommitInput key={`${target}-${k}`} id={`o-${k}`} defaultValue={cfg[k]} onCommit={i => { cfg[k] = i.value; Store.saveSettings(); }} /></div>;

    const onGo = async () => {
        if (!guard('gl.export')) return;
        const name = `${target.toUpperCase()}_lease_journals_${from}_${to}`;
        let ok: boolean | undefined;
        if (prof.text) ok = await saveFile(`${name}.${prof.ext}`, prof.text(fresh));
        else if (prof.multi) ok = await exportFileUnchecked('xlsx', name, prof.sheets ? prof.sheets(fresh, cfg) : []);
        else ok = await saveFile(`${name}.csv`, '﻿' + toCSV(prof.rows ? prof.rows(fresh, cfg) : []));
        if (ok === false) return;
        const rec: ExportRecord = { id: uid('ex'), target, from, to, createdAt: new Date().toISOString(), createdBy: Store.actorId(), count: fresh.length, debits: sum(fresh, j => sum(j.lines, x => x.dr)), keys: fresh.map(j => j.key || ''), status: 'generated' };
        await Ent.exports.save(rec); audit('gl.export', `${prof.label}: ${rec.count} entries for ${from} to ${to}`);
    };
    const mark = (id: string, status: 'posted' | 'failed') => {
        if (!guard('gl.export')) return;
        const x = Ent.exports.get(id); if (!x) return;
        const notes = prompt(status === 'posted' ? 'ERP document or batch number (optional)' : 'What went wrong? (the entries can be sent again)') || '';
        x.status = status; x.notes = notes; x.markedBy = Store.actorId();
        Ent.exports.save(x).then(() => { audit('gl.sync', `${x.target} file ${x.id} marked ${status}${notes ? ': ' + notes : ''}`); });
    };

    return (
        <>
            <div className="banner"><div><strong>File-based integration</strong><p>Files are generated in each system’s import layout and tracked here until you confirm they are posted. Posting directly through ERP APIs needs credentials held on a server; see Administration › Integrations.</p></div></div>
            <div className="card" style={{ marginBottom: '16px' }}><div className="section-head"><div className="btn-row"><label style={{ margin: 0 }}>Target</label><select id="ex-t" style={{ width: 'auto' }} value={target} onChange={e => { cfg.target = e.target.value; setParams<'erp'>({ target: e.target.value }); }}>{Object.entries(ERP).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
                <label style={{ margin: 0 }}>From</label><CommitInput type="date" id="ex-f" key={`f-${from}`} defaultValue={from} style={{ width: '150px' }} onCommit={i => setParams<'erp'>({ from: i.value })} /><label style={{ margin: 0 }}>To</label><CommitInput type="date" id="ex-to" key={`t-${to}`} defaultValue={to} style={{ width: '150px' }} onCommit={i => setParams<'erp'>({ to: i.value })} /></div>
                <button className="btn" id="ex-go" disabled={!!errs.length || !fresh.length} onClick={onGo}>Generate file</button></div>
                <div className="pad"><p className="note">{prof.note}</p>
                    <div className="row4" style={{ marginTop: '10px' }}>{target === 'sap' ? <>{opt('company', 'Company code')}{opt('docType', 'Document type')}</> : null}{target === 'odoo' ? opt('journal', 'Journal') : null}{target === 'dynamics' ? opt('batch', 'Batch name') : null}{target === 'oracle' ? <>{opt('ledger', 'Ledger ID')}{opt('group', 'Group ID')}</> : null}</div>
                    <label className="check"><input type="checkbox" id="ex-dup" checked={skipDup} onChange={e => setParams<'erp'>({ skipDup: e.target.checked })} /> Leave out entries already sent to {prof.label} ({dups.length} found)</label>
                    <label className="check" style={{ marginTop: '6px' }}><input type="checkbox" id="ex-fx" checked={withFx} onChange={e => setParams<'erp'>({ fx: e.target.checked })} /> Include IAS 21 revaluation of foreign-currency lease balances</label>
                    <p style={{ marginTop: '12px' }}><strong>{fresh.length}</strong>{` entries, ${fresh.reduce((s, j) => s + j.lines.length, 0)} lines, debits ${fmtNum(sum(fresh, j => sum(j.lines, x => x.dr)))}.`}</p>
                    {locked ? <div className="banner warn"><div><strong>Closed period</strong><p>This period is locked (to {fmtDate(SETTINGS.lockedThrough)}). Exporting is allowed for re-sends; changes to the period are not.</p></div></div> : null}
                    {errs.length ? <div className="banner bad"><div><strong>{errs.length} problem{errs.length > 1 ? 's' : ''} to fix before export</strong><ul style={{ margin: '6px 0 0 18px' }}>{errs.slice(0, 8).map((e, i) => <li key={i}>{e}</li>)}</ul></div></div> : fresh.length ? <div className="banner ok"><div><strong>All entries balance and every account has a code.</strong></div></div> : null}</div></div>
            <div className="card"><div className="section-head"><h3>Sync monitor</h3><span className="note">Mark each file posted or failed once you have imported it.</span></div><div className="scroll-x"><table><thead><tr><th>Generated</th><th>Target</th><th>Period</th><th className="num">Entries</th><th className="num">Debits</th><th>By</th><th>Status</th><th>Notes</th><th></th></tr></thead><tbody>
                {hist.length ? hist.map(x => <tr key={x.id}><td>{fmtDateTime(x.createdAt)}</td><td>{(ERP[x.target] || { label: '' }).label || x.target}</td><td>{`${fmtDate(x.from)} to ${fmtDate(x.to)}`}</td><td className="num">{x.count}</td><td className="num">{fmtNum(x.debits)}</td><td>{nameOf(x.createdBy)}</td><td><span className={`badge badge-${EX_BADGE[x.status]}`}>{EX_TEXT[x.status]}</span></td><td className="wrap">{x.notes || ''}</td><td>{x.status === 'generated' ? <><button className="btn btn-sm" data-post={x.id} onClick={() => mark(x.id, 'posted')}>Posted</button>{' '}<button className="btn btn-danger btn-sm" data-fail={x.id} onClick={() => mark(x.id, 'failed')}>Failed</button></> : null}</td></tr>) : <tr><td colSpan={9} className="empty">No files generated yet.</td></tr>}
            </tbody></table></div><div className="table-note">Failed files are ignored by duplicate detection, so their entries can be sent again.</div></div>
        </>
    );
}
