import { useEffect, useRef, useState } from 'react';
import { Chart } from 'chart.js';
import { SETTINGS } from '../../domain/settings';
import { Store } from '../../domain/store';
import { Ent, FX_MISSING, ROLES, loadAudit, nameOf, realRole, resolveNames, roleLabel } from '../../domain/enterprise';
import { clearResults, getResult, isLive } from '../../domain/lease';
import { runValidation } from '../../domain/validation';
import { getSample } from '../../domain/ai';
import { aiStatus } from '../../domain/aiServer';
import { USE_API } from '../../api/client';
import { useAppState } from '../../hooks/useAppState';
import { DataTable, type Column, type DataTableApi } from '../common/DataTable';
import { exportMenu } from '../common/ExportMenu';
import { fmtDateTime } from '../../utils/dates';

type Check = 'ok' | 'warn' | 'bad';
type MonitorRow = [label: string, value: string, check: Check];

async function monitorRows(): Promise<MonitorRow[]> {
    const t0 = performance.now(); clearResults(); let fails = 0; for (const l of Store.all) { if (!getResult(l) && l.terms.commencement) fails++; } const ms = performance.now() - t0;
    const v = runValidation(), vp = v.filter(x => x.pass).length;
    const ai = await getSample(), aiSrv = USE_API ? await aiStatus().catch(() => null) : null, dl = window.claude && window.claude.use ? await window.claude.use('downloads').catch(() => null) : null;
    const auditN = (await loadAudit(5000)).length;
    const charts = typeof Chart !== 'undefined';
    return [
        ['Storage', Store.mode === 'db' ? 'Shared workspace (Claude platform database), live updates' : Store.mode === 'api' ? 'Company server (leases, settings, users and roles)' : Store.mode === 'local' ? 'This browser only' : 'Session only', Store.mode === 'db' || Store.mode === 'api' ? 'ok' : 'warn'],
        ['Signed-in user', Store.me && Store.me.id ? `${Store.actorName()} (${roleLabel(realRole())})` : 'No verified identity', Store.me && Store.me.id ? 'ok' : 'warn'],
        ['Write access', Store.writeable ? 'Yes' : 'View only', Store.writeable ? 'ok' : 'warn'],
        ['Leases', `${Store.all.length} (${Store.all.filter(isLive).length} live, ${Store.all.filter(l => l.status === 'pending').length} pending)`, 'ok'],
        ['Calculation engine', `${Store.all.length} leases measured in ${ms.toFixed(0)} ms${fails ? `; ${fails} could not be measured` : ''}`, fails ? 'warn' : 'ok'],
        ['Validation suite', `${vp} of ${v.length} worked examples reproduced`, vp === v.length ? 'ok' : 'bad'],
        ['Users / audit entries', `${Ent.users.items.length} users, ${auditN} audit entries`, 'ok'],
        ['Bank statements / batches / ERP files', `${Ent.bank.items.length} / ${Ent.batches.items.length} / ${Ent.exports.items.length}`, 'ok'],
        ['Exchange rates', FX_MISSING.size ? `Missing: ${[...FX_MISSING].join(', ')}` : 'All currencies in use have rates', FX_MISSING.size ? 'bad' : 'ok'],
        ['AI (Claude)', aiSrv ? (aiSrv.available ? `On the company server; US$${aiSrv.usedUsd.toFixed(2)} of US$${aiSrv.limitUsd.toFixed(2)} used this month${aiSrv.paused ? '; paused: the server’s allowance for the month is used up' : ''}` : 'Not set up on the server (ANTHROPIC_API_KEY)') : ai ? 'Available; each use asks your permission the first time' : 'Not available in this view', ai && !(aiSrv && aiSrv.paused) ? 'ok' : 'warn'],
        ['File downloads', dl ? 'Available' : 'Browser fallback', dl ? 'ok' : 'warn'],
        ['Charts library', charts ? 'Loaded' : 'Not loaded', charts ? 'ok' : 'warn'],
        ['Last backup', SETTINGS.lastBackup ? fmtDateTime(SETTINGS.lastBackup) : 'Never', SETTINGS.lastBackup && (Date.now() - new Date(SETTINGS.lastBackup).getTime()) / 864e5 < 35 ? 'ok' : 'warn'],
        ['Session', `Up ${Math.round((Date.now() - Ent.started) / 60000)} minutes; ${Ent.errors.length} script errors`, Ent.errors.length ? 'warn' : 'ok'],
    ];
}

/** Administration › System monitor. */
export function MonitorTab() {
    const version = useAppState();
    const [rows, setRows] = useState<MonitorRow[] | null>(null);
    useEffect(() => {
        let live = true;
        monitorRows().then(r => { if (live) setRows(r); });
        return () => { live = false; };
    }, [version]);
    if (!rows) return null;
    return (
        <>
            <table className="stmt" style={{ maxWidth: '860px' }}><tbody>{rows.map(r => <tr key={r[0]}><td>{r[0]}</td><td className="wrap">{r[1]}</td><td><span className={`badge badge-${r[2] === 'ok' ? 'ok' : r[2] === 'bad' ? 'bad' : 'pending'}`}>{r[2] === 'ok' ? 'OK' : r[2] === 'bad' ? 'Action needed' : 'Check'}</span></td></tr>)}</tbody></table>
            {Ent.errors.length ? <><h3 style={{ marginTop: '14px' }}>Script errors this session</h3><div className="scroll-x"><table><tbody>{Ent.errors.slice(-20).map((e, i) => <tr key={i}><td>{e.at}</td><td className="wrap">{e.msg}</td></tr>)}</tbody></table></div></> : null}
        </>
    );
}

interface AuditRow { at: string; who: string; role: string; action: string; lease: string; entity: string; detail: string }
const AUDIT_COLUMNS: Column<AuditRow>[] = [
    { key: 'at', label: 'When', type: 'date', format: v => fmtDateTime(v as string) },
    { key: 'who', label: 'User', type: 'enum' },
    { key: 'role', label: 'Role', type: 'enum' },
    { key: 'action', label: 'Action', type: 'enum' },
    { key: 'lease', label: 'Lease', type: 'text' },
    { key: 'entity', label: 'Entity', type: 'enum' },
    { key: 'detail', label: 'Detail', type: 'text', render: r => <span style={{ whiteSpace: 'normal' }}>{r.detail}</span> },
];

/** Administration › Audit log. */
export function AuditTab() {
    const version = useAppState();
    const api = useRef<DataTableApi | null>(null);
    const [rows, setRows] = useState<AuditRow[] | null>(null);
    useEffect(() => {
        let live = true;
        (async () => {
            const all = await loadAudit(2000);
            await resolveNames(all.map(a => a.actor));
            const r = all.map(a => ({ at: a.at, who: a.actorName || nameOf(a.actor), role: (ROLES as Record<string, { label: string }>)[a.role] ? (ROLES as Record<string, { label: string }>)[a.role].label : a.role || '', action: a.action, lease: a.leaseId || '', entity: a.entity || '', detail: a.detail }));
            if (live) setRows(r);
        })();
        return () => { live = false; };
    }, [version]);
    if (!rows) return <p className="note"><span className="spinner"></span> Loading…</p>;
    return (
        <>
            <div className="section-head" style={{ padding: '0 0 10px', border: 'none' }}><p className="note">Every lease change, approval, export, setting, user change, bank match and AI request, newest first (last 2,000). Retention: {(SETTINGS.retention || { auditYears: 0 }).auditYears || 10} years.</p><button className="btn btn-ghost btn-sm" id="au-exp" onClick={e => exportMenu(e.currentTarget, () => [{ name: 'Audit log', rows: api.current ? api.current.exportRows() : [] }], 'Audit_log', 'Audit log')}>Export</button></div>
            <div id="au-t"><DataTable columns={AUDIT_COLUMNS} rows={rows} searchPlaceholder="Search the audit log" apiRef={api} /></div>
        </>
    );
}
