import { useRef, useState, type ChangeEvent, type MouseEvent } from 'react';
import type { ScreenProps } from './registry';
import { SETTINGS } from '../domain/settings';
import { Store } from '../domain/store';
import { Ent, audit, gate, guard } from '../domain/enterprise';
import { autoReconcile, hash, readStatementFile, reconCandidates, recordMatch } from '../domain/banking';
import { paymentRows } from '../domain/payments';
import { go, setParams } from '../domain/nav';
import { useAppState } from '../hooks/useAppState';
import { exportMenu } from '../components/common/ExportMenu';
import { confirmDialog } from '../components/common/ConfirmDialog';
import { Modal, toast } from '../utils/uiStore';
import { fmtNum, uid } from '../utils/format';
import { fmtDate } from '../utils/dates';
import type { BankLine, BankLineStatus, BankStatement } from '../types/enterprise';

const STATUS_BADGE: Record<BankLineStatus, string> = { matched: 'ok', suggested: 'pending', unmatched: 'bad', ignored: 'neutral' };
const STATUS_TEXT: Record<BankLineStatus, string> = { matched: 'Matched', suggested: 'Suggested', unmatched: 'Unmatched', ignored: 'Not lease' };

/** “Match…”: pick the instalment a bank line pays. */
function MatchModal({ stmt, line, onSave }: { stmt: BankStatement; line: BankLine; onSave: () => Promise<void> }) {
    const [list] = useState(() => {
        const c = reconCandidates(line), open = paymentRows().filter(r => r.status !== 'paid');
        return c.length ? c.map(x => x.row) : open;
    });
    const shown = list.slice(0, 200);
    const [sel, setSel] = useState(shown[0] ? shown[0].key : '');
    const ok = async () => { const r = paymentRows().find(x => x.key === sel); if (r && await recordMatch(stmt, line, r, false)) { Modal.close(); await onSave(); } };
    return (
        <>
            <p>{fmtDate(line.date)}, {fmtNum(line.amount)}: {line.desc}</p>
            <div className="fg" style={{ marginTop: '12px' }}><label htmlFor="mt-sel">Instalment</label><select id="mt-sel" value={sel} onChange={e => setSel(e.target.value)}>{shown.map(r => <option key={r.key} value={r.key}>{`${r.leaseId} due ${fmtDate(r.dueDate)}: ${fmtNum(r.outstanding || r.amount)} ${r.status === 'paid' ? '(already recorded)' : ''}`}</option>)}</select></div>
            <div className="form-actions"><button className="btn btn-ghost" onClick={() => Modal.close()}>Cancel</button><button className="btn" id="mt-ok" onClick={ok}>Match</button></div>
        </>
    );
}

/** Progress of a statement's reconciliation: one bar split by line status, each part labelled in the legend. */
function ReconMeter({ parts }: { parts: [key: string, label: string, n: number][] }) {
    const total = parts.reduce((t, p) => t + p[2], 0);
    if (!total) return null;
    const done = parts.filter(p => p[0] === 'matched' || p[0] === 'ignored').reduce((t, p) => t + p[2], 0);
    return (
        <div className="recon" role="img" aria-label={`${Math.round(done / total * 100)}% of ${total} lines reconciled`}>
            <div className="recon-bar">{parts.filter(p => p[2]).map(([k, label, n]) => <span key={k} className={`rc-${k}`} style={{ flexGrow: n }} title={`${label}: ${n}`} />)}</div>
            <div className="recon-key"><b>{Math.round(done / total * 100)}% reconciled</b>{parts.filter(p => p[2]).map(([k, label, n]) => <span key={k}><i className={`rc-${k}`} />{label} {n}</span>)}</div>
        </div>
    );
}

export function BankPage({ params: p }: ScreenProps<'bank'>) {
    useAppState();
    const fileRef = useRef<HTMLInputElement>(null);
    const acctRef = useRef<HTMLSelectElement>(null);
    const stmts = Ent.bank.items.slice().sort((a, b) => (b.importedAt || '').localeCompare(a.importedAt || ''));
    const cur = Ent.bank.get(p.id) || stmts[0];
    const accts = SETTINGS.bankAccounts || [];

    const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
        const input = e.target, f = input.files && input.files[0]; if (!f) return;
        input.value = ''; // the original rebuilt the input on every render, so the same file could be chosen again
        try {
            const { format, lines } = await readStatementFile(f);
            if (!lines.length) return toast('No transactions found. Check the file has date and amount columns.');
            const seen = new Set(Ent.bank.items.flatMap(s => s.lines.map(l => l.h)));
            const stmt: BankStatement = { id: uid('st'), name: f.name, format, account: acctRef.current ? acctRef.current.value : '', importedAt: new Date().toISOString(), importedBy: Store.actorId(), lines: lines.slice(0, 1500).map(l => { const h = hash(`${l.date}|${l.amount}|${l.ref}|${l.desc}`); return Object.assign(l, { id: uid('bl'), h, status: 'unmatched' as const, duplicate: seen.has(h) }); }) };
            const dups = stmt.lines.filter(l => l.duplicate).length;
            if (!await Ent.bank.save(stmt)) return;
            audit('bank.import', `Imported ${f.name}: ${stmt.lines.length} lines (${format}), ${dups} duplicates of earlier statements`);
            const r = await autoReconcile(stmt);
            toast(`${stmt.lines.length} lines imported. ${r.matched} matched, ${r.suggested} suggested${dups ? `, ${dups} duplicates skipped` : ''}.`);
            setParams<'bank'>({ id: stmt.id });
        } catch (err) { console.error(err); toast('This statement could not be read.'); }
    };

    const head = <div className="banner"><div><strong>Statement files, not live bank feeds</strong><p>Import statements exported from internet banking (CSV, Excel, SWIFT MT940 or ISO 20022 CAMT.053). Live feeds need a bank API agreement and a server-side connector; see Administration › Integrations.</p></div></div>;
    const list = (
        <div className="card"><div className="section-head"><h3>Statements</h3><button className="btn btn-sm" id="bk-imp" onClick={() => { if (guard('bank.reconcile')) fileRef.current?.click(); }}>Import statement</button><input type="file" id="bk-file" ref={fileRef} hidden accept=".csv,.xlsx,.xls,.txt,.sta,.mt940,.940,.xml" onChange={onFile} /></div>
            <div className="pad" style={{ paddingBottom: 0 }}><label htmlFor="bk-acct">Bank account</label><select id="bk-acct" ref={acctRef}>{accts.length ? accts.map((a, i) => <option key={i} value={a.name}>{a.name} ({a.currency})</option>) : <option value="">Default account</option>}</select></div>
            <div className="kb-list">{stmts.length ? stmts.map(s => { const m = s.lines.filter(l => l.status === 'matched').length; return <button key={s.id} className={`kb-item ${cur && s.id === cur.id ? 'active' : ''}`} data-s={s.id} onClick={() => setParams<'bank'>({ id: s.id })}>{s.name}<small>{`${s.account || 'Default'}, ${s.lines.length} lines, ${m} matched, ${s.format}`}</small></button>; }) : <p className="empty">No statements yet.</p>}</div></div>
    );

    if (!cur) return <>{head}<div className="kb">{list}<div className="card" id="bk-body"><p className="empty">Import a statement to start reconciling lease payments and receipts.</p></div></div></>;

    const rows = paymentRows();
    const cnt = (k: BankLineStatus | 'duplicate') => cur.lines.filter(l => (k === 'duplicate' ? l.duplicate : l.status === k && !l.duplicate)).length;
    const find = (id: string) => cur.lines.find(l => l.id === id);
    const save = async () => { await Ent.bank.save(cur); };

    const onAuto = async () => { if (!guard('bank.reconcile')) return; const r = await autoReconcile(cur); toast(`${r.matched} matched, ${r.suggested} suggested`); };
    const onDel = () => { if (guard('bank.reconcile')) confirmDialog('Delete statement', 'Delete this statement? Payments already recorded on leases stay recorded.', 'Delete', async () => { if (!await Ent.bank.remove(cur.id)) return; audit('bank.delete', `Deleted statement ${cur.name}`); setParams<'bank'>({ id: null }); }); };
    const onExp = (e: MouseEvent<HTMLButtonElement>) => exportMenu(e.currentTarget, () => [{ name: 'Reconciliation', rows: [['Date', 'Description', 'Reference', 'Amount', 'Status', 'Lease', 'Due date'], ...cur.lines.map(l => [l.date, l.desc, l.ref, l.amount, l.duplicate ? 'duplicate' : l.status, l.match ? l.match.leaseId : '', l.match ? l.match.dueDate : ''])] }], 'Bank_reconciliation', `Bank reconciliation: ${cur.name}`);
    const onOk = async (id: string) => { if (!guard('bank.reconcile')) return; const l = find(id); if (!l || !l.suggest) return; const key = l.suggest.key, r = paymentRows().find(x => x.key === key); if (r) { await recordMatch(cur, l, r, false); await save(); } };
    const onIgn = async (id: string) => { if (!guard('bank.reconcile')) return; const l = find(id); if (!l) return; l.status = 'ignored'; await save(); };
    const onUn = async (id: string) => { if (!guard('bank.reconcile')) return; const l = find(id); if (!l) return; audit('bank.unmatch', `Unmatched ${l.date} ${l.amount} from ${l.match ? l.match.leaseId : ''}`); l.status = 'unmatched'; delete l.match; await save(); };
    const onPick = (id: string) => {
        if (!guard('bank.reconcile')) return;
        const l = find(id); if (!l) return;
        Modal.open('Match bank line', <MatchModal stmt={cur} line={l} onSave={save} />);
    };

    return (
        <>
            {head}
            <div className="kb">{list}
                <div className="card" id="bk-body">
                    <div className="section-head"><div><h3>{cur.name}</h3><p className="note">{`${cnt('matched')} matched, ${cnt('suggested')} suggested, ${cnt('unmatched')} unmatched, ${cnt('ignored')} not lease-related, ${cnt('duplicate')} duplicates`}</p><ReconMeter parts={[['matched', 'Matched', cnt('matched')], ['suggested', 'Suggested', cnt('suggested')], ['unmatched', 'Unmatched', cnt('unmatched')], ['ignored', 'Not lease-related', cnt('ignored')]]} /></div><div className="btn-row"><button className="btn btn-ghost btn-sm" id="bk-auto" onClick={onAuto}>Run auto-match again</button><button className="btn btn-ghost btn-sm" id="bk-exp" onClick={onExp}>Export</button><button className="btn btn-danger btn-sm" id="bk-del" onClick={onDel}>Delete statement</button></div></div>
                    <div className="scroll-x" style={{ maxHeight: '66vh' }}><table><thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th><th>Status</th><th>Match</th><th></th></tr></thead><tbody>
                        {cur.lines.map(l => {
                            const sug = l.suggest ? rows.find(r => r.key === l.suggest?.key) : undefined;
                            return (
                                <tr key={l.id} className={l.duplicate ? '' : l.status === 'unmatched' ? 'row-hl' : ''}><td>{fmtDate(l.date)}</td><td className="wrap">{l.desc}{l.ref ? <div className="note">{l.ref}</div> : null}</td><td className="num">{fmtNum(l.amount)}</td>
                                    <td>{l.duplicate ? <span className="badge badge-neutral">Duplicate</span> : <span className={`badge badge-${STATUS_BADGE[l.status]}`}>{STATUS_TEXT[l.status]}</span>}</td>
                                    <td className="wrap">{l.match
                                        ? <><button className="link" data-open={l.match.leaseId} onClick={() => l.match && go('detail', { id: l.match.leaseId })}>{l.match.leaseId}</button>{` due ${fmtDate(l.match.dueDate)}`}{l.match.auto ? <>{' '}<span className="note">(auto)</span></> : null}</>
                                        : sug ? <>{`${sug.leaseId} due ${fmtDate(sug.dueDate)}, ${fmtNum(sug.outstanding || sug.amount)} `}<span className="note">score {l.suggest?.score}</span></> : null}</td>
                                    <td>{l.duplicate ? null : l.status === 'matched'
                                        ? <button className="btn btn-ghost btn-sm" data-un={l.id} onClick={() => onUn(l.id)}>Unmatch</button>
                                        : <>{sug ? <><button className="btn btn-sm" data-ok={l.id} {...gate('approve')} onClick={() => onOk(l.id)}>Accept</button>{' '}</> : null}<button className="btn btn-ghost btn-sm" data-pick={l.id} onClick={() => onPick(l.id)}>Match…</button>{' '}{l.status !== 'ignored' ? <button className="btn btn-ghost btn-sm" data-ign={l.id} onClick={() => onIgn(l.id)}>Not lease</button> : null}</>}</td></tr>
                            );
                        })}
                    </tbody></table></div><div className="table-note">Matching uses amount (within 0.5%), date (within 10 days of the due date) and the lease ID, contract number or counterparty in the narrative. Matches record the payment against the lease with the bank reference. Unmatching does not delete the recorded payment; reverse it on the lease if needed.</div>
                </div>
            </div>
        </>
    );
}
