import { useState } from 'react';
import { isLive } from '../../domain/lease';
import { Store } from '../../domain/store';
import { AS_OF } from '../../domain/state';
import { guard, lockGuard, logHistory } from '../../domain/enterprise';
import { paymentRows } from '../../domain/payments';
import { useAppState } from '../../hooks/useAppState';
import { Modal, toast } from '../../utils/uiStore';
import { deepClone, fmtNum, uid } from '../../utils/format';
import { fmtDate } from '../../utils/dates';

type PaymentKind = 'scheduled' | 'variable';

/** Open instalments of a lease, the instalment the select shows and its outstanding amount (the original fill()). */
function fillFor(leaseId: string, key: string | null | undefined) {
    const rows = paymentRows().filter(r => r.leaseId === leaseId && r.status !== 'paid');
    const due = key ? (rows.some(r => r.key === key) ? key : '') : (rows.length ? rows[0].key : '');
    const r = rows.find(x => x.key === due);
    return { rows, due, amt: r ? String(Math.round(r.outstanding)) : '' };
}

function PaymentForm({ leaseId, initialKey, kind }: { leaseId?: string | null; initialKey?: string | null; kind: PaymentKind }) {
    useAppState();
    const live = Store.leases.filter(l => isLive(l));
    const [lease, setLease] = useState(() => (leaseId && live.some(l => l.id === leaseId) ? leaseId : ''));
    // The original fill() did nothing for variable payments (no instalment select).
    const [init] = useState(() => kind === 'variable' ? { due: '', amt: '' } : fillFor(lease, initialKey));
    const [due, setDue] = useState(init.due);
    const [amt, setAmt] = useState(init.amt);
    const [date, setDate] = useState(AS_OF);
    const [ref, setRef] = useState('');
    const rows = paymentRows().filter(r => r.leaseId === lease && r.status !== 'paid');

    const onLease = (v: string) => { setLease(v); if (kind === 'variable') return; const f = fillFor(v, initialKey); setDue(f.due); setAmt(f.amt); };
    const onDue = (v: string) => { setDue(v); const r = paymentRows().find(x => x.key === v); setAmt(r ? String(Math.round(r.outstanding)) : ''); };
    const save = async () => {
        const l = Store.get(lease); if (!l) return toast('Choose a lease.');
        if (!lockGuard(date, 'Payment')) return;
        const a = Number(amt); if (!(a > 0)) return toast('Enter the amount.');
        const l2 = deepClone(l); l2.payments = l2.payments || [];
        if (kind === 'variable') l2.payments.push({ id: uid('p'), kind: 'variable', amount: a, paidDate: date, dueDate: date, ref });
        else { const r = paymentRows().find(x => x.key === due); if (!r) return toast('Choose the instalment.'); l2.payments.push({ id: uid('p'), kind: 'scheduled', dueDate: r.dueDate, forType: r.kind, amount: a, paidDate: date, ref }); }
        logHistory(l2, `${kind === 'variable' ? 'Variable payment' : l.role === 'lessor' ? 'Receipt' : 'Payment'} of ${fmtNum(a)} recorded`);
        if (!await Store.save(l2)) return; Modal.close(); toast(kind === 'variable' ? 'Variable payment recorded' : 'Payment recorded');
    };

    return (
        <>
            <div className="row2"><div className="fg"><label htmlFor="pm-lease">Lease</label><select id="pm-lease" value={lease} onChange={e => onLease(e.target.value)}><option value="">Choose a lease</option>{live.map(l => <option key={l.id} value={l.id}>{`${l.id}: ${l.name}`}</option>)}</select></div>
                {kind === 'variable' ? <div></div> : <div className="fg"><label htmlFor="pm-due">Instalment</label><select id="pm-due" value={due} onChange={e => onDue(e.target.value)}>{rows.length ? rows.map(r => <option key={r.key} value={r.key}>{`${fmtDate(r.dueDate)}: ${fmtNum(r.outstanding)} ${r.status === 'overdue' ? '(overdue)' : ''}`}</option>) : <option value="">No open instalments</option>}</select></div>}</div>
            <div className="row3"><div className="fg"><label htmlFor="pm-amt">Amount</label><input type="number" id="pm-amt" step="any" value={amt} onChange={e => setAmt(e.target.value)} /></div><div className="fg"><label htmlFor="pm-date">Date paid</label><input type="date" id="pm-date" value={date} onChange={e => setDate(e.target.value)} /></div><div className="fg"><label htmlFor="pm-ref">Reference</label><input id="pm-ref" placeholder="Cheque or bank reference" value={ref} onChange={e => setRef(e.target.value)} /></div></div>
            {kind === 'variable' ? <p className="note">Variable payments not based on an index or rate (for example a share of sales) are expensed when incurred (16.38(b)).</p> : <p className="note">Paying less than the instalment leaves it part paid. Late charges are worked out from the lease’s rules.</p>}
            <div className="form-actions"><button className="btn btn-ghost" id="pm-cancel" onClick={() => Modal.close()}>Cancel</button><button className="btn" id="pm-save" onClick={save}>Record</button></div>
        </>
    );
}

/** Open "Record payment or receipt" (or "Record variable payment") (needs payment.record). */
export function openPaymentModal(leaseId?: string | null, key?: string | null, kind: 'scheduled' | 'variable' = 'scheduled'): void {
    if (!guard('payment.record')) return;
    Modal.open(kind === 'variable' ? 'Record variable payment' : 'Record payment or receipt', <PaymentForm leaseId={leaseId} initialKey={key} kind={kind} />);
}
