import { EVENT_TYPES } from '../domain/engine';
import { SETTINGS } from '../domain/settings';
import { Store } from '../domain/store';
import { measurementType } from '../domain/lease';
import { gate } from '../domain/enterprise';
import { pendingApprovals, approveEvent, approveLease, rejectEvent, rejectLease, type PendingItem } from '../domain/approvals';
import { go } from '../domain/nav';
import { useAppState } from '../hooks/useAppState';
import { EventImpact } from '../components/lease/EventImpact';
import { MeasurementPanel } from '../components/lease/MeasurementPanel';
import { fmtDate } from '../utils/dates';

function decide(a: PendingItem, ok: boolean): void {
    const l = Store.get(a.lease.id);
    if (!l) return;
    if (a.kind === 'lease') { if (ok) void approveLease(l); else rejectLease(l); }
    else if (ok) void approveEvent(l, a.event.id);
    else rejectEvent(l, a.event.id);
}

export function ApprovalsPage() {
    useAppState();
    const list = pendingApprovals();
    return (
        <div className="card">
            <div className="section-head"><h2>Waiting for approval</h2><span className="note">{SETTINGS.segregateApproval ? 'Preparers cannot approve their own submissions.' : 'Preparers may approve their own submissions (Settings).'}</span></div>
            {list.length ? list.map(a => {
                const ref = `${a.kind}:${a.lease.id}:${a.event ? a.event.id : ''}`;
                return (
                    <div key={ref} className="pad" style={{ borderBottom: '1px solid var(--line)' }}>
                        <div className="btn-row" style={{ justifyContent: 'space-between' }}>
                            <div><strong>{a.lease.id}</strong> {a.lease.name}<div className="note">{a.kind === 'lease' ? `New ${measurementType(a.lease).toLowerCase()}, commencing ${fmtDate(a.lease.terms.commencement)}` : `${EVENT_TYPES[a.event.type].label}, effective ${fmtDate(a.event.effective)}. ${a.event.reason || ''}`}</div></div>
                            <div className="btn-row">
                                <button className="btn btn-ghost btn-sm" data-open={a.lease.id} onClick={() => go('detail', { id: a.lease.id })}>Open</button>
                                <button className="btn btn-sm" data-ok={ref} {...gate('approve')} onClick={() => decide(a, true)}>Approve</button>
                                <button className="btn btn-danger btn-sm" data-no={ref} {...gate('approve')} onClick={() => decide(a, false)}>Reject</button>
                            </div>
                        </div>
                        {a.kind === 'event' ? <EventImpact lease={a.lease} event={a.event} /> : <div style={{ marginTop: '10px', maxWidth: '520px' }}><MeasurementPanel lease={a.lease} /></div>}
                    </div>
                );
            }) : <p className="empty">Nothing is waiting for approval.</p>}
        </div>
    );
}
