import { useMemo, useRef, type ReactNode } from 'react';
import type { ChartConfiguration } from 'chart.js';
import type { ScreenProps } from './registry';
import { addDays, addMonths } from '../domain/engine';
import { fxConvert, gate, presentationCcy } from '../domain/enterprise';
import { paymentRows, PAY_STATUS, type PaymentRow } from '../domain/payments';
import { go, setParams } from '../domain/nav';
import { AS_OF } from '../domain/state';
import { useAppState } from '../hooks/useAppState';
import { DataTable, type Column, type DataTableApi } from '../components/common/DataTable';
import { exportMenu } from '../components/common/ExportMenu';
import { openPaymentModal } from '../components/lease/PaymentModal';
import { BAR, baseOptions, markerLine, vizTheme } from '../components/common/ChartCanvas';
import { VizCard } from '../components/common/Viz';
import { fmtNum, sum, unitNote } from '../utils/format';
import { fmtDate, monthLabel } from '../utils/dates';

type PayWindow = 'open' | 'month' | 'all';

function payColumns(): Column<PaymentRow>[] {
    return [
        { key: 'leaseId', label: 'Lease', type: 'text', render: r => <button className="link" data-act="open" onClick={e => { e.stopPropagation(); go('detail', { id: r.leaseId, tab: 'payments', highlight: r.key }); }}>{r.leaseId}</button> },
        { key: 'name', label: 'Description', type: 'text' },
        { key: 'dueDate', label: 'Due', type: 'date', format: v => fmtDate(v as string) },
        { key: 'type', label: 'Type', type: 'enum' }, { key: 'kind', label: 'For', type: 'enum' }, { key: 'currency', label: 'Ccy', type: 'enum' },
        { key: 'amount', label: 'Amount', type: 'number', format: v => fmtNum(v), total: true },
        { key: 'paid', label: 'Paid', type: 'number', format: v => fmtNum(v), total: true },
        { key: 'outstanding', label: 'Outstanding', type: 'number', format: v => fmtNum(v), total: true },
        { key: 'daysLate', label: 'Days late', type: 'number', format: v => v ? String(v) : '' },
        { key: 'lateCharge', label: 'Late charge', type: 'number', format: v => v ? fmtNum(v) : '' },
        { key: 'status', label: 'Status', type: 'enum', value: r => PAY_STATUS[r.status][0], render: r => <span className={`badge badge-${PAY_STATUS[r.status][1]}`}>{PAY_STATUS[r.status][0]}</span> },
        { key: '_a', label: '', noFilter: true, render: r => r.status === 'paid' ? '' : <button className="btn btn-ghost btn-sm" data-act="record" {...gate('payment.record')} onClick={e => { e.stopPropagation(); openPaymentModal(r.leaseId, r.key); }}>Record</button> },
    ];
}

/* ---- Summary: what is overdue, what falls due soon, and settled against outstanding by month ----
   Amounts are translated to the presentation currency at today's rates; payments and receipts are counted together. */
const inP = (r: PaymentRow, v: number) => fxConvert(v, r.currency, AS_OF);

function PaySummary({ rows }: { rows: PaymentRow[] }) {
    const P = presentationCcy();
    const open = rows.filter(r => r.status !== 'paid');
    const overdue = open.filter(r => r.status === 'overdue');
    const soon = open.filter(r => r.dueDate > AS_OF && r.dueDate <= addDays(AS_OF, 30));
    const m0 = AS_OF.slice(0, 8) + '01', m1 = addDays(addMonths(m0, 1), -1);
    const thisMonth = rows.filter(r => r.dueDate >= m0 && r.dueDate <= m1);
    const monthDue = sum(thisMonth, r => inP(r, r.amount)), monthPaid = sum(thisMonth, r => inP(r, Math.min(r.paid, r.amount)));
    const share = monthDue ? Math.min(1, monthPaid / monthDue) : 0;

    const { config, table } = useMemo(() => {
        const months = Array.from({ length: 12 }, (_, i) => { const s = addMonths(m0, i - 6); return { s, e: addDays(addMonths(s, 1), -1), settled: 0, outstanding: 0 }; });
        for (const r of rows) { const m = months.find(x => r.dueDate >= x.s && r.dueDate <= x.e); if (!m) continue; const paid = Math.min(r.paid, r.amount); m.settled += inP(r, paid); m.outstanding += inP(r, r.amount - paid); }
        const t = vizTheme(), seg = { ...BAR, maxBarThickness: 22, stack: 'p' };
        const config = {
            type: 'bar', data: { labels: months.map(m => monthLabel(m.s)), datasets: [
                { ...seg, label: 'Settled', data: months.map(m => m.settled), backgroundColor: t.series[0], borderRadius: 0, borderColor: t.surface, borderWidth: { top: 2 }, borderSkipped: 'start' },
                { ...seg, label: 'Outstanding', data: months.map(m => m.outstanding), backgroundColor: t.series[1] }] },
            options: baseOptions(t, { stacked: true, legend: true }), plugins: [markerLine(6, 'This month')],
        } as unknown as ChartConfiguration;
        return { config, table: months.map(m => [monthLabel(m.s), m.settled + m.outstanding, m.settled, m.outstanding]) };
    }, [rows, m0]);

    const Tile = ({ id, tone, label, n, amount, onClick, children }: { id: string; tone?: string; label: string; n: number; amount: number; onClick?: () => void; children?: ReactNode }) => (
        <button type="button" className={`stat-tile${tone ? ' st-' + tone : ''}`} id={id} onClick={onClick} disabled={!onClick}>
            <span className="st-l">{label}</span><span className="st-v">{fmtNum(amount)}</span>
            <span className="st-s">{n} {n === 1 ? 'item' : 'items'}</span>{children}
        </button>
    );
    return (
        <div className="pay-summary">
            <div className="stat-tiles">
                <Tile id="ps-overdue" tone={overdue.length ? 'bad' : undefined} label="Overdue" n={overdue.length} amount={sum(overdue, r => inP(r, r.outstanding))} onClick={() => setParams<'payments'>({ window: 'open' })}>
                    {overdue.length ? <span className="badge badge-bad">Action needed</span> : <span className="badge badge-ok">None overdue</span>}
                </Tile>
                <Tile id="ps-soon" label="Due in the next 30 days" n={soon.length} amount={sum(soon, r => inP(r, r.outstanding))} onClick={() => setParams<'payments'>({ window: 'open' })} />
                <Tile id="ps-month" label={`Settled, ${monthLabel(m0)}`} n={thisMonth.length} amount={monthPaid} onClick={() => setParams<'payments'>({ window: 'month' })}>
                    <span className="st-meter" role="img" aria-label={`${Math.round(share * 100)}% of ${fmtNum(monthDue)} due this month is settled`}><span style={{ width: `${share * 100}%` }} /></span>
                    <span className="st-s">{Math.round(share * 100)}% of {fmtNum(monthDue)} due</span>
                </Tile>
            </div>
            <VizCard id="ps-chart" title="Settled and outstanding, by month due" sub={`Six months either side of today, ${P}${unitNote()}. Payments and receipts together.`}
                config={config} columns={['Month', 'Due', 'Settled', 'Outstanding']} rows={table} height={220} fill empty="No scheduled payments in these months" />
        </div>
    );
}

const WINDOWS: [PayWindow, string][] = [['open', 'Open, next 3 months'], ['month', 'This month'], ['all', 'All scheduled']];

export function PaymentsPage({ params: p }: ScreenProps<'payments'>) {
    const version = useAppState();
    const api = useRef<DataTableApi | null>(null);
    const columns = useMemo(() => payColumns(), [version]); // eslint-disable-line react-hooks/exhaustive-deps
    const win = p.window || 'open';

    const rows = useMemo(() => {
        let rows = paymentRows();
        if (win === 'open') rows = rows.filter(r => r.status !== 'paid' && r.dueDate <= addMonths(AS_OF, 3));
        if (win === 'month') { const s = AS_OF.slice(0, 8) + '01', e = addDays(addMonths(s, 1), -1); rows = rows.filter(r => r.dueDate >= s && r.dueDate <= e); }
        return rows;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [win, version]);

    const all = useMemo(() => paymentRows(), [version]); // eslint-disable-line react-hooks/exhaustive-deps
    return (
        <>
        {all.length ? <PaySummary rows={all} /> : null}
        <div className="card">
            <div className="section-head">
                <div className="seg">{WINDOWS.map(([k, v]) => <button key={k} data-w={k} aria-pressed={win === k} onClick={() => setParams<'payments'>({ window: k })}>{v}</button>)}</div>
                <div className="btn-row">
                    <button className="btn btn-ghost" id="p-exp" onClick={e => exportMenu(e.currentTarget, () => [{ name: 'Payments', rows: api.current ? api.current.exportRows() : [] }], 'Payments', 'Lease payments and receipts')}>Export</button>
                    <button className="btn btn-ghost" id="p-var" {...gate('payment.record')} onClick={() => openPaymentModal(null, null, 'variable')}>Record variable payment</button>
                    <button className="btn" id="p-add" {...gate('payment.record')} onClick={() => openPaymentModal()}>Record payment or receipt</button>
                </div>
            </div>
            <div id="p-table">
                <DataTable key={win} columns={columns} rows={rows} searchPlaceholder="Search payments" apiRef={api} />
            </div>
            <div className="table-note">Late charges use each lease’s grace period and rules. They are not lease payments and are expensed when incurred.</div>
        </div>
        </>
    );
}
