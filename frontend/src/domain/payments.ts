/* Scheduled cash flows matched with recorded payments. */
import { num } from './engine';
import { getResult, isLive } from './lease';
import { Store } from './store';
import { AS_OF } from './state';
import { sum } from '../utils/format';

export type PayStatus = 'paid' | 'due' | 'partial' | 'overdue';
export interface PaymentRow {
    key: string;
    leaseId: string;
    name: string;
    dueDate: string;
    amount: number;
    paid: number;
    outstanding: number;
    status: PayStatus;
    daysLate: number;
    lateCharge: number;
    type: 'Receipt' | 'Payment';
    kind: string;
    currency: string;
}

export function paymentRows(): PaymentRow[] {
    const out: PaymentRow[] = [];
    for (const l of Store.leases) {
        if (!isLive(l)) continue;
        const res = getResult(l); if (!res) continue;
        const recs = (l.payments || []).filter(p => p.kind !== 'variable');
        const lr = l.role === 'lessor', T = l.terms;
        res.cashflows.forEach(f => {
            if (f.amount <= 0 || f.type === 'unguaranteed residual value') return;
            const key = `${l.id}|${f.date}|${f.type}`;
            const paid = sum(recs.filter(p => p.dueDate === f.date && (!p.forType || p.forType === f.type)), p => p.amount);
            const outstanding = Math.max(0, Math.round(f.amount) - paid);
            const grace = num(T.gracePeriodDays);
            const late = f.date < AS_OF ? Math.max(0, Math.round((new Date(AS_OF).getTime() - new Date(f.date).getTime()) / 864e5)) : 0;
            const status: PayStatus = outstanding <= 0.5 ? 'paid' : late > grace ? 'overdue' : paid > 0 ? 'partial' : 'due';
            let charge = 0;
            if (status === 'overdue' && T.lateType !== 'none') {
                if (T.lateType === 'interest' || T.lateType === 'both') charge += outstanding * num(T.lateRate) / 100 * (late - grace) / 30;
                if (T.lateType === 'fine' || T.lateType === 'both') charge += outstanding * num(T.fineRate) / 100;
            }
            out.push({ key, leaseId: l.id, name: l.name, dueDate: f.date, amount: f.amount, paid, outstanding, status, daysLate: status === 'overdue' ? late : 0, lateCharge: charge, type: lr ? 'Receipt' : 'Payment', kind: f.type || '', currency: l.currency });
        });
    }
    return out;
}

export const PAY_STATUS: Record<PayStatus, [label: string, badge: string]> = { paid: ['Paid', 'ok'], due: ['Due', 'info'], partial: ['Part paid', 'pending'], overdue: ['Overdue', 'bad'] };
