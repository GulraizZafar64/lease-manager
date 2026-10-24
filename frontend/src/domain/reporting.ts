/* ======================================================================
   Portfolio reporting: roll-forwards, maturity analysis, disclosures.
   ====================================================================== */
import { addDays, addMonths, balanceAt, initialFlows, maturity, num, periodTotals } from './engine';
import { ASSET_CLASSES, FREQ, SETTINGS } from './settings';
import { getResult, isLive, leaseEnd, measurementType, statusOf } from './lease';
import { Store } from './store';
import { SCOPE } from './state';
import { fxRevaluation } from './journals';
import { toFunctional } from './enterprise';
import { cap, sum } from '../utils/format';
import { fmtDate } from '../utils/dates';
import type { Sheet } from '../utils/files';
import type { Band } from '../types/engine';
import type { DisplayStatus, Lease, LeaseRole } from '../types/lease';

export function leasesFor(filter: { role?: LeaseRole; currency?: string; entity?: string } = {}): Lease[] {
    return Store.leases.filter(l => isLive(l) && (!filter.role || l.role === filter.role) && (!filter.currency || l.currency === filter.currency) && (!filter.entity || l.entity === filter.entity));
}
export const conv = (l: Lease, v: number): number => toFunctional(v, l.currency);

export interface ClassMovement { opening: number; additions: number; remeasure: number; depreciation: number; impairment: number; derecognised: number; closing: number }
export interface LesseeMovement {
    cls: Record<string, ClassMovement>;
    liab: { opening: number; additions: number; remeasure: number; interest: number; payments: number; derecognised: number; closing: number };
    pl: { depByClass: Record<string, number>; interest: number; st: number; lv: number; variable: number; gain: number; impairment: number; provInterest: number; depositIncome: number };
    cashOut: number;
    additionsROU: number;
}
/** ROU and liability roll-forward by asset class for [from, to]. */
export function lesseeMovement(from: string, to: string): LesseeMovement {
    const dayBefore = addDays(from, -1);
    const cls: Record<string, ClassMovement> = {}, liab = { opening: 0, additions: 0, remeasure: 0, interest: 0, payments: 0, derecognised: 0, closing: 0 };
    const pl = { depByClass: {} as Record<string, number>, interest: 0, st: 0, lv: 0, variable: 0, gain: 0, impairment: 0, provInterest: 0, depositIncome: 0 };
    let cashOut = 0, additionsROU = 0;
    for (const l of leasesFor({ role: 'lessee' })) {
        const res = getResult(l); if (!res) continue;
        if (res.mode === 'exempt') {
            const t = periodTotals(res, from, to);
            if (res.exemption === 'short-term') pl.st += conv(l, t.expense); else pl.lv += conv(l, t.expense);
            cashOut += conv(l, t.cash); continue;
        }
        const k = l.assetClass || 'other';
        const c = cls[k] = cls[k] || { opening: 0, additions: 0, remeasure: 0, depreciation: 0, impairment: 0, derecognised: 0, closing: 0 };
        const t = periodTotals(res, from, to);
        const o = balanceAt(res, dayBefore), e = balanceAt(res, to);
        c.opening += conv(l, o.A); c.additions += conv(l, t.addA); c.remeasure += conv(l, t.remA); c.depreciation += conv(l, t.dep); c.impairment += conv(l, t.imp); c.derecognised += conv(l, t.derA); c.closing += conv(l, e.A);
        liab.opening += conv(l, o.L); liab.additions += conv(l, t.addL); liab.remeasure += conv(l, t.remL); liab.interest += conv(l, t.int); liab.payments += conv(l, t.payAdv + t.payArr); liab.derecognised += conv(l, t.derL); liab.closing += conv(l, e.L);
        pl.depByClass[k] = (pl.depByClass[k] || 0) + conv(l, t.dep); pl.interest += conv(l, t.int); pl.gain += conv(l, t.gain); pl.impairment += conv(l, t.imp); pl.provInterest += conv(l, t.provInt); pl.depositIncome += conv(l, t.depInt);
        cashOut += conv(l, t.cash); additionsROU += conv(l, t.addA);
    }
    for (const l of leasesFor({ role: 'lessee' })) for (const p of l.payments || []) if (p.kind === 'variable' && (p.paidDate || p.dueDate) >= from && (p.paidDate || p.dueDate) <= to) { pl.variable += conv(l, p.amount); cashOut += conv(l, p.amount); }
    return { cls, liab, pl, cashOut, additionsROU };
}

/** Current / non-current split: the principal that will be settled within 12 months. */
export function currentSplit(date: string): { current: number; nonCurrent: number; total: number } {
    let current = 0, total = 0;
    const in12 = addMonths(date, 12);
    for (const l of leasesFor({ role: 'lessee' })) {
        const res = getResult(l); if (!res || res.mode !== 'lessee') continue;
        const b = balanceAt(res, date).L;
        const t = periodTotals(res, addDays(date, 1), in12);
        total += conv(l, b);
        current += conv(l, Math.min(b, Math.max(0, t.payAdv + t.payArr - t.int)));
    }
    return { current, nonCurrent: total - current, total };
}

export const BANDS_STANDARD: Band[] = [{ label: 'Not later than one year', maxDays: 366 }, { label: 'Later than one year and not later than five years', maxDays: 1827 }, { label: 'Later than five years', maxDays: 1e9 }];
export const BANDS_DETAILED: Band[] = [{ label: 'Not later than one month', maxDays: 31 }, { label: 'One to three months', maxDays: 92 }, { label: 'Three months to one year', maxDays: 366 }, { label: 'One to five years', maxDays: 1827 }, { label: 'Later than five years', maxDays: 1e9 }];
export const BANDS_LESSOR: Band[] = [1, 2, 3, 4, 5].map(y => ({ label: `Year ${y}`, maxDays: Math.round(365.25 * y) + 1 })).concat([{ label: 'Later than five years', maxDays: 1e9 }]);

export function maturityTable(role: LeaseRole, date: string, bands: Band[], mode?: string) {
    const out = bands.map(b => ({ label: b.label, amount: 0 }));
    let carrying = 0;
    for (const l of leasesFor({ role })) {
        const res = getResult(l); if (!res) continue;
        if (mode && res.mode !== mode) continue;
        if (role === 'lessee' && res.mode !== 'lessee') continue;
        maturity(res, date, bands).forEach((b, i) => { out[i].amount += conv(l, b.amount); });
        carrying += conv(l, balanceAt(res, date).L);
    }
    const total = sum(out, x => x.amount);
    return { rows: out, total, carrying, finance: total - carrying };
}

export function lessorSummary(from: string, to: string) {
    const fin = { sellingProfit: 0, financeIncome: 0, variable: 0, closingNI: 0, urv: 0 }, op = { income: 0, variable: 0, depreciation: 0 };
    for (const l of leasesFor({ role: 'lessor' })) {
        const res = getResult(l); if (!res) continue;
        const t = periodTotals(res, from, to);
        const varInc = sum((l.payments || []).filter(p => p.kind === 'variable' && (p.paidDate || p.dueDate) >= from && (p.paidDate || p.dueDate) <= to), p => p.amount);
        if (res.mode === 'lessor-finance') {
            fin.financeIncome += conv(l, t.int); fin.variable += conv(l, varInc);
            if (l.terms.commencement >= from && l.terms.commencement <= to) fin.sellingProfit += conv(l, res.initial.sellingProfit || res.initial.gainOnDerecognition || 0);
            fin.closingNI += conv(l, balanceAt(res, to).L);
            fin.urv += conv(l, res.initial.urv || 0);
        } else { op.income += conv(l, t.income); op.variable += conv(l, varInc); op.depreciation += conv(l, t.assetDep); }
    }
    return { fin, op };
}

export interface RegisterRow {
    id: string; name: string; role: string; counterparty: string; assetClass: string; location: string;
    currency: string; commencement: string; end: string; termMonths: number;
    payment: number; frequency: string; rate: number; measurement: string;
    liability: number | null; rou: number | null; status: DisplayStatus; area: number | '';
}
export function registerRows(asOf: string): RegisterRow[] {
    return Store.leases.map(l => {
        const res = getResult(l), b = res ? balanceAt(res, asOf) : { L: 0, A: 0 };
        return {
            id: l.id, name: l.name, role: cap(l.role), counterparty: l.counterparty, assetClass: ASSET_CLASSES[l.assetClass] || l.assetClass, location: l.location,
            currency: l.currency, commencement: l.terms.commencement, end: leaseEnd(l), termMonths: res ? res.termMonths : num(l.terms.termMonths),
            payment: num(l.terms.payment), frequency: FREQ[l.terms.freqM] || '', rate: num(l.terms.discountRate), measurement: measurementType(l),
            liability: res && (res.mode === 'lessee' || res.mode === 'lessor-finance') ? b.L : null, rou: res && res.mode === 'lessee' ? b.A : null,
            status: statusOf(l, asOf), area: l.area,
        };
    });
}

/* ---- Reports and disclosures ---- */
export const REPORTS: [key: string, title: string, desc: string][] = [
    ['note', 'IFRS 16 disclosure note', 'Lessee and lessor disclosures in one note, with policies.'],
    ['rou', 'Right-of-use assets', 'Movement by class of asset (16.53(h), (j)).'],
    ['liability', 'Lease liabilities', 'Movement, current and non-current split (16.47, IAS 1).'],
    ['maturity', 'Maturity analysis', 'Undiscounted cash flows and reconciliation (16.58, 16.94, 16.97).'],
    ['pl', 'Profit or loss and cash flows', 'Amounts recognised (16.53, 16.50).'],
    ['lessor', 'Lessor disclosures', 'Finance and operating leases (16.89-97).'],
    ['fx', 'Foreign currency leases (IAS 21)', 'Retranslation of liabilities and net investments at closing rates.'],
    ['commitments', 'Commitments and leases not yet commenced', '16.55, 16.59(b)(iv).'],
    ['checklist', 'Disclosure checklist', 'What the system covers and what needs your judgement.'],
    ['drafts', 'Narrative drafts (AI)', 'Disclosure narrative drafted from your figures, with approval.'],
];

export type RowStyle = 'sub' | 'total' | 'ind' | '';
/** One statement line: label then values, with a presentation style. */
export interface StmtRow { cells: (string | number)[]; style: RowStyle }
export type ReportPart =
    | { kind: 'statement'; name: string; head: string[]; rows: StmtRow[]; intro?: string }
    | { kind: 'policy'; text: string }
    | { kind: 'note'; text: string }
    | { kind: 'fx'; head: string[]; body: (string | number)[][] }
    | { kind: 'empty'; text: string };
export interface Report { title: string; parts: ReportPart[]; sheets: Sheet[] }

const R = (cells: (string | number)[], style: RowStyle): StmtRow => ({ cells, style });

export const DISCLOSURE_CHECKLIST: { ref: string; text: string; auto: boolean }[] = [
    { ref: '16.47', text: 'Right-of-use assets and lease liabilities presented or disclosed separately', auto: true },
    { ref: '16.49', text: 'Interest on lease liabilities presented separately from depreciation', auto: true },
    { ref: '16.50', text: 'Cash flow classification of principal, interest, short-term and variable payments', auto: true },
    { ref: '16.53(a)', text: 'Depreciation charge by class of underlying asset', auto: true },
    { ref: '16.53(b)', text: 'Interest expense on lease liabilities', auto: true },
    { ref: '16.53(c)-(d)', text: 'Expense for short-term and low-value leases', auto: true },
    { ref: '16.53(e)', text: 'Expense for variable lease payments not in the liability', auto: true },
    { ref: '16.53(f)', text: 'Income from subleasing right-of-use assets', auto: true },
    { ref: '16.53(g)', text: 'Total cash outflow for leases', auto: true },
    { ref: '16.53(h)', text: 'Additions to right-of-use assets', auto: true },
    { ref: '16.53(i)', text: 'Gains or losses from sale and leaseback transactions', auto: false },
    { ref: '16.53(j)', text: 'Carrying amount of right-of-use assets by class at period end', auto: true },
    { ref: '16.55', text: 'Short-term lease commitments where the portfolio differs', auto: true },
    { ref: '16.56-57', text: 'Right-of-use assets meeting the investment property definition or revalued', auto: false },
    { ref: '16.58', text: 'Maturity analysis of lease liabilities (IFRS 7.39, B11)', auto: true },
    { ref: '16.59(a)', text: 'Nature of leasing activities', auto: false },
    { ref: '16.59(b)(i)-(iii)', text: 'Exposure to variable payments, extension and termination options, residual value guarantees', auto: false },
    { ref: '16.59(b)(iv)', text: 'Leases not yet commenced to which the lessee is committed', auto: true },
    { ref: '16.59(c)-(d)', text: 'Restrictions or covenants; sale and leaseback transactions', auto: false },
    { ref: '16.60', text: 'Fact that short-term or low-value exemptions are applied', auto: true },
    { ref: '16.90', text: 'Lessor: selling profit, finance income, variable income, operating lease income', auto: true },
    { ref: '16.91-92', text: 'Lessor: nature of leasing activities and risk management of residual assets', auto: false },
    { ref: '16.93', text: 'Lessor: explanation of significant changes in net investment', auto: false },
    { ref: '16.94', text: 'Lessor: finance lease maturity analysis and reconciliation to net investment', auto: true },
    { ref: '16.95-97', text: 'Lessor: operating lease assets in PPE and maturity analysis', auto: true },
    { ref: 'IAS 1.61', text: 'Current and non-current split of lease liabilities', auto: true },
    { ref: 'IAS 12', text: 'Deferred tax on right-of-use assets and lease liabilities (2021 amendment)', auto: false },
];

export function initialCash(from: string, to: string): number {
    let c = 0;
    for (const l of leasesFor({ role: 'lessee' })) { const r = getResult(l); if (r && r.mode === 'lessee' && l.terms.commencement >= from && l.terms.commencement <= to) c += conv(l, r.initial.paidAtCommencement + r.initial.idc - r.initial.incentives + r.initial.deposit); }
    return c;
}
export function policyText(): string {
    return `${SETTINGS.entity} assesses at inception whether a contract is, or contains, a lease. As a lessee it recognises a right-of-use asset and a lease liability at the commencement date. The liability is measured at the present value of lease payments not yet paid, discounted at the rate implicit in the lease or, where that cannot be readily determined, the incremental borrowing rate. The right-of-use asset is measured at cost, comprising the initial liability, payments made at or before commencement less incentives received, initial direct costs and estimated restoration costs, and is depreciated on a straight-line basis over the shorter of the lease term and the useful life, or over the useful life where ownership transfers or a purchase option is reasonably certain to be exercised. The liability is remeasured when there is a change in future payments arising from an index or rate, in the amount expected under a residual value guarantee, or in the assessment of an extension, termination or purchase option, with a corresponding adjustment to the right-of-use asset. The ${SETTINGS.functionalCurrency === 'PKR' ? 'Company' : 'entity'} applies the short-term and low-value exemptions, recognising those payments as an expense on a straight-line basis. Interest paid is classified in ${SETTINGS.interestCashFlow} activities. As a lessor, leases that transfer substantially all the risks and rewards incidental to ownership are classified as finance leases and presented as a net investment in the lease; other leases are operating leases and income is recognised on a straight-line basis.`;
}

function fxReport(from: string, to: string): Report {
    const rows = fxRevaluation(from, to);
    const head = ['Lease', 'Lease ccy', 'Entity ccy', 'Opening (lease ccy)', 'Movements', 'Closing (lease ccy)', 'Rate open', 'Rate avg', 'Rate close', 'Closing (entity ccy)', 'Exchange difference'];
    const body: (string | number)[][] = rows.map(r => r.missing ? [r.lease.id, r.lease.currency, r.F, 'Rate missing', '', '', '', '', '', '', ''] : [r.lease.id, r.lease.currency, r.F, r.opening, r.flows, r.closing, r.rateOpen, r.rateAvg, r.rateClose, r.closingF, r.diff]);
    const parts: ReportPart[] = rows.length ? [{ kind: 'fx', head, body }] : [{ kind: 'empty', text: 'No leases are in a currency other than their entity’s functional currency.' }];
    return { title: 'Foreign currency leases (IAS 21)', parts, sheets: [{ name: 'IAS 21 revaluation', rows: [head as (string | number)[]].concat(body) }] };
}

export function buildReport(kind: string, from: string, to: string): Report {
    if (kind === 'fx') return fxReport(from, to);
    const sheets: Sheet[] = [], parts: ReportPart[] = [];
    const add = (name: string, head: string[], rows: StmtRow[], intro?: string) => {
        parts.push({ kind: 'statement', name, head, rows, intro });
        sheets.push({ name, rows: [head as (string | number)[]].concat(rows.map(r => r.cells.slice())) });
    };
    const mv = lesseeMovement(from, to);
    const classes = Object.keys(mv.cls);
    const rou = () => {
        const head = ['Right-of-use assets'].concat(classes.map(k => ASSET_CLASSES[k] || k), ['Total']);
        const line = (label: string, f: (c: ClassMovement) => number, s: RowStyle) => R([label as string | number].concat(classes.map(k => f(mv.cls[k])), [sum(classes, k => f(mv.cls[k]))]), s);
        add('Right-of-use assets', head, [line(`Balance at ${fmtDate(addDays(from, -1))}`, c => c.opening, 'sub'), line('Additions', c => c.additions, 'ind'), line('Remeasurements and modifications', c => c.remeasure, 'ind'), line('Depreciation charge for the period', c => -c.depreciation, 'ind'), line('Impairment', c => -c.impairment, 'ind'), line('Derecognised (terminations, decreases in scope)', c => -c.derecognised, 'ind'), line(`Balance at ${fmtDate(to)}`, c => c.closing, 'total')]);
    };
    const liab = () => {
        const L = mv.liab, sp = currentSplit(to);
        add('Lease liabilities', ['Lease liabilities', 'Amount'], [R([`Balance at ${fmtDate(addDays(from, -1))}`, L.opening], 'sub'), R(['Additions', L.additions], 'ind'), R(['Remeasurements and modifications', L.remeasure], 'ind'), R(['Interest expense', L.interest], 'ind'), R(['Lease payments', -L.payments], 'ind'), R(['Derecognised (terminations, decreases in scope)', -L.derecognised], 'ind'), R([`Balance at ${fmtDate(to)}`, L.closing], 'total'), R(['Current', sp.current], 'ind'), R(['Non-current', sp.nonCurrent], 'ind')]);
        if (Math.abs(sp.total - L.closing) > 1) parts.push({ kind: 'note', text: 'Note: closing balance and split differ because of leases outside the period filters.' });
    };
    const mat = () => {
        const s = maturityTable('lessee', to, BANDS_STANDARD), d = maturityTable('lessee', to, BANDS_DETAILED);
        add('Maturity analysis: lease liabilities (undiscounted)', ['Contractual undiscounted cash flows', 'Amount'], s.rows.map(r => R([r.label, r.amount], 'ind')).concat([R(['Total undiscounted lease liabilities', s.total], 'sub'), R(['Less: future finance charges', -s.finance], 'ind'), R([`Lease liabilities at ${fmtDate(to)}`, s.carrying], 'total')]), 'IFRS 16.58 requires a maturity analysis applying IFRS 7.39 and B11. Choose time bands that suit your liquidity risk; both a standard and a detailed view are given.');
        add('Maturity analysis: detailed time bands', ['Undiscounted cash flows', 'Amount'], d.rows.map(r => R([r.label, r.amount], 'ind')).concat([R(['Total', d.total], 'total')]));
        const lf = maturityTable('lessor', to, BANDS_LESSOR, 'lessor-finance');
        if (lf.total > 0) add('Maturity analysis: lease payments receivable, finance leases', ['Undiscounted lease payments receivable', 'Amount'], lf.rows.map(r => R([r.label, r.amount], 'ind')).concat([R(['Total undiscounted', lf.total], 'sub'), R(['Less: unearned finance income', -(lf.total - lf.carrying)], 'ind'), R(['Net investment in the lease (incl. present value of unguaranteed residual)', lf.carrying], 'total')]), 'Each of the first five years and a total for the remaining years (16.94).');
        const lo = maturityTable('lessor', to, BANDS_LESSOR, 'lessor-operating');
        if (lo.total > 0) add('Maturity analysis: operating lease payments receivable', ['Undiscounted lease payments', 'Amount'], lo.rows.map(r => R([r.label, r.amount], 'ind')).concat([R(['Total', lo.total], 'total')]), '16.97.');
    };
    const pl = () => {
        const P = mv.pl;
        const rows = Object.keys(P.depByClass).map(k => R([`Depreciation: ${ASSET_CLASSES[k] || k}`, P.depByClass[k]], 'ind'));
        rows.push(R(['Total depreciation of right-of-use assets', sum(Object.values(P.depByClass), x => x)], 'sub'), R(['Interest expense on lease liabilities', P.interest], 'ind'), R(['Expense relating to short-term leases', P.st], 'ind'), R(['Expense relating to leases of low-value assets', P.lv], 'ind'), R(['Expense relating to variable lease payments not in the liability', P.variable], 'ind'), R(['Impairment of right-of-use assets', P.impairment], 'ind'), R(['(Gain) / loss on lease modifications and terminations', -P.gain], 'ind'), R(['Unwinding of restoration provisions', P.provInterest], 'ind'), R(['Finance income on security deposits', -P.depositIncome], 'ind'));
        rows.push(R(['Total recognised in profit or loss', sum(Object.values(P.depByClass), x => x) + P.interest + P.st + P.lv + P.variable + P.impairment - P.gain + P.provInterest - P.depositIncome], 'total'));
        add('Amounts recognised in profit or loss', ['Lessee', 'Amount'], rows, '16.53(a)-(f), (i).');
        const principal = mv.liab.payments - mv.liab.interest;
        const cf = [R(['Repayment of principal portion of lease liabilities', principal], 'ind'), R([`Interest paid on lease liabilities (${SETTINGS.interestCashFlow} activities)`, mv.liab.interest], 'ind'), R(['Short-term, low-value and variable payments (operating activities)', mv.cashOut - mv.liab.payments - initialCash(from, to)], 'ind'), R(['Payments at commencement and initial direct costs', initialCash(from, to)], 'ind'), R(['Total cash outflow for leases', mv.cashOut], 'total')];
        add('Cash flows', ['Lessee', 'Amount'], cf, 'Principal in financing activities; interest per the policy in Settings (IAS 7.31-33); exempt and variable payments in operating activities (16.50). Total cash outflow is disclosed under 16.53(g). Interest shown is the expense for the period, a close proxy for interest paid.');
        add('Additions to right-of-use assets', ['Lessee', 'Amount'], [R(['Additions to right-of-use assets', mv.additionsROU], 'total')], '16.53(h).');
    };
    const lessor = () => {
        const s = lessorSummary(from, to);
        add('Lessor: amounts in profit or loss', ['Lessor', 'Amount'], [R(['Finance leases: selling profit or loss', s.fin.sellingProfit], 'ind'), R(['Finance leases: finance income on the net investment', s.fin.financeIncome], 'ind'), R(['Finance leases: income from variable payments not in the net investment', s.fin.variable], 'ind'), R(['Operating leases: lease income', s.op.income], 'ind'), R(['Operating leases: of which variable payments not based on an index or rate', s.op.variable], 'ind')], '16.90.');
        add('Lessor: net investment', ['Lessor', 'Amount'], [R([`Net investment in finance leases at ${fmtDate(to)}`, s.fin.closingNI], 'total')], '16.93: explain significant changes in the carrying amount.');
        parts.push({ kind: 'note', text: 'Assets leased out under operating leases remain in property, plant and equipment; disclose them separately from owned assets (16.95). Describe how you manage risk on rights retained in leased assets, including residual value guarantees (16.92).' });
    };
    const commitments = () => {
        const st: StmtRow[] = [], nc: StmtRow[] = [];
        for (const l of Store.leases.filter(l => isLive(l) && l.role === 'lessee')) {
            const r = getResult(l); if (!r) continue;
            if (r.mode === 'exempt' && r.exemption === 'short-term') { const rem = sum(r.cashflows.filter(f => f.date > to), f => f.amount); if (rem) st.push(R([`${l.id} ${l.name}`, conv(l, rem)], 'ind')); }
            if (l.terms.commencement > to) nc.push(R([`${l.id} ${l.name} (commences ${fmtDate(l.terms.commencement)})`, conv(l, sum(initialFlows(l.terms).flows, f => f.amount))], 'ind'));
        }
        for (const l of Store.leases.filter(l => l.status === 'pending' && l.role === 'lessee')) nc.push(R([`${l.id} ${l.name} (signed, awaiting approval in this system)`, conv(l, sum(initialFlows(l.terms).flows, f => f.amount))], 'ind'));
        add('Short-term lease commitments', ['Lessee', 'Amount'], st.concat([R(['Total', sum(st, x => x.cells[1])], 'total')]), '16.55: disclose the commitment if the short-term leases at the end of the period differ from those that gave the short-term expense.');
        add('Leases committed but not yet commenced', ['Lessee', 'Undiscounted payments'], nc.concat([R(['Total', sum(nc, x => x.cells[1])], 'total')]), '16.59(b)(iv).');
    };
    const checklist = () => {
        const items = DISCLOSURE_CHECKLIST.map(c => R([`${c.ref}: ${c.text}`, c.auto ? 'Generated' : 'Judgement'], 'ind'));
        add('Disclosure checklist', ['Requirement', 'Status'], items, 'Items marked “Judgement” need narrative from you; the AI advisor can draft them from your portfolio.');
    };
    let title = '';
    if (kind === 'note') {
        title = 'Note: Leases';
        parts.push({ kind: 'policy', text: policyText() });
        rou(); liab(); pl(); mat(); lessor(); commitments();
    } else if (kind === 'rou') { title = 'Right-of-use assets'; rou(); }
    else if (kind === 'liability') { title = 'Lease liabilities'; liab(); }
    else if (kind === 'maturity') { title = 'Maturity analysis'; mat(); }
    else if (kind === 'pl') { title = 'Profit or loss and cash flows'; pl(); }
    else if (kind === 'lessor') { title = 'Lessor disclosures'; lessor(); mat(); }
    else if (kind === 'commitments') { title = 'Commitments'; commitments(); }
    else { title = 'Disclosure checklist'; checklist(); }
    return { title, parts, sheets };
}

/** Entity note for report headers. */
export const scopeNote = (): string => SCOPE.entity ? '. Entity: ' + SCOPE.entity : '';
