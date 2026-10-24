import { useState } from 'react';
import { EVENT_TYPES } from '../domain/engine';
import { SETTINGS } from '../domain/settings';
import { Store } from '../domain/store';
import { measurementType } from '../domain/lease';
import { checkApproval, eventAmount, gate, leaseAmount, type ApprovalCheck } from '../domain/enterprise';
import { pendingApprovals, approveEvent, approveLease, eventApprovalProgress, lastSubmitter, leaseApprovalProgress, rejectEvent, rejectLease, type PendingItem } from '../domain/approvals';
import { go } from '../domain/nav';
import { useAppState } from '../hooks/useAppState';
import { EventImpact } from '../components/lease/EventImpact';
import { MeasurementPanel } from '../components/lease/MeasurementPanel';
import { fmtNum } from '../utils/format';
import { fmtDate } from '../utils/dates';

async function decide(a: PendingItem, ok: boolean): Promise<void> {
    const l = Store.get(a.lease.id);
    if (!l) return;
    if (a.kind === 'lease') { if (ok) await approveLease(l); else rejectLease(l); }
    else if (ok) await approveEvent(l, a.event.id);
    else rejectEvent(l, a.event.id);
}

const I = {
    lease: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M12 18v-6M9 15h6',
    change: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
    calendar: 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM16 2v4M8 2v4M3 10h18',
    user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    coins: 'M12 7a8 3 0 1 0 0-.01zM4 7v5c0 1.66 3.58 3 8 3s8-1.34 8-3V7M4 12v5c0 1.66 3.58 3 8 3s8-1.34 8-3v-5',
    shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
    info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 16v-4M12 8h.01',
    check: 'M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14l-3-3',
    chevron: 'M6 9l6 6 6-6',
    open: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
};
const Ic = ({ d, size = 15 }: { d: string; size?: number }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

/** What a card shows about one pending item: amount, who submitted it, approval progress and whether I may approve. */
interface Row { a: PendingItem; ref: string; amount: number; progress: string; submitter: string; submittedOn: string; check: ApprovalCheck }
function rowFor(a: PendingItem): Row {
    const ref = `${a.kind}:${a.lease.id}:${a.event ? a.event.id : ''}`;
    if (a.kind === 'lease') {
        const sub = (a.lease.history || []).slice().reverse().find(h => /submitted|imported/i.test(h.text));
        const amount = leaseAmount(a.lease);
        return { a, ref, amount, progress: leaseApprovalProgress(a.lease), submitter: lastSubmitter(a.lease), submittedOn: sub ? sub.at : '', check: checkApproval('lease', a.lease, amount, sub && sub.actor) };
    }
    const amount = eventAmount(a.lease, a.event);
    return { a, ref, amount, progress: eventApprovalProgress(a.lease, a.event), submitter: a.event.submittedByName || 'a user', submittedOn: a.event.submittedOn || '', check: checkApproval('change', a.event, amount, a.event.submittedBy) };
}

type Filter = 'all' | 'lease' | 'event';

function ApprovalCard({ row, open, onToggle }: { row: Row; open: boolean; onToggle: () => void }) {
    const { a, ref, check } = row;
    const [busy, setBusy] = useState(false);
    const approve = async () => { setBusy(true); try { await decide(a, true); } finally { setBusy(false); } };
    const given = (a.kind === 'lease' ? a.lease.approvals : a.event.approvals) || [];
    const needed = Math.max(check.needed || 1, given.length);
    const reason = a.kind === 'event' ? (a.event.reason || '').trim() : '';
    const ccy = SETTINGS.functionalCurrency;
    const approveGate = gate('approve');
    // "0 of 1 approval (Controller / Administrator)": the count, then who may give it
    const m = /^(.*?) \((.*)\)$/.exec(row.progress), progress = m ? { count: m[1], roles: m[2] } : { count: row.progress, roles: '' };
    return (
        <article className={`card appr-card appr-${a.kind}`} data-item={ref}>
            <div className="appr-main">
                <span className="appr-ic"><Ic d={a.kind === 'lease' ? I.lease : I.change} size={18} /></span>
                <div className="appr-info">
                    <div className="appr-kind"><span className={`badge ${a.kind === 'lease' ? 'badge-info' : 'badge-pending'}`}>{a.kind === 'lease' ? `New ${measurementType(a.lease).toLowerCase()}` : EVENT_TYPES[a.event.type].label}</span></div>
                    <h3 className="appr-title"><button type="button" className="appr-id" onClick={() => go('detail', { id: a.lease.id })}>{a.lease.id}</button><span>{a.lease.name}</span></h3>
                    <div className="appr-meta">
                        <span><Ic d={I.calendar} />{a.kind === 'lease' ? `Commences ${fmtDate(a.lease.terms.commencement)}` : `Effective ${fmtDate(a.event.effective)}`}</span>
                        <span><Ic d={I.user} />Submitted by {row.submitter}{row.submittedOn ? ` on ${fmtDate(row.submittedOn.slice(0, 10))}` : ''}</span>
                        <span><Ic d={I.coins} />{a.kind === 'lease' ? 'Liability' : 'Amount'} <b>{fmtNum(row.amount)}</b> {ccy}</span>
                    </div>
                    {reason ? <p className="appr-reason">{reason}</p> : null}
                </div>
                <div className="appr-side">
                    <div className="appr-progress" title={row.progress}>
                        <span><b><span className="appr-dots" aria-hidden="true">{Array.from({ length: needed }, (_, i) => <i key={i} className={i < given.length ? 'on' : ''} />)}</span>{progress.count}</b>{progress.roles ? <small>{`By ${progress.roles.split(' / ').join(', ').replace(/, ([^,]*)$/, ' or $1')}`}</small> : null}</span>
                    </div>
                    <div className="appr-actions">
                        <button className="btn btn-ghost btn-sm" data-open={a.lease.id} onClick={() => go('detail', { id: a.lease.id })}><Ic d={I.open} size={14} />Open</button>
                        <button className="btn btn-danger btn-sm" data-no={ref} {...approveGate} disabled={approveGate.disabled || busy} onClick={() => void decide(a, false)}>Reject</button>
                        <button className="btn btn-sm" data-ok={ref} {...approveGate} disabled={approveGate.disabled || busy} onClick={() => void approve()}>{busy ? <><span className="spinner" aria-hidden="true" />Approving…</> : 'Approve'}</button>
                    </div>
                    {!check.ok && !approveGate.hidden ? <p className="appr-why"><Ic d={I.info} size={14} />{check.reason}</p> : null}
                </div>
            </div>
            <button type="button" className="appr-toggle" aria-expanded={open} onClick={onToggle}>
                {open ? 'Hide' : 'Show'} {a.kind === 'lease' ? 'measurement and entry' : 'impact and journal entry'}<Ic d={I.chevron} size={15} />
            </button>
            {open ? <div className="appr-details">{a.kind === 'event' ? <EventImpact lease={a.lease} event={a.event} /> : <div className="appr-measure"><MeasurementPanel lease={a.lease} /></div>}</div> : null}
        </article>
    );
}

export function ApprovalsPage() {
    useAppState();
    const list = pendingApprovals();
    const rows = list.map(rowFor);
    const [filter, setFilter] = useState<Filter>('all');
    // The first item opens with its details; the rest open on request
    const [opened, setOpened] = useState<Set<string>>(() => new Set(rows.length ? [rows[0].ref] : []));
    const shown = rows.filter(r => filter === 'all' || r.a.kind === filter);
    const counts = { all: rows.length, lease: rows.filter(r => r.a.kind === 'lease').length, event: rows.filter(r => r.a.kind === 'event').length };
    const total = rows.reduce((s, r) => s + r.amount, 0);
    const allOpen = shown.length > 0 && shown.every(r => opened.has(r.ref));
    const toggle = (ref: string) => setOpened(prev => { const n = new Set(prev); if (n.has(ref)) n.delete(ref); else n.add(ref); return n; });
    const setAll = (on: boolean) => setOpened(prev => { const n = new Set(prev); shown.forEach(r => on ? n.add(r.ref) : n.delete(r.ref)); return n; });

    return (
        <div className="appr">
            <div className="appr-head">
                <div>
                    <h2>Waiting for approval</h2>
                    <p className="appr-policy"><Ic d={I.shield} size={14} />{SETTINGS.segregateApproval ? 'Preparers cannot approve their own submissions.' : 'Preparers may approve their own submissions (Settings).'}</p>
                </div>
                <div className="appr-stats" aria-label="Summary">
                    <div className="appr-stat"><b>{counts.all}</b><span>waiting</span></div>
                    <div className="appr-stat"><b>{counts.lease}</b><span>new {counts.lease === 1 ? 'lease' : 'leases'}</span></div>
                    <div className="appr-stat"><b>{counts.event}</b><span>{counts.event === 1 ? 'change' : 'changes'}</span></div>
                    <div className="appr-stat"><b>{fmtNum(total)}</b><span>{SETTINGS.functionalCurrency} in total</span></div>
                </div>
            </div>
            {rows.length ? <>
                <div className="appr-bar">
                    <div className="appr-filter" role="group" aria-label="Show">
                        {([['all', 'All'], ['lease', 'New leases'], ['event', 'Changes']] as [Filter, string][]).map(([k, label]) => (
                            <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}<span>{counts[k]}</span></button>
                        ))}
                    </div>
                    {shown.length ? <button type="button" className="link appr-expand" onClick={() => setAll(!allOpen)}>{allOpen ? 'Collapse all' : 'Expand all'}</button> : null}
                </div>
                <div className="appr-list">
                    {shown.length ? shown.map(r => <ApprovalCard key={r.ref} row={r} open={opened.has(r.ref)} onToggle={() => toggle(r.ref)} />)
                        : <div className="card appr-empty"><p className="empty">Nothing in this group.</p></div>}
                </div>
            </> : (
                <div className="card appr-empty">
                    <span className="appr-empty-ic"><Ic d={I.check} size={26} /></span>
                    <p className="empty">Nothing is waiting for approval.</p>
                    <p className="note">New leases and lease changes submitted for approval appear here.</p>
                    <button className="btn btn-ghost btn-sm" onClick={() => go('register', {}, { reset: true })}>Open the lease register</button>
                </div>
            )}
        </div>
    );
}
