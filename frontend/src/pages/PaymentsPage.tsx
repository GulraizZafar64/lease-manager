import { useMemo, useRef } from 'react';
import type { ScreenProps } from './registry';
import { addDays, addMonths } from '../domain/engine';
import { gate } from '../domain/enterprise';
import { paymentRows, PAY_STATUS, type PaymentRow } from '../domain/payments';
import { go, setParams } from '../domain/nav';
import { AS_OF } from '../domain/state';
import { useAppState } from '../hooks/useAppState';
import { DataTable, type Column, type DataTableApi } from '../components/common/DataTable';
import { exportMenu } from '../components/common/ExportMenu';
import { openPaymentModal } from '../components/lease/PaymentModal';
import { fmtNum } from '../utils/format';
import { fmtDate } from '../utils/dates';

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

    return (
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
    );
}
