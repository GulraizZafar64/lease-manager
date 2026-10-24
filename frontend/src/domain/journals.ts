/* ======================================================================
   Journal entries
   Initial recognition and events as individual entries; recurring
   interest, payments and depreciation as one entry per lease per month.
   ====================================================================== */
import { addDays, balanceAt, num, periodTotals } from './engine';
import { SETTINGS, type AccountKey } from './settings';
import { getResult, isLive } from './lease';
import { Store } from './store';
import { averageRate, baseRate, crossRate, entityOf } from './enterprise';
import { monthLabel } from '../utils/dates';
import { pct } from '../utils/format';
import type { Lease } from '../types/lease';

export interface JournalLine { account: string; dr: number; cr: number }
export interface Journal {
    leaseId: string;
    date: string;
    kind: string;
    memo: string;
    currency: string;
    lines: JournalLine[];
    /** Set by the ERP export for duplicate detection. */
    key?: string;
}
type RawLine = [account: AccountKey, dr: number, cr: number];

const ACC = (k: AccountKey): string => SETTINGS.accounts[k] || k;
function je(lease: Lease, date: string, kind: string, memo: string, lines: RawLine[]): Journal {
    lines = lines.filter(l => Math.abs(l[1] || 0) > 0.004 || Math.abs(l[2] || 0) > 0.004);
    return { leaseId: lease.id, date, kind, memo, currency: lease.currency, lines: lines.map(([account, dr, cr]) => ({ account: ACC(account), dr: dr || 0, cr: cr || 0 })) };
}
const dc = (acc: AccountKey, v: number): RawLine => v >= 0 ? [acc, v, 0] : [acc, 0, -v];

export function journalsFor(lease: Lease, from: string, to: string): Journal[] {
    const res = getResult(lease);
    if (!res || !isLive(lease)) return [];
    const T = lease.terms, out: Journal[] = [], inR = (d: string) => d >= from && d <= to;
    if (res.mode === 'lessee') {
        const I = res.initial;
        if (inR(T.commencement)) {
            out.push(je(lease, T.commencement, 'Initial recognition', 'Recognise right-of-use asset and lease liability (IFRS 16.22-28)', [
                ['rou', I.rou, 0], ['incentive', I.incentives, 0], ['deposit', I.depositFV, 0],
                ['liability', 0, I.liability], ['cash', 0, I.paidAtCommencement + I.idc + I.deposit], ['provision', 0, I.restoration],
            ]));
        }
        for (const r of res.rows) {
            for (const e of r.events) {
                if (!inR(e.date)) continue;
                const lines: RawLine[] = [];
                let memo = e.label;
                if (e.type === 'impair') { const a = r.imp; lines.push(['impairment', a, 0], ['rou', 0, a]); memo = 'Impairment of right-of-use asset (IAS 36)'; }
                else if (e.type === 'terminate') {
                    lines.push(['liability', e.before.L, 0], ['rouAccDep', 0, 0], ['rou', 0, e.before.A], ['cash', 0, e.penalty || 0]);
                    const g = e.before.L - e.before.A - (e.penalty || 0); lines.push(dc('gain', -g));
                    memo = 'Derecognise lease on termination; difference to profit or loss';
                } else {
                    if (e.partial) { lines.push(['liability', e.partial.dL, 0], ['rou', 0, e.partial.dA], dc('gain', -e.partial.gain)); }
                    const adj = e.adjustment || 0;
                    const roAdj = adj; // reduction below zero goes to P/L (16.39)
                    if (adj >= 0) lines.push(['rou', roAdj, 0], ['liability', 0, adj]);
                    else {
                        const aAvail = (e.partial ? e.before.A - e.partial.dA : e.before.A);
                        const toRou = Math.min(-adj, aAvail), toPL = -adj - toRou;
                        lines.push(['liability', -adj, 0], ['rou', 0, toRou], ['gain', 0, toPL]);
                    }
                    memo = `${e.label}${e.newRate != null ? ` at ${pct(e.newRate)}` : ''}`;
                }
                const j = je(lease, e.date, 'Remeasurement / modification', memo, lines);
                j.memo = memo; out.push(j);
            }
            if (!inR(r.end)) continue;
            const pay = r.payAdv + r.payArr;
            const lines: RawLine[] = [['interest', r.int, 0], ['liability', 0, r.int], ['liability', pay, 0], ['cash', 0, pay], ['depreciation', r.dep, 0], ['rouAccDep', 0, r.dep]];
            if (r.provInt) lines.push(['provInterest', r.provInt, 0], ['provision', 0, r.provInt]);
            if (r.depInt) lines.push(['deposit', r.depInt, 0], ['depositIncome', 0, r.depInt]);
            if (pay || r.int || r.dep) out.push(je(lease, r.end, 'Monthly', `Interest, payments and depreciation, ${monthLabel(r.start)}`, lines));
        }
        const last = res.rows[res.rows.length - 1];
        if (I.deposit && last && inR(last.end) && res.endReason !== 'terminated') out.push(je(lease, last.end, 'Deposit refund', 'Security deposit refunded at end of lease', [['cash', I.deposit, 0], ['deposit', 0, I.deposit]]));
    } else if (res.mode === 'exempt') {
        const exp: AccountKey = res.exemption === 'short-term' ? 'stExpense' : 'lvExpense';
        for (const r of res.rows) {
            if (!inR(r.end)) continue;
            out.push(je(lease, r.end, 'Monthly', `${res.exemption === 'short-term' ? 'Short-term' : 'Low-value'} lease expense, straight-line (IFRS 16.6), ${monthLabel(r.start)}`, [[exp, r.expense, 0], ['cash', 0, r.cash], dc('prepaid', r.cash - r.expense)]));
        }
    } else if (res.mode === 'lessor-finance') {
        const I = res.initial;
        if (inR(T.commencement)) {
            if (T.dealer) out.push(je(lease, T.commencement, 'Initial recognition', 'Manufacturer/dealer lessor: revenue, cost of sales and net investment (IFRS 16.71-74)', [
                ['netInvestment', I.netInvestment, 0], ['cogs', I.cogs, 0], ['revenue', 0, I.revenue], ['inventory', 0, num(T.carryingAmount)], ['sellingExp', I.dealerIDC, 0], ['cash', 0, I.dealerIDC],
                dc('gain', -(I.netInvestment + I.cogs - I.revenue - num(T.carryingAmount))),
            ]));
            else out.push(je(lease, T.commencement, 'Initial recognition', 'Derecognise underlying asset, recognise net investment (IFRS 16.67-69)', [
                ['netInvestment', I.netInvestment, 0], ['ppe', 0, num(T.carryingAmount)], ['cash', 0, num(T.lessorIDC)], dc('gain', -(I.netInvestment - num(T.carryingAmount) - num(T.lessorIDC))),
            ]));
        }
        for (const r of res.rows) {
            for (const e of r.events) if (inR(e.date)) {
                if (e.type === 'terminate') out.push(je(lease, e.date, 'Termination', 'Derecognise net investment; asset returned', [['ppe', e.assetValue || 0, 0], ['cash', r.cash, 0], ['netInvestment', 0, e.before.L], dc('gain', -((e.assetValue || 0) + r.cash - e.before.L))]));
                else out.push(je(lease, e.date, 'Modification', 'Modification of finance lease measured under IFRS 9 (IFRS 16.80(b))', [dc('netInvestment', e.adjustment as number), dc('gain', -(e.adjustment as number))]));
            }
            if (!inR(r.end)) continue;
            const rc = r.rcpAdv + r.rcpArr;
            const lines: RawLine[] = [['netInvestment', r.int, 0], ['financeIncome', 0, r.int], ['cash', rc, 0], ['netInvestment', 0, rc]];
            if (r.assetReturned) lines.push(['ppe', r.assetReturned, 0], ['netInvestment', 0, r.assetReturned]);
            out.push(je(lease, r.end, 'Monthly', `Finance income and receipts, ${monthLabel(r.start)}`, lines));
        }
    } else if (res.mode === 'lessor-operating') {
        if (inR(T.commencement) && num(T.lessorIDC)) out.push(je(lease, T.commencement, 'Initial direct costs', 'Lessor initial direct costs added to the underlying asset (IFRS 16.83)', [['idcDeferred', num(T.lessorIDC), 0], ['cash', 0, num(T.lessorIDC)]]));
        for (const r of res.rows) {
            if (!inR(r.end)) continue;
            const lines: RawLine[] = [['cash', r.cash, 0], dc('accruedIncome', r.income - r.cash), ['leaseIncome', 0, r.income]];
            if (r.assetDep) lines.push(['ppeDep', r.assetDep, 0], ['ppeAccDep', 0, r.assetDep]);
            if (r.idcAmort) lines.push(['idcAmort', r.idcAmort, 0], ['idcDeferred', 0, r.idcAmort]);
            if (r.gain) lines.push(dc('gain', -r.gain));
            out.push(je(lease, r.end, 'Monthly', `Straight-line lease income (IFRS 16.81), ${monthLabel(r.start)}`, lines));
        }
    }
    // Variable payments recorded against the lease (expensed, IFRS 16.38(b))
    for (const p of lease.payments || []) if (p.kind === 'variable' && inR(p.paidDate || p.dueDate)) {
        out.push(je(lease, p.paidDate || p.dueDate, 'Variable payment', 'Variable lease payment not included in the lease liability', lease.role === 'lessor' ? [['cash', p.amount, 0], ['leaseIncome', 0, p.amount]] : [['varExpense', p.amount, 0], ['cash', 0, p.amount]]));
    }
    return out;
}

export function journalRows(list: Journal[]): (string | number)[][] {
    return ([['Date', 'Lease', 'Type', 'Description', 'Account', 'Debit', 'Credit', 'Currency']] as (string | number)[][])
        .concat(list.flatMap(j => j.lines.map(x => [j.date, j.leaseId, j.kind, j.memo, x.account, Math.round(x.dr * 100) / 100, Math.round(x.cr * 100) / 100, j.currency])));
}

/* IAS 21: lease liabilities and net investments are monetary items, retranslated at the closing rate.
   Right-of-use assets are non-monetary and stay at the historical rate. */
export type FxRevaluationRow =
    | { lease: Lease; F: string; missing: true }
    | { lease: Lease; F: string; missing?: false; role: string; opening: number; openingF: number; flows: number; flowsF: number; closing: number; closingF: number; rateOpen: number; rateAvg: number; rateClose: number; diff: number };
export function fxRevaluation(from: string, to: string): FxRevaluationRow[] {
    const out: FxRevaluationRow[] = [];
    for (const l of Store.leases.filter(isLive)) {
        const F = entityOf(l.entity).functionalCurrency || SETTINGS.functionalCurrency;
        if (l.currency === F) continue;
        const res = getResult(l); if (!res || (res.mode !== 'lessee' && res.mode !== 'lessor-finance')) continue;
        const dayBefore = addDays(from, -1);
        const o = balanceAt(res, dayBefore).L, c = balanceAt(res, to).L, t = periodTotals(res, from, to);
        const flows = t.addL + t.remL + t.int - t.payAdv - t.payArr - t.rcpAdv - t.rcpArr - t.derL;
        const rO = crossRate(l.currency, F, dayBefore), rA = averageRate(l.currency, from, to) / (baseRate(F, to) || 1), rC = crossRate(l.currency, F, to);
        if (!rO || !rC) { out.push({ lease: l, F, missing: true }); continue; }
        const diff = c * rC - (o * rO + flows * rA);
        out.push({ lease: l, F, role: l.role, opening: o, openingF: o * rO, flows, flowsF: flows * rA, closing: c, closingF: c * rC, rateOpen: rO, rateAvg: rA, rateClose: rC, diff });
    }
    return out;
}
export function fxJournals(from: string, to: string): Journal[] {
    const out: Journal[] = [];
    for (const r of fxRevaluation(from, to)) {
        if (r.missing || Math.abs(r.diff) <= 0.5) continue;
        // liability increase (diff > 0) is a loss for a lessee; a receivable increase is a gain for a lessor
        const lessee = r.role === 'lessee', loss = lessee ? r.diff : -r.diff;
        const lines = lessee ? [dc('fxLoss', loss), dc('liability', -r.diff)] : [dc('netInvestment', r.diff), dc('fxLoss', loss)];
        const j = je(r.lease, to, 'FX revaluation', `Retranslate ${r.lease.currency} ${lessee ? 'lease liability' : 'net investment'} at closing rate (IAS 21.23, 28)`, lines);
        j.currency = r.F; out.push(j);
    }
    return out;
}
