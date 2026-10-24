/* ======================================================================
   Analytics: forecasts, scenarios, sensitivity, run-off, exceptions
   Everything runs through the same engine; scenarios work on copies
   and never change saved leases.
   ====================================================================== */
import { addDays, addMonths, balanceAt, leaseTerm, monthlyRate, monthsBetween, num, periodTotals, pvAt, run } from './engine';
import { ASSET_CLASSES, SETTINGS, engineSettings } from './settings';
import { getResult, isLive, leaseEnd, statusOf } from './lease';
import { Store } from './store';
import { AS_OF } from './state';
import { Ent, baseRate, entityOf, fxConvert, presentationCcy } from './enterprise';
import { paymentRows } from './payments';
import { conv, leasesFor } from './reporting';
import { ERP } from './erp';
import { deepClone, fmtNum, fyBounds, money, pct } from '../utils/format';
import { fmtDate, monthLabel } from '../utils/dates';
import type { Lease, LeaseEvent } from '../types/lease';

export interface ForecastBucket { start: string; end: string; label: string; out: number; inn: number; byClass: Record<string, number> }
export function cashForecast(months: number, list?: Lease[]): ForecastBucket[] {
    const start = AS_OF.slice(0, 8) + '01', buckets: ForecastBucket[] = [];
    for (let i = 0; i < months; i++) { const s = addMonths(start, i); buckets.push({ start: s, end: addDays(addMonths(s, 1), -1), label: monthLabel(s), out: 0, inn: 0, byClass: {} }); }
    for (const l of list || Store.leases.filter(isLive)) {
        const r = getResult(l); if (!r) continue;
        for (const f of r.cashflows) {
            if (f.date < start || f.type === 'unguaranteed residual value') continue;
            const b = buckets.find(b => f.date >= b.start && f.date <= b.end); if (!b) continue;
            const v = fxConvert(f.amount, l.currency, AS_OF);
            if (l.role === 'lessor') b.inn += v; else { b.out += v; b.byClass[l.assetClass] = (b.byClass[l.assetClass] || 0) + v; }
        }
    }
    return buckets;
}

/* ---- Trends: earlier and later balances and cash, from the leases as recorded today ---- */
/** The last `n` month-ends before `date`, oldest first, then `date` itself. */
export function monthEnds(date: string, n: number): string[] {
    const first = date.slice(0, 8) + '01', out: string[] = [];
    for (let i = n; i >= 1; i--) out.push(addDays(addMonths(first, 1 - i), -1));
    out.push(date);
    return out;
}
export interface PositionPoint { date: string; L: number; A: number; NI: number }
/** Lease liabilities, right-of-use assets and lessor net investment at `date`, as the dashboard totals them. */
export function positionAt(date: string): PositionPoint {
    let L = 0, A = 0, NI = 0;
    for (const l of leasesFor({})) {
        const r = getResult(l); if (!r) continue;
        const b = balanceAt(r, date);
        if (r.mode === 'lessee') { L += conv(l, b.L); A += conv(l, b.A); } else if (r.mode === 'lessor-finance') NI += conv(l, b.L);
    }
    return { date, L, A, NI };
}
/** Undiscounted payments of recognised lessee leases falling due in each month after `date` (or before it, when `months` is negative). */
export function lesseePaymentsByMonth(date: string, months: number): { from: string; to: string; amount: number }[] {
    const step = months < 0 ? -1 : 1, out: { from: string; to: string; amount: number }[] = [];
    for (let i = 0; i < Math.abs(months); i++) {
        const a = addMonths(date, i * step), b = addMonths(date, (i + 1) * step);
        out.push(step > 0 ? { from: a, to: b, amount: 0 } : { from: b, to: a, amount: 0 });
    }
    if (step < 0) out.reverse();
    for (const l of leasesFor({ role: 'lessee' })) {
        const r = getResult(l); if (!r || r.mode !== 'lessee') continue;
        for (const f of r.cashflows) {
            if (f.type === 'unguaranteed residual value') continue;
            const m = out.find(x => f.date > x.from && f.date <= x.to); if (m) m.amount += conv(l, f.amount);
        }
    }
    return out;
}

export interface PortfolioFigures { L: number; A: number; cost: number; cash: number }
/** Portfolio impact of a modified copy of the leases. */
function portfolioFigures(list: Lease[], from: string, to: string): PortfolioFigures {
    let L = 0, A = 0, cost = 0, cash = 0;
    for (const l of list) {
        const r = run(l, engineSettings()), b = balanceAt(r, AS_OF), t = periodTotals(r, from, to);
        if (l.role !== 'lessee') continue;
        L += fxConvert(b.L, l.currency); A += fxConvert(b.A, l.currency);
        cost += fxConvert(t.dep + t.int + t.expense - t.gain + t.imp, l.currency); cash += fxConvert(t.payAdv + t.payArr + (r.mode === 'exempt' ? t.cash : 0), l.currency);
    }
    return { L, A, cost, cash };
}

export const SCENARIOS: Record<string, { label: string; desc: string; param: [label: string, def: number] }> = {
    extend: { label: 'All extension options exercised', desc: 'Every lessee extension option becomes reasonably certain from next month, remeasured at the rate below (IFRS 16.40(a)).', param: ['Revised discount rate %', 16] },
    rent: { label: 'Rent reset on all leases', desc: 'Every lessee payment changes by the percentage below from next month, as an index-type reset at the original rate (16.42(b)).', param: ['Change in rent %', 10] },
    terminate: { label: 'Exit leases ending within N months early', desc: 'Leases ending within the number of months below are terminated next month, paying the monthly-rent penalty multiple set in Settings (2 months).', param: ['Months', 18] },
    fx: { label: 'Currency shock', desc: 'Foreign currencies move against the presentation currency by the percentage below. Affects translated balances only.', param: ['Change %', 10] },
};
export function runScenario(kind: string, v: number) {
    const eff = addMonths(AS_OF.slice(0, 8) + '01', 1);
    const base = Store.leases.filter(l => isLive(l) && statusOf(l, AS_OF) === 'active').map(deepClone);
    const mod = base.map(deepClone);
    const scEvent = (e: Omit<LeaseEvent, 'id' | 'status'>): LeaseEvent => Object.assign({ id: 'sc', status: 'approved' as const }, e);
    for (const l of mod) {
        if (l.role !== 'lessee' || l.terms.exemption !== 'none') continue;
        const r = run(l, engineSettings()), effL = addMonths(AS_OF.slice(0, 8) + l.terms.commencement.slice(8), AS_OF.slice(8) > l.terms.commencement.slice(8) ? 1 : 0);
        if (effL <= l.terms.commencement || monthsBetween(l.terms.commencement, effL) >= r.termMonths) continue;
        if (kind === 'extend' && num(l.terms.extension.months) && !l.terms.extension.certain) l.events.push(scEvent({ type: 'reassess-term', effective: effL, newEndMonth: r.termMonths + num(l.terms.extension.months), extPayment: num(l.terms.extension.payment) || '', newRate: v }));
        if (kind === 'rent') { const next = r.cashflows.find(f => f.date >= effL && (f.type === 'rent' || f.type === 'extension')); if (next) l.events.push(scEvent({ type: 'reassess-index', effective: effL, newPayment: next.amount * (1 + v / 100) })); }
        if (kind === 'terminate' && leaseEnd(l) <= addMonths(AS_OF, v)) l.events.push(scEvent({ type: 'terminate', effective: effL, penalty: num(l.terms.payment) * (num(SETTINGS.exitPenaltyMonths) || 2) }));
    }
    const to = addDays(addMonths(eff, 12), -1);
    const before = portfolioFigures(base, eff, to);
    let after = portfolioFigures(mod, eff, to);
    if (kind === 'fx') {
        const P = presentationCcy(), foreign = base.filter(l => l.role === 'lessee' && l.currency !== P);
        const fxPart = portfolioFigures(foreign, eff, to);
        after = { L: before.L + fxPart.L * v / 100, A: before.A + fxPart.A * v / 100, cost: before.cost + fxPart.cost * v / 100, cash: before.cash + fxPart.cash * v / 100 };
    }
    return { before, after, period: `${fmtDate(eff)} to ${fmtDate(to)}`, affected: kind === 'fx' ? base.filter(l => l.currency !== presentationCcy()).length : mod.filter(l => l.events.some(e => e.id === 'sc')).length };
}

/** Liability sensitivity to the discount rate: PV of remaining payments at shifted rates. */
export function rateSensitivity(shifts: number[]): { bp: number; pv: number }[] {
    return shifts.map(bp => {
        let tot = 0;
        for (const l of Store.leases.filter(l => isLive(l) && l.role === 'lessee')) {
            const r = getResult(l); if (!r || r.mode !== 'lessee') continue;
            const flows = r.cashflows.filter(f => f.date > AS_OF).map(f => ({ t: monthsBetween(AS_OF, f.date), amount: f.amount }));
            const rate = (r.initial.annualRate || num(l.terms.discountRate)) + bp / 100;
            tot += fxConvert(pvAt(flows, monthlyRate(rate, num(l.terms.freqM) || 1, SETTINGS.rateConvention), 0), l.currency);
        }
        return { bp, pv: tot };
    });
}

export function runoffMatrix(): { years: { end: string; label: string }[]; rows: Record<string, number[]> } {
    const f0 = fyBounds(AS_OF), years: { end: string; label: string }[] = [];
    for (let i = 0; i < 8; i++) { const s = addMonths(f0.start, 12 * i); years.push({ end: addDays(addMonths(s, 12), -1), label: fyBounds(s).label }); }
    const rows: Record<string, number[]> = {};
    for (const l of Store.leases.filter(l => isLive(l) && l.role === 'lessee')) {
        const r = getResult(l); if (!r || r.mode !== 'lessee') continue;
        const k = l.assetClass; rows[k] = rows[k] || years.map(() => 0);
        years.forEach((y, i) => { rows[k][i] += fxConvert(balanceAt(r, y.end).L, l.currency); });
    }
    return { years, rows };
}

/* ---- Exceptions: rule-based checks, each with the evidence ---- */
export type Severity = 'high' | 'medium' | 'low';
export interface ExceptionItem { sev: Severity; cat: string; leaseId: string; text: string; fix: string }
export function findExceptions(): ExceptionItem[] {
    const out: ExceptionItem[] = [], live = Store.leases.filter(isLive);
    const add = (sev: Severity, cat: string, l: Lease | undefined, text: string, fix: string) => out.push({ sev, cat, leaseId: l ? l.id : '', text, fix });
    const byCcy: Record<string, number[]> = {};
    live.filter(l => l.role === 'lessee' && num(l.terms.discountRate)).forEach(l => (byCcy[l.currency] = byCcy[l.currency] || []).push(num(l.terms.discountRate)));
    const median = (a: number[]) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
    const perArea: Record<string, { l: Lease; v: number }[]> = {};
    for (const l of live) {
        const T = l.terms, r = getResult(l);
        if (!r) { add('high', 'Data', l, 'The lease cannot be measured: commencement, term or payment is missing.', 'Complete the lease'); continue; }
        const med = median(byCcy[l.currency] || []);
        if (l.role === 'lessee' && T.exemption === 'none' && med && Math.abs(num(T.discountRate) - med) > 3 && (byCcy[l.currency] || []).length >= 3) add('medium', 'Discount rate', l, `Rate ${pct(T.discountRate)} is more than 3 points from the ${l.currency} portfolio median of ${pct(med)}.`, 'Check the IBR evidence for this term and security');
        if (T.exemption === 'low-value' && ['vehicle', 'building', 'warehouse', 'land', 'retail'].includes(l.assetClass)) add('high', 'Exemption', l, `Low-value exemption used for ${ASSET_CLASSES[l.assetClass]}. These assets do not qualify (16.B6).`, 'Recognise the lease');
        if (T.exemption === 'short-term' && leaseTerm(T) > 12) add('high', 'Exemption', l, `Short-term exemption with a ${leaseTerm(T)}-month term.`, 'Recognise the lease');
        if (num(T.usefulLifeM) && !T.ownershipTransfer && !T.purchase.certain && num(T.usefulLifeM) < leaseTerm(T)) add('low', 'Judgement', l, 'Useful life is shorter than the lease term; confirm the asset will not be replaced by the lessor.', 'Review useful life');
        if (!(l.documents || []).length) add('low', 'Evidence', l, 'No contract document attached.', 'Attach the signed agreement');
        if (r.mode === 'lessee' && balanceAt(r, AS_OF).A < -0.5) add('high', 'Calculation', l, 'Negative right-of-use asset.', 'Review events');
        if (num(l.area) && l.role === 'lessee' && ['building', 'warehouse', 'retail'].includes(l.assetClass)) { const k = l.assetClass + '|' + l.areaUnit + '|' + l.currency; (perArea[k] = perArea[k] || []).push({ l, v: num(T.payment) / (num(T.freqM) || 1) / num(l.area) }); }
        (l.events || []).filter(e => e.status === 'pending' && e.submittedOn && (new Date(AS_OF).getTime() - new Date(e.submittedOn).getTime()) / 864e5 > 14).forEach(e => add('medium', 'Workflow', l, `Change submitted ${fmtDate(e.submittedOn)} still awaiting approval.`, 'Approve or reject'));
        if (statusOf(l, AS_OF) === 'active' && num(T.extension.months) && !T.extension.certain && (new Date(leaseEnd(l)).getTime() - new Date(AS_OF).getTime()) / 864e5 < 120) add('medium', 'Judgement', l, `Lease ends ${fmtDate(leaseEnd(l))} with an extension option not yet reassessed.`, 'Reassess the lease term');
        if (l.currency !== (entityOf(l.entity).functionalCurrency || SETTINGS.functionalCurrency) && !baseRate(l.currency, AS_OF)) add('high', 'Currency', l, `No exchange rate for ${l.currency}.`, 'Add the rate in Administration');
    }
    Object.values(perArea).forEach(list => { if (list.length < 3) return; const m = median(list.map(x => x.v)); list.forEach(x => { if (x.v > m * 2 || x.v < m / 2) add('low', 'Rent level', x.l, `Monthly rent per ${x.l.areaUnit} is ${fmtNum(x.v, 1)} against a median of ${fmtNum(m, 1)} for similar premises.`, 'Check the rent or area'); }); });
    const seen: Record<string, string> = {};
    live.forEach(l => { const k = `${String(l.counterparty).toLowerCase()}|${l.terms.commencement}|${l.terms.payment}`; if (seen[k]) add('high', 'Duplicate', l, `Same counterparty, commencement and payment as ${seen[k]}.`, 'Delete the duplicate'); else seen[k] = l.id; });
    paymentRows().filter(p => p.status === 'overdue').forEach(p => add(p.daysLate > 30 ? 'high' : 'medium', 'Payments', Store.get(p.leaseId), `${p.type} of ${money(p.outstanding, p.currency)} due ${fmtDate(p.dueDate)} is ${p.daysLate} days overdue.`, 'Pay, or record if already paid'));
    Ent.bank.items.forEach(s => { const n = s.lines.filter(x => x.status === 'unmatched' && !x.duplicate).length; if (n) out.push({ sev: 'medium', cat: 'Reconciliation', leaseId: '', text: `${n} unmatched lines in statement ${s.name}.`, fix: 'Reconcile' }); });
    Ent.exports.items.filter(x => x.status === 'generated' && (Date.now() - new Date(x.createdAt).getTime()) / 864e5 > 7).forEach(x => out.push({ sev: 'medium', cat: 'ERP sync', leaseId: '', text: `${(ERP[x.target] || { label: x.target }).label || x.target} file for ${fmtDate(x.from)} to ${fmtDate(x.to)} not confirmed as posted after 7 days.`, fix: 'Confirm in ERP export' }));
    const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
    return out.sort((a, b) => order[a.sev] - order[b.sev]);
}
