import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ScreenProps } from './registry';
import { EVENT_TYPES, aggregate, balanceAt, num as N } from '../domain/engine';
import { contractEnd, getResult, isLive, leaseEnd, measurementType, statusOf } from '../domain/lease';
import { ASSET_CLASSES, FREQ, SETTINGS } from '../domain/settings';
import { Store } from '../domain/store';
import { AS_OF } from '../domain/state';
import { can, gate } from '../domain/enterprise';
import { approveEvent, approveLease, eventApprovalProgress, lastSubmitter, leaseApprovalProgress, rejectEvent, rejectLease } from '../domain/approvals';
import { journalRows, journalsFor } from '../domain/journals';
import { PAY_STATUS, paymentRows, type PaymentRow } from '../domain/payments';
import { highlightText } from '../domain/contractFields';
import { go, setParams } from '../domain/nav';
import { useAppState } from '../hooks/useAppState';
import { DataTable, type Column } from '../components/common/DataTable';
import { StatusBadge } from '../components/common/Badges';
import { JournalTable } from '../components/common/JournalTable';
import { exportMenu } from '../components/common/ExportMenu';
import { confirmDialog } from '../components/common/ConfirmDialog';
import { EventImpact } from '../components/lease/EventImpact';
import { openEventWizard } from '../components/lease/EventWizard';
import { openPaymentModal } from '../components/lease/PaymentModal';
import { Modal, toast } from '../utils/uiStore';
import { cap, fmtNum, fyBounds, money, pct, sum } from '../utils/format';
import { fmtDate, fmtDateTime, monthLabel } from '../utils/dates';
import type { SheetValue } from '../utils/files';
import type { AggregateRow, EngineResult, EngineRow } from '../types/engine';
import type { Lease, LeaseEvent } from '../types/lease';

type Tab = 'summary' | 'schedule' | 'journals' | 'payments' | 'events' | 'documents' | 'history';

/* ---- Summary ---- */
type KvRow = [label: string, value: unknown];
function Sec({ title, rows }: { title: string; rows: KvRow[] }) {
    return <div style={{ marginBottom: '22px' }}><h3>{title}</h3><dl className="kv">{rows.filter(r => r[1] !== null && r[1] !== undefined && r[1] !== '').map((r, i) => <div key={i}><dt>{r[0]}</dt><dd>{String(r[1])}</dd></div>)}</dl></div>;
}
function Indicators({ res }: { res: Extract<EngineResult, { mode: 'lessor-finance' | 'lessor-operating' }> }) {
    return <ul className="warn-list">{res.classification.indicators.map(i => <li key={i.key} className={i.met ? '' : 'info'}>{`${i.met ? 'Met' : 'Not met'}: ${i.label}`}{' '}<span className="ref">{i.ref}</span></li>)}</ul>;
}
function Summary({ l, res }: { l: Lease; res: EngineResult | null }) {
    const T = l.terms, ccy = l.currency;
    let measure: ReactNode = null;
    if (res && res.mode === 'lessee') {
        const I = res.initial;
        measure = <div style={{ marginBottom: '22px' }}><h3>Initial measurement</h3><table className="ledger" style={{ maxWidth: '520px' }}><tbody>
            <tr><td>Present value of lease payments not yet paid</td><td className="num">{fmtNum(I.liability)}</td></tr>
            <tr><td>Lease payments made at or before commencement</td><td className="num">{fmtNum(I.paidAtCommencement)}</td></tr>
            <tr><td>Initial direct costs</td><td className="num">{fmtNum(I.idc)}</td></tr>
            <tr><td>Lease incentives received</td><td className="num">{fmtNum(-I.incentives)}</td></tr>
            <tr><td>Restoration costs (IAS 37)</td><td className="num">{fmtNum(I.restoration)}</td></tr>
            <tr><td>Security deposit: excess over fair value</td><td className="num">{fmtNum(I.depositAdj)}</td></tr>
            <tr className="total"><td>Right-of-use asset at commencement</td><td className="num">{fmtNum(I.rou)}</td></tr></tbody></table>
            <p className="note" style={{ marginTop: '8px' }}>{`Depreciated straight-line over ${res.depEnd} months (${res.owns ? 'useful life, because ownership transfers or a purchase option is reasonably certain (16.32)' : 'the shorter of the lease term and useful life (16.32)'}). Monthly rate ${(I.monthlyRate * 100).toFixed(4)}% (${SETTINGS.rateConvention === 'effective' ? 'effective annual convention' : 'nominal convention'}).`}</p></div>;
    } else if (res && res.mode === 'lessor-finance') {
        const I = res.initial;
        measure = <div style={{ marginBottom: '22px' }}><h3>Classification and initial measurement</h3>
            <Indicators res={res} />
            <table className="ledger" style={{ maxWidth: '520px', marginTop: '12px' }}><tbody>
                <tr><td>Net investment in the lease</td><td className="num">{fmtNum(I.netInvestment)}</td></tr>
                {T.dealer
                    ? <><tr><td>Revenue (lower of fair value and PV of lease payments)</td><td className="num">{fmtNum(I.revenue)}</td></tr><tr><td>Cost of sales (carrying amount less PV of unguaranteed residual)</td><td className="num">{fmtNum(-I.cogs)}</td></tr><tr><td>Initial direct costs expensed (16.74)</td><td className="num">{fmtNum(-I.dealerIDC)}</td></tr><tr className="total"><td>Selling profit</td><td className="num">{fmtNum(I.sellingProfit)}</td></tr></>
                    : <tr><td>Gain on derecognition of the underlying asset</td><td className="num">{fmtNum(I.gainOnDerecognition)}</td></tr>}
                <tr><td>Rate implicit in the lease</td><td className="num">{pct(I.annualRate)}</td></tr></tbody></table></div>;
    } else if (res && res.mode === 'lessor-operating') {
        const cls = res.classification;
        measure = <div style={{ marginBottom: '22px' }}><h3>Classification</h3><Indicators res={res} />
            <p className="note" style={{ marginTop: '8px' }}>{`${cls.classification === cls.auto ? 'Classified from the indicators.' : 'Classification set manually in the lease, overriding the indicators.'} Lease income ${money(res.initial.monthlyIncome, ccy)} per month on a straight-line basis (16.81).`}</p></div>;
    }
    const esc = T.escalation;
    return <>
        {measure}
        <Sec title="Contract" rows={[['Contract number', l.contractNumber], ['Counterparty', l.counterparty], ['Role', cap(l.role)], ['Entity', l.entity], ['Cost centre', l.costCentre], ['Currency', ccy]]} />
        <Sec title="Asset" rows={[['Asset class', ASSET_CLASSES[l.assetClass]], ['Location', l.location], ['Area', l.area ? `${fmtNum(l.area)} ${l.areaUnit}` : ''], ['Useful life', N(T.usefulLifeM) ? `${T.usefulLifeM} months` : ''], ['Ownership transfers', T.ownershipTransfer ? 'Yes' : 'No']]} />
        <Sec title="Term and options" rows={[['Commencement', fmtDate(T.commencement)], ['Non-cancellable period', `${T.termMonths} months (to ${fmtDate(contractEnd(l))})`], ['Extension option', N(T.extension.months) ? `${T.extension.months} months${N(T.extension.payment) ? ' at ' + fmtNum(T.extension.payment) : ''}, ${T.extension.certain ? 'reasonably certain' : 'not reasonably certain'}` : 'None'], ['Termination option', N(T.termination.month) ? `After month ${T.termination.month}${N(T.termination.penalty) ? ', penalty ' + fmtNum(T.termination.penalty) : ''}, ${T.termination.certain ? 'reasonably certain to be exercised' : 'not expected to be exercised'}` : 'None'], ['Purchase option', N(T.purchase.price) ? `${fmtNum(T.purchase.price)}, ${T.purchase.certain ? 'reasonably certain' : 'not reasonably certain'}` : 'None'], ['Residual value guarantee (expected payable)', N(T.rvg) ? fmtNum(T.rvg) : '']]} />
        <Sec title="Payments" rows={[['Payment', `${money(T.payment as number, ccy)} ${(FREQ[T.freqM] || '').toLowerCase()}, in ${T.timing}`], ['Escalation', esc.type === 'fixed' ? `${esc.rate}% every ${esc.everyM} months` : esc.type === 'index' ? `Index-linked (base ${esc.indexBase || '—'}); remeasure when the index changes` : 'None'], ['Rent-free months', N(T.rentFreeMonths) || ''], ['Non-lease component per payment', N(T.serviceComponent) ? `${fmtNum(T.serviceComponent)}${T.combine ? ' (combined with lease, 16.15)' : ' (excluded and expensed)'}` : ''], ['Security deposit', N(T.deposit) ? fmtNum(T.deposit) : ''], ['Variable payments', T.variableNote]]} />
        <Sec title="Late payment rules" rows={[['Grace period', `${T.gracePeriodDays || 0} days`], ['Late charge', T.lateType === 'none' ? 'None' : T.lateType === 'fine' ? `Fine ${T.fineRate}%` : T.lateType === 'both' ? `Interest ${T.lateRate}% a month and fine ${T.fineRate}%` : `Interest ${T.lateRate}% a month`], ['Partial payments applied to', cap((T.partialRule || '').replace('-', ' '))]]} />
        {l.notes ? <Sec title="Notes" rows={[['Notes', l.notes]]} /> : null}
    </>;
}

/* ---- Schedule: monthly engine rows aggregated to the chosen period ---- */
type Cell = string | number | undefined;
function monthlyDetailRows(res: EngineResult): SheetValue[][] {
    if (res.mode === 'lessee') return ([['Month', 'Start', 'Opening liability', 'Addition', 'Remeasurement', 'Advance payment', 'Interest', 'Arrears payment', 'Derecognised', 'Closing liability', 'Opening ROU', 'Addition', 'Remeasurement', 'Depreciation', 'Impairment', 'Derecognised', 'Closing ROU', 'Gain/(loss)']] as SheetValue[][]).concat(res.rows.map(r => [r.t + 1, r.start, r.openL, r.addL, r.remL, r.payAdv, r.int, r.payArr, r.derL, r.closeL, r.openA, r.addA, r.remA, r.dep, r.imp, r.derA, r.closeA, r.gain]));
    if (res.mode === 'lessor-finance') return ([['Month', 'Start', 'Opening', 'Addition', 'Modification', 'Advance receipt', 'Finance income', 'Arrears receipt', 'Closing']] as SheetValue[][]).concat(res.rows.map(r => [r.t + 1, r.start, r.openL, r.addL, r.remL, r.rcpAdv, r.int, r.rcpArr, r.closeL]));
    if (res.mode === 'lessor-operating') return ([['Month', 'Start', 'Cash', 'Income', 'Accrued', 'Asset depreciation']] as SheetValue[][]).concat(res.rows.map(r => [r.t + 1, r.start, r.cash, r.income, r.accrued, r.assetDep]));
    return ([['Month', 'Start', 'Cash', 'Expense', 'Prepaid']] as SheetValue[][]).concat(res.rows.map(r => [r.t + 1, r.start, r.cash, r.expense, r.prepaid]));
}
function Schedule({ l, p }: { l: Lease; p: ScreenProps<'detail'>['params'] }) {
    const res = getResult(l);
    if (!res) return <p className="empty">Add a commencement date, term and payment to see the schedule.</p>;
    const by = p.by || (N(l.terms.freqM) >= 12 ? 'year' : 'fy');
    const keyFns: Record<string, (r: EngineRow) => string | number> = { month: r => r.t, payment: r => Math.floor(r.t / (N(l.terms.freqM) || 1)), fy: r => fyBounds(r.start).label, year: r => Math.floor(r.t / 12) };
    const agg = aggregate(res, keyFns[by]);
    const label = (a: AggregateRow) => by === 'month' ? monthLabel(a.start) : by === 'fy' ? String(a.key) : by === 'year' ? `Year ${Number(a.key) + 1}` : `${fmtDate(a.start)} to ${fmtDate(a.end)}`;
    let cols: string[], rows: Cell[][];
    if (res.mode === 'lessee') {
        cols = ['Period', 'Opening liability', 'Additions and remeasurement', 'Payments', 'Interest', 'Derecognised', 'Closing liability', 'Opening ROU', 'Additions and remeasurement', 'Depreciation', 'Impairment / derecognised', 'Closing ROU', 'Gain / (loss)'];
        rows = agg.map(a => [label(a), a.openL, a.addL + a.remL, -(a.payAdv + a.payArr), a.int, -a.derL, a.closeL, a.openA, a.addA + a.remA, -a.dep, -(a.imp + a.derA), a.closeA, a.gain]);
    } else if (res.mode === 'lessor-finance') {
        cols = ['Period', 'Opening net investment', 'Additions / modification', 'Receipts', 'Finance income', 'Derecognised', 'Closing net investment'];
        rows = agg.map(a => [label(a), a.openL, a.addL + a.remL, -(a.rcpAdv + a.rcpArr), a.int, -a.derL, a.closeL]);
    } else if (res.mode === 'lessor-operating') {
        cols = ['Period', 'Cash received', 'Lease income (straight-line)', 'Accrued / (deferred) income', 'Depreciation of asset', 'IDC amortised'];
        rows = agg.map(a => [label(a), a.cash, a.income, a.accrued, a.assetDep, a.idcAmort]);
    } else {
        cols = ['Period', 'Cash paid', 'Lease expense (straight-line)', 'Prepaid / (accrued)'];
        rows = agg.map(a => [label(a), a.cash, a.expense, a.prepaid]);
    }
    const totIdx = { lessee: [2, 3, 4, 5, 8, 9, 10, 12], 'lessor-finance': [2, 3, 4, 5], 'lessor-operating': [1, 2, 4, 5], exempt: [1, 2] }[res.mode];
    const totals = cols.map((_, i) => totIdx.includes(i) ? sum(rows, r => r[i]) : null);
    const evRows = new Set(agg.map((a, i) => a.events.length ? i : -1).filter(i => i >= 0));
    const evLabel = (a: AggregateRow) => a.events.map(e => (e as { label?: string }).label).join('; ');
    return <>
        <div className="section-head"><div className="seg" role="group" aria-label="Group by">{([['month', 'Month'], ['payment', 'Payment period'], ['fy', 'Financial year'], ['year', 'Lease year']] as const).map(([k, v]) => <button key={k} data-by={k} aria-pressed={by === k} onClick={() => setParams<'detail'>({ by: k })}>{v}</button>)}</div>{can('ai.use') ? <button className="btn btn-ghost" id="s-why" onClick={() => go('ai', { leaseId: l.id, ask: `Explain step by step how the lease liability and right-of-use asset for ${l.id} are calculated: the lease term and payments included, the discount rate and monthly conversion, the first year's interest and depreciation, and any remeasurement or modification. Use get_lease and show the arithmetic so I can check it against the schedule.` }, { reset: true })}>Explain this calculation</button> : null}<button className="btn btn-ghost" id="s-exp" onClick={e => exportMenu(e.currentTarget, () => [{ name: 'Schedule', rows: ([cols] as SheetValue[][]).concat(rows) }, { name: 'Monthly detail', rows: monthlyDetailRows(res) }], `Schedule_${l.id}`, `${l.id} ${l.name}: schedule (${l.currency})`)}>Export schedule</button></div>
        <div id="s-body"><div className="scroll-x" style={{ maxHeight: '62vh' }}><table><thead><tr>{cols.map((c, i) => <th key={i} className={i ? 'num' : ''}>{c}</th>)}</tr></thead><tbody>
            {rows.map((r, i) => <tr key={i} className={evRows.has(i) ? 'row-event' : ''} title={evRows.has(i) ? evLabel(agg[i]) : ''}>{r.map((v, j) => <td key={j} className={j ? 'num' : ''}>{j ? fmtNum(v) : String(v)}</td>)}</tr>)}
        </tbody><tfoot><tr>{totals.map((v, i) => <td key={i} className={i ? 'num' : ''}>{i === 0 ? 'Total' : v === null ? '' : fmtNum(v)}</td>)}</tr></tfoot></table></div>
            <div className="table-note">{`${res.mode === 'lessee' ? 'Payments due at commencement are part of the right-of-use asset and are not shown as liability payments. ' : ''}Highlighted rows contain a remeasurement, modification or termination. Amounts in ${l.currency}.`}</div></div>
    </>;
}

/* ---- Journal entries for the lease ---- */
function LeaseJournals({ l }: { l: Lease }) {
    const fy = fyBounds(AS_OF);
    const [from, setFrom] = useState(l.terms.commencement > fy.start ? l.terms.commencement : fy.start);
    const [to, setTo] = useState(fy.end);
    const list = journalsFor(l, from, to);
    return <>
        <div className="section-head"><div className="btn-row"><label style={{ margin: 0 }}>From</label><input type="date" id="j-from" value={from} onChange={e => setFrom(e.target.value)} style={{ width: '150px' }} /><label style={{ margin: 0 }}>To</label><input type="date" id="j-to" value={to} onChange={e => setTo(e.target.value)} style={{ width: '150px' }} /></div><button className="btn btn-ghost" id="j-exp" onClick={e => exportMenu(e.currentTarget, () => [{ name: 'Journal entries', rows: journalRows(journalsFor(l, from, to)) }], `Journals_${l.id}`, `${l.id}: journal entries`)}>Export</button></div>
        <div id="j-body"><JournalTable list={list} showLease={false} /></div>
    </>;
}

/* ---- Payments for the lease ---- */
function leasePayColumns(leaseId: string): Column<PaymentRow>[] {
    return [
        { key: 'dueDate', label: 'Due', type: 'date', format: v => fmtDate(v as string) },
        { key: 'type', label: 'Type', type: 'enum' }, { key: 'kind', label: 'For', type: 'enum' }, { key: 'currency', label: 'Ccy', type: 'enum' },
        { key: 'amount', label: 'Amount', type: 'number', format: v => fmtNum(v), total: true },
        { key: 'paid', label: 'Paid', type: 'number', format: v => fmtNum(v), total: true },
        { key: 'outstanding', label: 'Outstanding', type: 'number', format: v => fmtNum(v), total: true },
        { key: 'daysLate', label: 'Days late', type: 'number', format: v => v ? String(v) : '' },
        { key: 'lateCharge', label: 'Late charge', type: 'number', format: v => v ? fmtNum(v) : '' },
        { key: 'status', label: 'Status', type: 'enum', value: r => PAY_STATUS[r.status][0], render: r => <span className={`badge badge-${PAY_STATUS[r.status][1]}`}>{PAY_STATUS[r.status][0]}</span> },
        { key: '_a', label: '', noFilter: true, render: r => r.status === 'paid' ? '' : <button className="btn btn-ghost btn-sm" data-act="record" {...gate('payment.record')} onClick={e => { e.stopPropagation(); openPaymentModal(leaseId, r.key); }}>Record</button> },
    ];
}
function LeasePayments({ l, p }: { l: Lease; p: ScreenProps<'detail'>['params'] }) {
    const rows = paymentRows().filter(r => r.leaseId === l.id);
    const vars = (l.payments || []).filter(x => x.kind === 'variable');
    const columns = useMemo(() => leasePayColumns(l.id), [l.id]);
    return <>
        <div className="section-head"><h3>Scheduled {l.role === 'lessor' ? 'receipts' : 'payments'}</h3><div className="btn-row"><button className="btn btn-ghost btn-sm" id="lp-var" {...gate('payment.record')} onClick={() => openPaymentModal(l.id, null, 'variable')}>Record variable payment</button><button className="btn btn-sm" id="lp-add" {...gate('payment.record')} onClick={() => openPaymentModal(l.id)}>Record {l.role === 'lessor' ? 'receipt' : 'payment'}</button></div></div><div id="lp-t"><DataTable columns={columns} rows={rows} search={false} rowClass={r => r.key === p.highlight ? 'row-hl' : ''} /></div>
        {vars.length ? <><div className="section-head"><h3>Variable payments (expensed)</h3></div><div className="scroll-x"><table><thead><tr><th>Date</th><th className="num">Amount</th><th>Reference</th></tr></thead><tbody>{vars.map((v, i) => <tr key={i}><td>{fmtDate(v.paidDate)}</td><td className="num">{fmtNum(v.amount)}</td><td>{v.ref || ''}</td></tr>)}</tbody></table></div></> : null}
    </>;
}

/* ---- Changes (remeasurements, modifications, terminations) ---- */
interface AppliedEvent { id: string; adjustment?: number; before: { L?: number; A?: number }; partial?: { gain: number }; penalty?: number }
function Events({ l }: { l: Lease }) {
    const res = getResult(l), evs = (l.events || []).slice().sort((a, b) => b.effective.localeCompare(a.effective));
    const applied = (res ? res.events : []) as unknown as AppliedEvent[];
    return <>
        <div className="section-head"><h3>Remeasurements, modifications and terminations</h3>{isLive(l) ? <button className="btn" id="ev-add" {...gate('lease.change')} onClick={() => openEventWizard(l)}>Remeasure or modify</button> : null}</div>
        <div className="scroll-x"><table><thead><tr><th>Effective</th><th>Change</th><th>Status</th><th className="num">Rate</th><th className="num">Liability adj.</th><th className="num">Gain / (loss)</th><th>Reason</th><th>By</th></tr></thead><tbody>
            {evs.length ? evs.map(e => {
                const a = applied.find(x => x.id === e.id);
                return <tr key={e.id}><td>{fmtDate(e.effective)}</td><td>{EVENT_TYPES[e.type].label}</td><td><StatusBadge status={e.status === 'approved' ? 'active' : e.status} /></td><td className="num">{e.newRate != null ? pct(e.newRate) : 'Unchanged'}</td><td className="num">{a && a.adjustment != null ? fmtNum(a.adjustment) : a && e.type === 'terminate' ? fmtNum(-Number(a.before.L)) : '—'}</td><td className="num">{a ? fmtNum((a.partial ? a.partial.gain : 0) + (e.type === 'terminate' ? Number(a.before.L) - Number(a.before.A) - (a.penalty || 0) : 0)) : '—'}</td><td className="wrap">{e.reason || ''}</td><td>{e.approvedByName || e.submittedByName || ''}</td></tr>;
            }) : <tr><td colSpan={8} className="empty">No changes recorded. The lease runs on its original terms.</td></tr>}
        </tbody></table></div><div className="table-note">“Approved” rows are included in the schedule and journals. Approved changes appear as the status “Active”.</div>
    </>;
}

/* ---- Documents ---- */
function Documents({ l }: { l: Lease }) {
    const docs = l.documents || [];
    return <>
        <div className="section-head"><h3>Contract documents</h3><button className="btn btn-ghost" id="doc-add" onClick={() => go('import', { attachTo: l.id })}>Attach and read a document</button></div>
        <div className="pad">{docs.length ? docs.map((d, i) => <div key={i} style={{ marginBottom: '16px' }}><h4>{d.name}</h4><p className="note">{`Added ${fmtDate((d.addedAt || '').slice(0, 10))}. ${d.fields ? Object.keys(d.fields).length + ' terms found.' : ''}`}</p><button className="btn btn-ghost btn-sm" data-doc={i} onClick={() => Modal.open(d.name, <div className="doc-view card" style={{ maxHeight: '65vh' }} dangerouslySetInnerHTML={{ __html: highlightText(d.text || '', d.hits || []) }} />, { wide: true })}>View with highlights</button></div>) : <p className="empty">No documents attached. Attach the signed contract to keep the source of each term with the lease.</p>}</div>
    </>;
}

/* ---- Audit trail ---- */
function History({ l }: { l: Lease }) {
    const items = (l.history || []).slice().reverse();
    return <div className="pad"><ul className="timeline">{items.length ? items.map((h, i) => <li key={i}><div className="when">{`${fmtDateTime(h.at)} by ${h.actorName || 'Unknown'}`}</div>{h.text}</li>) : <li>No history yet.</li>}</ul></div>;
}

/* ---- A change awaiting approval ---- */
function PendingEventBanner({ l, e }: { l: Lease; e: LeaseEvent }) {
    return <div className="banner warn"><div style={{ minWidth: 0, flex: 1 }}><strong>{EVENT_TYPES[e.type].label}: awaiting approval</strong><p>{`Effective ${fmtDate(e.effective)}. Submitted by ${e.submittedByName || 'a user'} on ${fmtDate(e.submittedOn)}. ${e.reason || ''}`}{' '}<strong>{eventApprovalProgress(l, e)}.</strong></p><EventImpact lease={l} event={e} /></div>
        <div className="banner-actions"><button className="btn" data-ev-approve={e.id} {...gate('approve')} onClick={() => approveEvent(l, e.id)}>Approve</button><button className="btn btn-danger" data-ev-reject={e.id} {...gate('approve')} onClick={() => rejectEvent(l, e.id)}>Reject</button></div></div>;
}

/* ======================================================================
   Lease detail
   ====================================================================== */
export function LeaseDetailPage({ params: p }: ScreenProps<'detail'>) {
    useAppState();
    const l = Store.get(p.id);
    const focus = p.focus;
    useEffect(() => {
        if (focus !== 'pending') return;
        const el = document.querySelector('#detail .banner.warn');
        if (el) el.scrollIntoView({ block: 'center' });
        p.focus = null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    if (!l) return <div className="card empty">This lease could not be found.</div>;
    const res = getResult(l), st = statusOf(l, AS_OF), T = l.terms, lr = l.role === 'lessor';
    const b = res ? balanceAt(res, AS_OF) : { L: 0, A: 0, accrued: 0, prepaid: 0 };
    const nextPay = paymentRows().filter(x => x.leaseId === l.id && x.status !== 'paid').sort((a, c) => a.dueDate.localeCompare(c.dueDate))[0];
    const pendingEvents = (l.events || []).filter(e => e.status === 'pending');
    const live = isLive(l) && ['active', 'future'].includes(st);
    const tab = (p.tab || 'summary') as Tab;
    const rate = res && 'annualRate' in res.initial && res.initial.annualRate != null ? res.initial.annualRate : null;

    const edit = () => go('entry', { mode: 'edit', id: l.id });
    const del = () => confirmDialog('Delete lease', `Delete ${l.id}? This cannot be undone.`, 'Delete lease', async () => { if (!await Store.remove(l.id)) return; toast('Lease deleted'); go('register', {}, { reset: true }); });
    const tabs: [Tab, string][] = [['summary', 'Summary'], ['schedule', 'Schedule'], ['journals', 'Journal entries'], ['payments', lr ? 'Receipts' : 'Payments'], ['events', 'Changes'], ['documents', 'Documents'], ['history', 'Audit trail']];
    let panel: ReactNode;
    switch (tab) {
        case 'schedule': panel = <Schedule l={l} p={p} />; break;
        case 'journals': panel = <LeaseJournals l={l} />; break;
        case 'payments': panel = <LeasePayments l={l} p={p} />; break;
        case 'events': panel = <Events l={l} />; break;
        case 'documents': panel = <Documents l={l} />; break;
        case 'history': panel = <History l={l} />; break;
        default: panel = <div className="pad"><Summary l={l} res={res} /></div>;
    }

    return <>
        {l.status === 'pending' ? <div className="banner warn" id="pending-banner"><div><strong>New lease awaiting approval</strong><p>{`Submitted by ${lastSubmitter(l)}. It is excluded from balances, journals and reports until approved.`}{' '}<strong>{leaseApprovalProgress(l)}.</strong></p></div><div className="banner-actions"><button className="btn" data-a="approve-lease" {...gate('approve')} onClick={() => approveLease(l)}>Approve</button><button className="btn btn-danger" data-a="reject-lease" {...gate('approve')} onClick={() => rejectLease(l)}>Reject</button></div></div> : null}
        {l.status === 'draft' ? <div className="banner"><div><strong>Draft</strong><p>Finish the details and submit it. Drafts are excluded from balances and reports.</p></div><div className="banner-actions"><button className="btn" data-a="edit" {...gate('lease.edit')} onClick={edit}>Continue editing</button></div></div> : null}
        {pendingEvents.map(e => <PendingEventBanner key={e.id} l={l} e={e} />)}
        <div className="card" style={{ marginBottom: '14px' }}>
            <div className="detail-head">
                <div><h2>{l.name || l.id}</h2>
                    <div className="meta"><span>{l.id}</span><StatusBadge status={st} /><span>{cap(l.role)}</span><span>{measurementType(l)}</span><span>{l.counterparty}</span>{l.location ? <span>{l.location}</span> : null}</div></div>
                <div className="btn-row" style={{ alignSelf: 'flex-start' }}>
                    {l.status === 'draft' || l.status === 'pending' || l.status === 'rejected' ? <button className="btn" data-a="edit" {...gate('lease.edit')} onClick={edit}>Edit</button> : null}
                    {live ? <><button className="btn" data-a="event" {...gate('lease.change')} onClick={() => openEventWizard(l)}>Remeasure or modify</button><button className="btn btn-ghost" data-a="pay" {...gate('payment.record')} onClick={() => openPaymentModal(l.id)}>{lr ? 'Record receipt' : 'Record payment'}</button><button className="btn btn-ghost" data-a="edit" {...gate('lease.edit')} onClick={edit}>Edit details</button><button className="btn btn-danger" data-a="terminate" {...gate('lease.change')} onClick={() => openEventWizard(l, 'terminate')}>Terminate</button></> : null}
                    <button className="btn btn-ghost" data-a="ai" {...gate('ai.use')} onClick={() => go('ai', { leaseId: l.id }, { reset: true })}>Ask AI about this lease</button>
                    {!isLive(l) ? <button className="btn btn-danger" data-a="delete" {...gate('lease.delete')} onClick={del}>Delete</button> : null}
                </div>
            </div>
        </div>
        <div className="position">
            {res && res.mode === 'lessee' ? <><div className="pos"><div className="l">Lease liability</div><div className="v">{money(b.L)}</div><div className="s">{`${l.currency}, at ${fmtDate(AS_OF)}`}</div></div><div className="pos"><div className="l">Right-of-use asset</div><div className="v">{money(b.A)}</div><div className="s">Initial {fmtNum(res.initial.rou)}</div></div></> : null}
            {res && res.mode === 'lessor-finance' ? <div className="pos"><div className="l">Net investment</div><div className="v">{money(b.L)}</div><div className="s">Implicit rate {pct(res.initial.annualRate)}</div></div> : null}
            {res && res.mode === 'lessor-operating' ? <><div className="pos"><div className="l">Lease income per month</div><div className="v">{money(res.initial.monthlyIncome)}</div><div className="s">Straight-line</div></div><div className="pos"><div className="l">Accrued / (deferred) income</div><div className="v">{money(b.accrued)}</div></div></> : null}
            {res && res.mode === 'exempt' ? <div className="pos"><div className="l">Expense per month</div><div className="v">{money(res.initial.monthlyExpense)}</div><div className="s">{cap(res.exemption)} exemption</div></div> : null}
            <div className="pos"><div className="l">Next {lr ? 'receipt' : 'payment'}</div><div className="v">{nextPay ? money(nextPay.amount) : '—'}</div><div className="s">{nextPay ? (nextPay.status === 'overdue' ? 'Overdue since ' : 'Due ') + fmtDate(nextPay.dueDate) : 'None scheduled'}</div></div>
            <div className="pos"><div className="l">Lease term</div><div className="v">{res ? res.termMonths : N(T.termMonths)} months</div><div className="s">{`${fmtDate(T.commencement)} to ${fmtDate(leaseEnd(l))}`}</div></div>
            <div className="pos"><div className="l">Discount rate</div><div className="v">{rate != null ? pct(rate) : pct(T.discountRate)}</div><div className="s">{T.rateBasis === 'solve' ? 'Rate implicit in the lease' : lr ? 'Rate implicit in the lease' : 'Incremental borrowing rate'}</div></div>
        </div>
        <div className="card">
            <div className="tabs" role="tablist">
                {tabs.map(([k, v]) => <button key={k} className={`tab${tab === k ? ' active' : ''}`} data-t={k} onClick={() => setParams<'detail'>({ tab: k })}>{v}{k === 'events' && pendingEvents.length ? <span className="dot"></span> : null}</button>)}
            </div>
            <div id="d-panel">{panel}</div>
        </div>
    </>;
}
