import { useMemo, useRef } from 'react';
import type { ScreenProps } from './registry';
import { ASSET_CLASSES } from '../domain/settings';
import { STATUS_LABEL } from '../domain/lease';
import { registerRows, type RegisterRow } from '../domain/reporting';
import { gate } from '../domain/enterprise';
import { go } from '../domain/nav';
import { AS_OF } from '../domain/state';
import { useAppState } from '../hooks/useAppState';
import { DataTable, type Column, type DataTableApi } from '../components/common/DataTable';
import { StatusBadge } from '../components/common/Badges';
import { exportMenu } from '../components/common/ExportMenu';
import { fmtNum } from '../utils/format';
import { fmtDate } from '../utils/dates';

const openLease = (id: string) => go('detail', { id });

function leaseColumns(): Column<RegisterRow>[] {
    return [
        { key: 'id', label: 'Lease', type: 'text', render: r => <button className="link" onClick={e => { e.stopPropagation(); openLease(r.id); }}>{r.id}</button> },
        { key: 'name', label: 'Description', type: 'text' },
        { key: 'role', label: 'Role', type: 'enum' },
        { key: 'assetClass', label: 'Asset class', type: 'enum' },
        { key: 'counterparty', label: 'Counterparty', type: 'text' },
        { key: 'location', label: 'Location', type: 'enum' },
        { key: 'measurement', label: 'Accounting', type: 'enum' },
        { key: 'commencement', label: 'Commencement', type: 'date', format: v => fmtDate(v as string) },
        { key: 'end', label: 'End (lease term)', type: 'date', format: v => fmtDate(v as string) },
        { key: 'currency', label: 'Ccy', type: 'enum' },
        { key: 'payment', label: 'Payment', type: 'number', format: v => fmtNum(v) },
        { key: 'frequency', label: 'Frequency', type: 'enum' },
        { key: 'rate', label: 'Rate %', type: 'number', format: v => v ? Number(v).toFixed(2) : '—' },
        { key: 'liability', label: 'Liability / net inv.', type: 'number', format: v => v === null ? '—' : fmtNum(v), total: true },
        { key: 'rou', label: 'ROU asset', type: 'number', format: v => v === null ? '—' : fmtNum(v), total: true },
        { key: 'status', label: 'Status', type: 'enum', value: r => STATUS_LABEL[r.status], render: r => <StatusBadge status={r.status} /> },
    ];
}

export function RegisterPage({ params: p }: ScreenProps<'register'>) {
    const version = useAppState();
    const api = useRef<DataTableApi | null>(null);
    const columns = useMemo(leaseColumns, []);

    const { rows, desc } = useMemo(() => {
        let rows = registerRows(AS_OF);
        let desc = '';
        if (p.preset === 'liability') { rows = rows.filter(r => r.role === 'Lessee' && (r.liability ?? 0) > 0.5 && r.measurement === 'Right-of-use model'); desc = 'Lessee leases that make up the lease liability. Totals are in each lease’s own currency.'; }
        if (p.preset === 'rou') { rows = rows.filter(r => (r.rou ?? 0) > 0.5); desc = 'Leases carrying a right-of-use asset.'; }
        if (p.preset === 'ni') { rows = rows.filter(r => r.role === 'Lessor' && r.measurement.startsWith('Finance')); desc = 'Lessor finance leases (net investment).'; }
        if (p.preset && p.preset.startsWith('class:')) { const k = p.preset.slice(6); rows = rows.filter(r => r.assetClass === (ASSET_CLASSES[k] || k) && r.role === 'Lessee'); desc = `Lessee leases in ${ASSET_CLASSES[k] || k}.`; }
        return { rows, desc };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [p.preset, version]);

    return (
        <div className="card">
            <div className="section-head">
                <div><h2>{p.preset ? 'Filtered register' : 'All leases'}</h2>{desc && <p className="note">{desc}</p>}</div>
                <div className="btn-row">
                    <button className="btn btn-ghost" id="r-exp" onClick={e => exportMenu(e.currentTarget, () => [{ name: 'Lease register', rows: api.current ? api.current.exportRows() : [] }], 'Lease_register', `Lease register at ${fmtDate(AS_OF)}`)}>Export</button>
                    <button className="btn btn-ghost" id="r-imp" {...gate('lease.import')} onClick={() => go('import', {}, { reset: true })}>Import</button>
                    <button className="btn" id="r-new" {...gate('lease.edit')} onClick={() => go('entry', { mode: 'new' }, { reset: true })}>Add lease</button>
                </div>
            </div>
            <div id="r-table">
                <DataTable columns={columns} rows={rows} searchPlaceholder="Search leases" onRowClick={r => openLease(r.id)} apiRef={api} />
            </div>
            <div className="table-note">Balances at {fmtDate(AS_OF)}. Use the filter icon on any column, as in Excel. Totals add up different currencies only when one currency is shown, so filter by currency first.</div>
        </div>
    );
}
