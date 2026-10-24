import { useState, type MouseEvent } from 'react';
import type { ScreenProps } from './registry';
import { addDays } from '../domain/engine';
import { SETTINGS } from '../domain/settings';
import { Store } from '../domain/store';
import { AS_OF } from '../domain/state';
import { Ent, approvalProgress, audit, checkApproval, fxConvertBase, guard, logHistory, myRole, nameOf, roleLabel } from '../domain/enterprise';
import { BATCH_STATUS, ibanValid, pain001 } from '../domain/banking';
import { paymentRows } from '../domain/payments';
import { go, setParams } from '../domain/nav';
import { useAppState } from '../hooks/useAppState';
import { Modal, popover, toast } from '../utils/uiStore';
import { saveFile, toCSV } from '../utils/files';
import { deepClone, fmtNum, sum, uid } from '../utils/format';
import { fmtDate, fmtDateTime } from '../utils/dates';
import type { PaymentBatch } from '../types/enterprise';

const bankOf = (leaseId: string) => { const l = Store.get(leaseId); return { l, bk: (l && l.bank) || { iban: '', account: '', bankName: '', swift: '' } }; };

/** Payee bank details, with a live IBAN check. */
function PayeeModal({ id }: { id: string }) {
    const l = Store.get(id), bk = (l && l.bank) || { iban: '', account: '', bankName: '', swift: '' };
    const [iban, setIban] = useState(bk.iban || '');
    const [acc, setAcc] = useState(bk.account || '');
    const [bankName, setBankName] = useState(bk.bankName || '');
    const [swift, setSwift] = useState(bk.swift || '');
    if (!l) return null;
    const ok = async () => {
        if (!guard('payment.batch', 'change payee bank details')) return;
        const v = iban.replace(/\s+/g, '').toUpperCase();
        if (v && !ibanValid(v)) return toast('The IBAN is not valid.');
        const l2 = deepClone(l); l2.bank = { iban: v, account: acc.trim(), bankName: bankName.trim(), swift: swift.trim().toUpperCase() };
        logHistory(l2, `Payee bank details changed (${v ? 'IBAN …' + v.slice(-4) : 'account …' + l2.bank.account.slice(-4)})`);
        if (!await Store.save(l2)) return; Modal.close();
    };
    return (
        <>
            <div className="row2"><div className="fg"><label htmlFor="py-iban">IBAN</label><input id="py-iban" value={iban} placeholder="PK36SCBL0000001123456702" onChange={e => setIban(e.target.value)} /><div className="hint" id="py-chk">{iban ? (ibanValid(iban) ? 'IBAN check digits valid' : 'IBAN is not valid') : ''}</div></div><div className="fg"><label htmlFor="py-acc">Account number (if no IBAN)</label><input id="py-acc" value={acc} onChange={e => setAcc(e.target.value)} /></div></div>
            <div className="row2"><div className="fg"><label htmlFor="py-bank">Bank</label><input id="py-bank" value={bankName} onChange={e => setBankName(e.target.value)} /></div><div className="fg"><label htmlFor="py-swift">SWIFT / BIC</label><input id="py-swift" value={swift} onChange={e => setSwift(e.target.value)} /></div></div>
            <p className="note">Changes to payee bank details are recorded in the audit log. Verify new details with the counterparty by phone before paying.</p>
            <div className="form-actions"><button className="btn btn-ghost" onClick={() => Modal.close()}>Cancel</button><button className="btn" id="py-ok" onClick={ok}>Save</button></div>
        </>
    );
}
function editPayee(id: string) {
    const l = Store.get(id); if (!l) return;
    Modal.open(`Bank details: ${l.counterparty}`, <PayeeModal id={id} />);
}

/** New batch from lease payments due in the next 30 days. */
function NewBatchModal() {
    const [data] = useState(() => {
        const due = paymentRows().filter(r => r.type === 'Payment' && r.status !== 'paid' && r.dueDate <= addDays(AS_OF, 30));
        const inBatch = new Set(Ent.batches.items.filter(b => b.status !== 'rejected').flatMap(b => b.lines.map(x => x.key)));
        return { due, inBatch, ccys: [...new Set(due.map(r => r.currency))] };
    });
    const { due, inBatch, ccys } = data;
    const accts = SETTINGS.bankAccounts || [];
    const initialChecked = (c: string) => new Set(due.filter(r => r.currency === c && !inBatch.has(r.key)).map(r => r.key));
    const [ccy, setCcy] = useState(ccys[0] || '');
    const [date, setDate] = useState(AS_OF);
    const [acct, setAcct] = useState(accts.length ? accts[0].name : '');
    const [checked, setChecked] = useState(() => initialChecked(ccys[0] || ''));
    const shown = due.filter(r => r.currency === ccy);
    const toggle = (k: string, on: boolean) => setChecked(prev => { const n = new Set(prev); if (on) n.add(k); else n.delete(k); return n; });
    const ok = async () => {
        const keys = shown.filter(r => checked.has(r.key) && !inBatch.has(r.key)).map(r => r.key); if (!keys.length) return toast('Select at least one payment.');
        const rows = paymentRows().filter(r => keys.includes(r.key));
        const b: PaymentBatch = { id: uid('pb'), name: `Lease payments ${date} ${ccy}`, currency: ccy, valueDate: date, account: acct, createdAt: new Date().toISOString(), createdBy: Store.actorId(), status: 'draft', approvals: [], lines: rows.map(r => ({ key: r.key, leaseId: r.leaseId, dueDate: r.dueDate, forType: r.kind, amount: Math.round(r.outstanding * 100) / 100 })), total: 0 };
        b.total = sum(b.lines, x => x.amount);
        if (!await Ent.batches.save(b)) return; audit('batch.create', `${b.name}: ${b.lines.length} payments, ${fmtNum(b.total)}`); Modal.close(); go('batches', { id: b.id }, { reset: true });
    };
    return (
        <>
            <p className="note">Lease payments due in the next 30 days that are not already in a batch. One batch per currency.</p>
            <div className="row3" style={{ marginTop: '10px' }}><div className="fg"><label htmlFor="nb-ccy">Currency</label><select id="nb-ccy" value={ccy} onChange={e => { setCcy(e.target.value); setChecked(initialChecked(e.target.value)); }}>{ccys.map(c => <option key={c}>{c}</option>)}</select></div><div className="fg"><label htmlFor="nb-date">Value date</label><input type="date" id="nb-date" value={date} onChange={e => setDate(e.target.value)} /></div><div className="fg"><label htmlFor="nb-acct">Pay from</label><select id="nb-acct" value={acct} onChange={e => setAcct(e.target.value)}>{accts.length ? accts.map((a, i) => <option key={i}>{a.name}</option>) : <option value="">Default account</option>}</select></div></div>
            <div id="nb-list" className="scroll-x" style={{ maxHeight: '45vh' }}><table><thead><tr><th></th><th>Lease</th><th>Due</th><th className="num">Outstanding</th></tr></thead><tbody>{shown.length ? shown.map(r => (
                <tr key={r.key}><td><input type="checkbox" value={r.key} disabled={inBatch.has(r.key)} checked={!inBatch.has(r.key) && checked.has(r.key)} onChange={e => toggle(r.key, e.target.checked)} /></td><td>{`${r.leaseId} ${r.name}`}{inBatch.has(r.key) ? <>{' '}<span className="note">(in a batch)</span></> : null}</td><td>{fmtDate(r.dueDate)}{r.status === 'overdue' ? <>{' '}<span className="badge badge-bad">Overdue</span></> : null}</td><td className="num">{fmtNum(r.outstanding)}</td></tr>
            )) : <tr><td colSpan={4} className="empty">Nothing due.</td></tr>}</tbody></table></div>
            <div className="form-actions"><button className="btn btn-ghost" onClick={() => Modal.close()}>Cancel</button><button className="btn" id="nb-ok" onClick={ok}>Create batch</button></div>
        </>
    );
}
function newBatch() { Modal.open('New payment batch', <NewBatchModal />, { wide: true }); }

export function BatchesPage({ params: p }: ScreenProps<'batches'>) {
    useAppState();
    const list = Ent.batches.items.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const cur = Ent.batches.get(p.id);
    const side = (
        <div className="card"><div className="section-head"><h3>Batches</h3><button className="btn btn-sm" id="pb-new" onClick={() => { if (guard('payment.batch')) newBatch(); }}>New batch</button></div>
            <div className="kb-list">{list.length ? list.map(b => <button key={b.id} className={`kb-item ${cur && b.id === cur.id ? 'active' : ''}`} data-b={b.id} onClick={() => setParams<'batches'>({ id: b.id })}>{b.name}<small>{`${b.lines.length} payments, ${b.currency} ${fmtNum(b.total)}, ${BATCH_STATUS[b.status]}`}</small></button>) : <p className="empty">No batches yet.</p>}</div></div>
    );
    if (!cur) return <div className="kb">{side}<div className="card" id="pb-body"><p className="empty">Select a batch, or create one from payments due. A batch is prepared by one person and approved by another before the bank file is released.</p></div></div>;

    const amtBase = fxConvertBase(cur.total, cur.currency), prep = cur.createdBy;
    const save = async () => { await Ent.batches.save(cur); };
    const onSub = async () => {
        if (!guard('payment.batch')) return;
        const missing = cur.lines.filter(x => { const b = bankOf(x.leaseId).bk; return !(ibanValid(b.iban) || b.account); });
        if (missing.length) return toast(`Add valid bank details for ${missing.map(x => x.leaseId).join(', ')} first.`);
        cur.status = 'pending'; cur.submittedAt = new Date().toISOString(); audit('batch.submit', `${cur.name} submitted: ${cur.currency} ${fmtNum(cur.total)}`); await save();
    };
    const onDel = async () => { if (!await Ent.batches.remove(cur.id)) return; audit('batch.delete', cur.name); setParams<'batches'>({ id: null }); };
    const onOk = async () => {
        const chk = checkApproval('batch', cur, amtBase, prep); if (!chk.ok) return toast(chk.reason || '');
        cur.approvals = (cur.approvals || []).concat([{ by: Store.actorId(), name: Store.actorName(), role: myRole(), at: new Date().toISOString() }]);
        if (chk.done) cur.status = 'approved';
        audit('batch.approve', `${cur.name}: approval ${cur.approvals.length} of ${chk.needed}`); await save();
    };
    const onNo = async () => { if (!guard('approve')) return; cur.status = 'rejected'; audit('batch.reject', cur.name); await save(); };
    const fileName = (ext: string) => `${cur.name.replace(/\W+/g, '_')}.${ext}`;
    const release = async (f: 'xml' | 'csv') => {
        popover.close();
        const okSave = f === 'xml' ? await saveFile(fileName('xml'), pain001(cur)) : await saveFile(fileName('csv'), '﻿' + toCSV([['Payee', 'IBAN / account', 'Bank', 'SWIFT', 'Amount', 'Currency', 'Value date', 'Reference'], ...cur.lines.map(x => { const { l, bk } = bankOf(x.leaseId); return [l ? l.counterparty : undefined, bk.iban || bk.account, bk.bankName, bk.swift, x.amount.toFixed(2), cur.currency, cur.valueDate, `${x.leaseId} rent ${x.dueDate}`]; })]));
        if (okSave) { cur.status = 'released'; cur.releasedAt = new Date().toISOString(); audit('batch.release', `${cur.name} bank file released`); await save(); }
    };
    const onFile = (e: MouseEvent<HTMLButtonElement>) => popover.open(e.currentTarget, (
        <div><button className="pop-item" data-f="xml" onClick={() => release('xml')}>ISO 20022 pain.001 (XML)</button><button className="pop-item" data-f="csv" onClick={() => release('csv')}>CSV</button></div>
    ));

    return (
        <div className="kb">{side}
            <div className="card" id="pb-body">
                <div className="section-head"><div><h3>{cur.name}</h3><p className="note">{`Value date ${fmtDate(cur.valueDate)}. From ${cur.account || 'default account'}. Prepared by ${nameOf(prep)}. ${BATCH_STATUS[cur.status]}${cur.status === 'pending' ? ': ' + approvalProgress(cur, 'batch', amtBase) : ''}.`}</p></div>
                    <div className="btn-row">{cur.status === 'draft' ? <><button className="btn" id="pb-sub" onClick={onSub}>Submit for approval</button><button className="btn btn-danger" id="pb-del" onClick={onDel}>Delete</button></> : null}{cur.status === 'pending' ? <><button className="btn" id="pb-ok" onClick={onOk}>Approve</button><button className="btn btn-danger" id="pb-no" onClick={onNo}>Reject</button></> : null}{cur.status === 'approved' || cur.status === 'released' ? <button className="btn" id="pb-file" onClick={onFile}>Download bank file</button> : null}</div></div>
                <div className="scroll-x"><table><thead><tr><th>Lease</th><th>Payee</th><th>Payee account</th><th>Due</th><th className="num">Amount</th><th>Check</th></tr></thead><tbody>
                    {cur.lines.map(x => {
                        const { l, bk } = bankOf(x.leaseId); const ok = ibanValid(bk.iban) || bk.account;
                        return <tr key={x.key}><td>{x.leaseId}</td><td>{(l && l.counterparty) || ''}</td><td>{bk.iban ? bk.iban : bk.account ? bk.account : '—'}{bk.bankName ? <div className="note">{bk.bankName}</div> : null}</td><td>{fmtDate(x.dueDate)}</td><td className="num">{fmtNum(x.amount)}</td><td>{ok ? (bk.iban && !ibanValid(bk.iban) ? <span className="badge badge-bad">IBAN invalid</span> : <span className="badge badge-ok">OK</span>) : <button className="btn btn-ghost btn-sm" data-payee={x.leaseId} onClick={() => editPayee(x.leaseId)}>Add bank details</button>}</td></tr>;
                    })}
                </tbody><tfoot><tr><td colSpan={4}>Total ({cur.lines.length})</td><td className="num">{fmtNum(cur.total)}</td><td></td></tr></tfoot></table></div>
                {(cur.approvals || []).length ? <div className="pad"><h4>Approvals</h4>{cur.approvals.map((a, i) => <p key={i} className="note">{`${a.name} (${roleLabel(a.role)}) ${fmtDateTime(a.at)}`}</p>)}</div> : null}
                <div className="table-note">Bank files: ISO 20022 pain.001.001.03 (accepted by most banks for bulk payments) or CSV. Check your bank’s required template; uploading the file to the bank portal still needs the bank’s own authorisation.</div>
            </div>
        </div>
    );
}
