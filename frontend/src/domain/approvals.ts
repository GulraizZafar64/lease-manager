/* Approval actions on leases and lease changes, with the policy-aware rules of
   the enterprise layer (tiers, limits, segregation of duties, period lock). */
import { EVENT_TYPES } from './engine';
import { SETTINGS } from './settings';
import { Store } from './store';
import { AS_OF } from './state';
import {
    approvalProgress, checkApproval, eventAmount, guard, leaseAmount, lockGuard, logHistory, myApproval,
} from './enterprise';
import { confirmDialog } from '../components/common/ConfirmDialog';
import { toast } from '../utils/uiStore';
import { deepClone, fmtNum } from '../utils/format';
import { fmtDate } from '../utils/dates';
import type { Lease, LeaseEvent } from '../types/lease';

export type PendingItem = { kind: 'lease'; lease: Lease; event?: undefined } | { kind: 'event'; lease: Lease; event: LeaseEvent };

export function pendingApprovals(): PendingItem[] {
    const out: PendingItem[] = [];
    for (const l of Store.leases) {
        if (l.status === 'pending') out.push({ kind: 'lease', lease: l });
        for (const e of l.events || []) if (e.status === 'pending') out.push({ kind: 'event', lease: l, event: e });
    }
    return out;
}

export const lastSubmitter = (l: Lease): string => { const h = (l.history || []).slice().reverse().find(x => /submitted/i.test(x.text)); return h ? h.actorName : 'a user'; };

export async function approveEvent(l: Lease, id: string): Promise<void> {
    const l2 = deepClone(l), e = l2.events.find(x => x.id === id);
    if (!e) return;
    const amt = eventAmount(l, e), chk = checkApproval('change', e, amt, e.submittedBy);
    if (!chk.ok) { toast(chk.reason || ''); return; }
    if (chk.done && !lockGuard(e.effective, 'Lease change')) return;
    e.approvals = (e.approvals || []).concat([myApproval()]);
    if (chk.done) { e.status = 'approved'; e.approvedBy = Store.actorId(); e.approvedByName = Store.actorName(); e.approvedOn = AS_OF; }
    logHistory(l2, `${chk.done ? 'Approved' : `Approval ${e.approvals.length} of ${chk.needed} given`}: ${EVENT_TYPES[e.type].label}, effective ${fmtDate(e.effective)} (${fmtNum(amt)} ${SETTINGS.functionalCurrency})`);
    if (!await Store.save(l2)) return; toast(chk.done ? 'Change approved' : `Approval recorded; ${chk.needed - e.approvals.length} more needed`);
}

export function rejectEvent(l: Lease, id: string): void {
    if (!guard('approve', 'reject changes')) return;
    confirmDialog('Reject change', 'Reject this change? The lease continues as it is.', 'Reject change', async () => {
        const l2 = deepClone(l), e = l2.events.find(x => x.id === id);
        if (!e) return;
        e.status = 'rejected'; e.rejectedBy = Store.actorId(); e.rejectedByName = Store.actorName();
        logHistory(l2, `Rejected: ${EVENT_TYPES[e.type].label}`); if (!await Store.save(l2)) return; toast('Change rejected');
    });
}

export async function approveLease(l: Lease): Promise<void> {
    const sub = ((l.history || []).slice().reverse().find(h => /submitted|imported/i.test(h.text)) || { actor: undefined }).actor;
    const amt = leaseAmount(l), l2 = deepClone(l), chk = checkApproval('lease', l2, amt, sub);
    if (!chk.ok) { toast(chk.reason || ''); return; }
    if (chk.done && !lockGuard(l.terms.commencement, 'New lease')) return;
    l2.approvals = (l2.approvals || []).concat([myApproval()]);
    if (chk.done) l2.status = 'active';
    logHistory(l2, chk.done ? `Approved and activated (${fmtNum(amt)} ${SETTINGS.functionalCurrency})` : `Approval ${l2.approvals.length} of ${chk.needed} given`);
    if (!await Store.save(l2)) return; toast(chk.done ? 'Lease approved' : `Approval recorded; ${chk.needed - l2.approvals.length} more needed`);
}

export function rejectLease(l: Lease): void {
    if (!guard('approve', 'reject leases')) return;
    confirmDialog('Reject lease', 'Reject this lease? It returns to the preparer as rejected.', 'Reject lease', async () => {
        const l2 = deepClone(l); l2.status = 'rejected'; logHistory(l2, 'Rejected'); if (!await Store.save(l2)) return; toast('Lease rejected');
    });
}

/** "n of m approvals (roles)" for a pending lease and for a pending change. */
export const leaseApprovalProgress = (l: Lease): string => approvalProgress(l, 'lease', leaseAmount(l));
export const eventApprovalProgress = (l: Lease, e: LeaseEvent): string => approvalProgress(e, 'change', eventAmount(l, e));
