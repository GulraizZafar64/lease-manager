/* ======================================================================
   IFRS 16 calculation engine
   Monthly simulation. Month t covers [commencement + t months, + t+1 months).
   Advance payments fall at the start of a month, arrears at the end.
   Events (remeasurements, modifications, terminations) take effect at the
   start of a month, after arrears payments for the previous month and
   before advance payments for the new month (IFRS 16 examples 13, 15-19).
   ====================================================================== */
import { SUM_KEYS } from '../types/engine';
import type {
    AggregateRow, Balance, Band, CashFlow, EngineResult, EngineRow, EngineSettings, EventInput, EventTypeInfo,
    ExemptResult, ExemptRow, FinanceEventResult, FinanceRow, Flow, LeaseInput, LesseeEventResult, LesseeResult,
    LesseeRow, LessorClassification, LessorFinanceResult, LessorOperatingResult, NumLike, OperatingEventResult,
    OperatingRow, TermsInput, Totals,
} from '../types/engine';
import type { EventType } from '../types/lease';

const DAY = 864e5;
const toD = (s: string) => new Date(s + 'T00:00:00Z');
const isoOf = (d: Date) => d.toISOString().slice(0, 10);

export function addMonths(s: string, n: number): string {
    const d = toD(s), day = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return isoOf(d);
}
export const addDays = (s: string, n: number): string => isoOf(new Date(toD(s).getTime() + n * DAY));
/** Whole months from a to b, rounded to nearest. */
export function monthsBetween(a: string, b: string): number {
    const x = toD(a), y = toD(b);
    let m = (y.getUTCFullYear() - x.getUTCFullYear()) * 12 + (y.getUTCMonth() - x.getUTCMonth());
    const probe = addMonths(a, m);
    const diff = (toD(b).getTime() - toD(probe).getTime()) / DAY;
    if (diff > 15) m += 1; else if (diff < -15) m -= 1;
    return m;
}
export const num = (v: unknown): number => (v === '' || v === null || v === undefined || isNaN(Number(v))) ? 0 : Number(v);

/* ---- Rates ---------------------------------------------------------- */
// Convert an annual rate (%) to a monthly compounding rate.
// 'effective': (1+r)^(1/12)-1, the convention used in the IFRS illustrative examples.
// 'nominal'  : r / payments-per-year per payment period, compounded monthly within it.
export function monthlyRate(annualPct: NumLike, freqM: number, convention: string): number {
    const r = num(annualPct) / 100;
    if (convention === 'nominal') {
        const f = freqM || 1;
        return Math.pow(1 + r * f / 12, 1 / f) - 1;
    }
    return Math.pow(1 + r, 1 / 12) - 1;
}
export function annualFromMonthly(im: number, freqM: number, convention: string): number {
    if (convention === 'nominal') { const f = freqM || 1; return (Math.pow(1 + im, f) - 1) * 12 / f * 100; }
    return (Math.pow(1 + im, 12) - 1) * 100;
}
export const pvAt = (flows: Flow[], im: number, t0: number): number => flows.reduce((s, f) => s + f.amount / Math.pow(1 + im, f.t - t0), 0);

/** Monthly IRR: solves pv(flows, i) = target by bisection. */
export function solveMonthly(flows: Flow[], target: number, t0 = 0): number | null {
    let lo = -0.0099, hi = 0.2;
    const g = (i: number) => pvAt(flows, i, t0) - target;
    if (g(lo) * g(hi) > 0) return null;
    for (let k = 0; k < 200; k++) {
        const mid = (lo + hi) / 2;
        if (g(lo) * g(mid) <= 0) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
}

/* ---- Lease term ------------------------------------------------------ */
export function leaseTerm(T: TermsInput): number {
    const base = num(T.termMonths);
    if (T.termination && T.termination.certain && num(T.termination.month) > 0) return Math.min(base, num(T.termination.month));
    if (T.extension && T.extension.certain && num(T.extension.months) > 0) return base + num(T.extension.months);
    return base;
}

/* ---- Cash flows ------------------------------------------------------ */
interface StreamSpec {
    from: number; to: number; amount: NumLike; freqM: number; timing?: string;
    escPct?: NumLike; escEveryM?: NumLike; escAnchor?: number; rentFree?: number; label?: string;
}
// One rent stream between month `from` (inclusive) and `to` (exclusive term end).
function rentStream({ from, to, amount, freqM, timing, escPct, escEveryM, escAnchor, rentFree, label }: StreamSpec): Flow[] {
    const out: Flow[] = [], f = freqM || 1;
    for (let start = from; start < to; start += f) {
        let amt = num(amount);
        if (num(escPct) && num(escEveryM)) amt *= Math.pow(1 + num(escPct) / 100, Math.floor((start - (escAnchor ?? from)) / num(escEveryM)));
        if (rentFree && start < from + rentFree) amt = 0;
        const t = timing === 'arrears' ? Math.min(start + f, to) : start;
        if (amt) out.push({ t, amount: amt, kind: timing === 'arrears' ? 'arr' : 'adv', type: label || 'rent' });
    }
    return out;
}

/** Lease payments for the lease term at commencement (IFRS 16.27). */
export function initialFlows(T: TermsInput): { flows: Flow[]; N: number } {
    const N = leaseTerm(T);
    const base = num(T.termMonths);
    const svc = T.combine ? 0 : num(T.serviceComponent);
    const amt = Math.max(0, num(T.payment) - svc);
    const esc = T.escalation && T.escalation.type === 'fixed' ? T.escalation : null;
    let flows = rentStream({
        from: 0, to: Math.min(base, N), amount: amt, freqM: num(T.freqM) || 1, timing: T.timing,
        escPct: esc ? esc.rate : 0, escEveryM: esc ? esc.everyM : 0, escAnchor: 0, rentFree: num(T.rentFreeMonths),
    });
    if (N > base) { // extension reasonably certain
        const ext = T.extension || {};
        const extAmt = num(ext.payment) ? Math.max(0, num(ext.payment) - svc) : null;
        const last = flows.length ? flows[flows.length - 1].amount : amt;
        flows = flows.concat(rentStream({
            from: base, to: N, amount: extAmt ?? (esc ? last * (1 + num(esc.rate) / 100) : last), freqM: num(T.freqM) || 1, timing: T.timing,
            escPct: extAmt === null && esc ? esc.rate : 0, escEveryM: esc ? esc.everyM : 0, escAnchor: base, label: 'extension',
        }));
    }
    if (T.termination && T.termination.certain && num(T.termination.penalty)) flows.push({ t: N, amount: num(T.termination.penalty), kind: 'arr', type: 'termination penalty' });
    if (T.purchase && T.purchase.certain && num(T.purchase.price)) flows.push({ t: N, amount: num(T.purchase.price), kind: 'arr', type: 'purchase option' });
    if (num(T.rvg)) flows.push({ t: N, amount: num(T.rvg), kind: 'arr', type: 'residual value guarantee' });
    return { flows: flows.sort((a, b) => a.t - b.t), N };
}

function depEndMonth(T: TermsInput, N: number): number {
    const life = num(T.usefulLifeM);
    const owns = T.ownershipTransfer || (T.purchase && T.purchase.certain);
    if (owns && life) return life;          // IFRS 16.32: useful life of the underlying asset
    return life ? Math.min(N, life) : N;     // otherwise earlier of useful life and lease term
}

/* ---- Lessor classification (IFRS 16.61-66) ----------------------------- */
export function classifyLessor(T: TermsInput, settings: EngineSettings): LessorClassification {
    const N = leaseTerm(T);
    const life = num(T.usefulLifeM);
    const { flows } = initialFlows(T);
    const ext = num(T.marketRate) || num(T.discountRate);
    const im = monthlyRate(ext, num(T.freqM) || 1, settings.rateConvention);
    const pv = pvAt(flows, im, 0);
    const fv = num(T.fairValue);
    const ind = [
        { key: 'ownership', label: 'Ownership transfers by the end of the lease term', met: !!T.ownershipTransfer, ref: '16.63(a)' },
        { key: 'purchase', label: 'Purchase option reasonably certain to be exercised', met: !!(T.purchase && T.purchase.certain), ref: '16.63(b)' },
        { key: 'term', label: `Lease term is the major part of economic life (${life ? Math.round(N / life * 100) : '—'}% of ${life ? life / 12 : '—'} years)`, met: life ? N / life >= settings.majorPartPct / 100 : false, ref: '16.63(c)' },
        { key: 'pv', label: `PV of lease payments is substantially all of fair value (${fv ? Math.round(pv / fv * 100) : '—'}%)`, met: fv ? pv / fv >= settings.substantiallyAllPct / 100 : false, ref: '16.63(d)' },
        { key: 'specialised', label: 'Asset is of a specialised nature', met: !!T.specialised, ref: '16.63(e)' },
    ];
    const auto = ind.some(i => i.met) ? 'finance' : 'operating';
    const cls = T.classification && T.classification !== 'auto' ? T.classification : auto;
    return { indicators: ind, auto, classification: cls, pvRatio: fv ? pv / fv : null };
}

/* ---- Event plan builder ----------------------------------------------- */
// Returns the new future cash flows from month te for an event.
function eventFlows(T: TermsInput, ev: EventInput, current: Flow[], te: number, oldEnd: number) {
    const newEnd = ev.newEndMonth != null && ev.newEndMonth !== '' ? num(ev.newEndMonth) : oldEnd;
    const rent = current.filter(f => f.type === 'rent' || f.type === 'extension');
    const keep = rent.filter(f => f.t < newEnd || (f.kind === 'arr' && f.t === newEnd));
    const hasNew = ev.newPayment != null && ev.newPayment !== '';
    const escF = (tt: number) => num(ev.escPct) && num(ev.escEveryM) ? Math.pow(1 + num(ev.escPct) / 100, Math.floor(Math.max(0, tt - te) / num(ev.escEveryM))) : 1;
    const periodStart = (f: Flow) => T.timing === 'arrears' ? f.t - (num(T.freqM) || 1) : f.t;
    let out: Flow[] = keep.map(f => Object.assign({}, f, { amount: hasNew ? num(ev.newPayment) * escF(periodStart(f)) : f.amount }));
    if (newEnd > oldEnd) {
        const freqM = num(T.freqM) || 1;
        const last = out.length ? out[out.length - 1].amount : num(T.payment);
        const extAmt = ev.extPayment != null && ev.extPayment !== '' ? num(ev.extPayment) : (ev.newPayment != null && ev.newPayment !== '' ? num(ev.newPayment) : last);
        // continue the existing payment calendar beyond the old end
        const lastStart = rent.length ? (T.timing === 'arrears' ? rent[rent.length - 1].t - freqM : rent[rent.length - 1].t) : te - freqM;
        const from = Math.max(oldEnd, lastStart + freqM);
        out = out.concat(rentStream({ from, to: newEnd, amount: extAmt, freqM, timing: T.timing, label: 'extension', escPct: hasNew ? num(ev.escPct) : 0, escEveryM: num(ev.escEveryM), escAnchor: te }));
    }
    // end-of-term amounts (IFRS 16.27(c)-(e))
    const purchaseCertain = ev.purchaseCertain != null ? !!ev.purchaseCertain : !!(T.purchase && T.purchase.certain);
    const purchasePrice = ev.purchasePrice != null && ev.purchasePrice !== '' ? num(ev.purchasePrice) : num(T.purchase && T.purchase.price);
    const rvg = ev.rvg != null && ev.rvg !== '' ? num(ev.rvg) : num(T.rvg);
    if (purchaseCertain && purchasePrice) out.push({ t: newEnd, amount: purchasePrice, kind: 'arr', type: 'purchase option' });
    if (rvg) out.push({ t: newEnd, amount: rvg, kind: 'arr', type: 'residual value guarantee' });
    if (num(ev.penalty)) out.push({ t: newEnd, amount: num(ev.penalty), kind: 'arr', type: 'termination penalty' });
    return { flows: out.filter(f => f.t >= te).sort((a, b) => a.t - b.t), newEnd, purchaseCertain };
}

export const EVENT_TYPES: Record<EventType, EventTypeInfo> = {
    'reassess-index': { label: 'Change in an index or rate (e.g. CPI)', rate: 'unchanged', ref: '16.42(b), 16.43', modification: false },
    'reassess-floating': { label: 'Change in floating interest rate', rate: 'revised', ref: '16.43', modification: false },
    'reassess-rvg': { label: 'Change in amount expected under a residual value guarantee', rate: 'unchanged', ref: '16.42(a)', modification: false },
    'reassess-term': { label: 'Reassessment of lease term (extension/termination option)', rate: 'revised', ref: '16.40(a), 16.20-21', modification: false },
    'reassess-purchase': { label: 'Reassessment of purchase option', rate: 'revised', ref: '16.40(b)', modification: false },
    'mod-change': { label: 'Modification: change in consideration or term extension', rate: 'revised', ref: '16.44-46(b)', modification: true },
    'mod-decrease': { label: 'Modification: decrease in scope (area or term)', rate: 'revised', ref: '16.46(a)', modification: true },
    'mod-separate': { label: 'Modification accounted for as a separate lease', rate: 'n/a', ref: '16.44', modification: true },
    'terminate': { label: 'Early termination', rate: 'n/a', ref: '16.46(a) by analogy', modification: true },
    'impair': { label: 'Impairment of right-of-use asset', rate: 'n/a', ref: '16.33, IAS 36', modification: false },
};
export const eventTypeInfo = (type: string): EventTypeInfo | undefined => (EVENT_TYPES as Record<string, EventTypeInfo>)[type];

type TimedEvent = EventInput & { t: number };
const timedEvents = (lease: LeaseInput, commencement: string, filter: (e: EventInput) => boolean, minT: number): TimedEvent[] =>
    (lease.events || []).filter(filter)
        .map(e => Object.assign({}, e, { t: monthsBetween(commencement, e.effective) }))
        .filter(e => e.t >= minT).sort((a, b) => a.t - b.t);

/* ---- Lessee simulation ------------------------------------------------- */
export function runLessee(lease: LeaseInput, settings: EngineSettings): LesseeResult {
    const T = lease.terms, conv = settings.rateConvention;
    const commencement = T.commencement || '';
    const freqM = num(T.freqM) || 1;
    let im = monthlyRate(T.discountRate, freqM, conv);
    const { flows: f0, N: N0 } = initialFlows(T);
    let implicitSolved = false;
    if (T.rateBasis === 'solve' && num(T.fairValue)) { // rate implicit in the lease (IFRS 16 Appendix A)
        const withUrv = f0.concat(num(T.urv) ? [{ t: N0, amount: num(T.urv) }] : []);
        const s = solveMonthly(withUrv, num(T.fairValue) + num(T.lessorIDC), 0);
        if (s !== null) { im = s; implicitSolved = true; }
    }
    let N = N0;
    let flows = f0.map(f => Object.assign({}, f));
    const life = num(T.usefulLifeM);
    let owns = !!(T.ownershipTransfer || (T.purchase && T.purchase.certain));
    let depEnd = depEndMonth(T, N);

    // Initial measurement (IFRS 16.23-28)
    const p0 = flows.filter(f => f.t === 0).reduce((s, f) => s + f.amount, 0);
    flows = flows.filter(f => f.t > 0);
    const L0 = pvAt(flows, im, 0);
    const restoration = num(T.restoration);
    // Refundable security deposit (IFRS 9): measured at fair value, the excess is prepaid rent added to the ROU asset
    const deposit = num(T.deposit);
    const depositFV = deposit ? deposit / Math.pow(1 + monthlyRate(T.discountRate, 12, 'effective'), N) : 0;
    const depositAdj = deposit - depositFV;
    const rou0 = T.rouOverride != null && T.rouOverride !== ''
        ? num(T.rouOverride)
        : L0 + p0 + num(T.prepaid) + num(T.idc) - num(T.incentives) + restoration + depositAdj;
    const initial = { liability: L0, rou: rou0, paidAtCommencement: p0 + num(T.prepaid), idc: num(T.idc), incentives: num(T.incentives), restoration, depositFV, depositAdj, deposit, depMonths: depEnd, monthlyRate: im, annualRate: implicitSolved ? annualFromMonthly(im, freqM, conv) : num(T.discountRate), implicitSolved, termMonths: N };

    let L = L0, A = rou0, prov = restoration, dep = depositFV;
    let depMonthly = depEnd ? A / depEnd : 0;
    const rows: LesseeRow[] = [], evLog: LesseeEventResult[] = [], paid: CashFlow[] = [];
    const events = timedEvents(lease, commencement, e => e.status === 'approved' && e.type !== 'mod-separate', 0);
    let ended = false, endReason: string | null = null;

    for (let t = 0; t < Math.max(N, depEnd) && !ended; t++) {
        const r: LesseeRow = { t, start: addMonths(commencement, t), end: addDays(addMonths(commencement, t + 1), -1), openL: L, openA: A, addL: 0, addA: 0, remL: 0, remA: 0, derL: 0, derA: 0, imp: 0, gain: 0, payAdv: 0, payArr: 0, int: 0, dep: 0, provInt: 0, depInt: 0, cash: 0, events: [] };
        if (t === 0) { r.openL = 0; r.openA = 0; r.addL = L0; r.addA = rou0; r.cash += p0 + num(T.prepaid) + num(T.idc) - num(T.incentives) + deposit; }

        for (const ev of events.filter(e => e.t === t && t > 0)) {
            const info = eventTypeInfo(ev.type);
            const before = { L, A };
            const out: LesseeEventResult = { id: ev.id, type: ev.type, t, date: r.start, before, label: info ? info.label : '', after: before };
            if (ev.type === 'impair') {
                const amt = Math.min(A, num(ev.amount));
                A -= amt; r.imp += amt;
                depMonthly = depEnd - t > 0 ? A / (depEnd - t) : 0;
            } else if (ev.type === 'terminate') {
                const pen = num(ev.penalty);
                r.derL += L; r.derA += A;
                r.gain += L - A - pen; r.cash += pen;
                out.penalty = pen;
                L = 0; A = 0; flows = []; ended = true; endReason = 'terminated';
            } else {
                const newRate = info && info.rate === 'revised' && ev.newRate !== '' && ev.newRate != null ? num(ev.newRate) : null;
                const imNew = newRate !== null ? monthlyRate(newRate, freqM, conv) : im;
                const plan = eventFlows(T, ev, flows, t, N);
                if (ev.type === 'mod-decrease') {
                    const areaPct = ev.areaRetainedPct != null && ev.areaRetainedPct !== '' ? num(ev.areaRetainedPct) / 100 : 1;
                    const remOld = depEnd - t, remNew = Math.max(0, Math.min(plan.newEnd, owns ? depEnd : plan.newEnd) - t);
                    const termFrac = plan.newEnd < N && remOld > 0 ? remNew / remOld : 1;
                    const frac = areaPct * termFrac;
                    // liability retained: original payments up to the new end, at the original rate, times the area retained
                    const truncated = flows.filter(f => f.t < plan.newEnd || (f.kind === 'arr' && f.t === plan.newEnd));
                    const Lret = (plan.newEnd < N ? pvAt(truncated, im, t) : L) * areaPct;
                    const dL = L - Lret, dA = A * (1 - frac);
                    r.derL += dL; r.derA += dA; r.gain += dL - dA;
                    out.partial = { fraction: frac, dL, dA, gain: dL - dA };
                    L -= dL; A -= dA;
                }
                const Ln = pvAt(plan.flows, imNew, t);
                const d = Ln - L;
                r.remL += d;
                let dA = d;
                if (A + dA < 0) { r.gain += -(A + dA); dA = -A; } // IFRS 16.39: excess reduction to profit or loss
                r.remA += dA;
                L = Ln; A += dA; im = imNew; flows = plan.flows; N = plan.newEnd;
                if (plan.purchaseCertain) owns = true;
                depEnd = owns && life ? life : (life ? Math.min(N, life) : N);
                depMonthly = depEnd - t > 0 ? A / (depEnd - t) : 0;
                out.newRate = newRate; out.remeasured = Ln; out.adjustment = d;
            }
            out.after = { L, A };
            r.events.push(out); evLog.push(out);
        }
        if (ended) { r.closeL = 0; r.closeA = 0; rows.push(r); break; }

        // advance payments at t
        for (const f of flows.filter(f => f.t === t && f.kind === 'adv')) { r.payAdv += f.amount; L -= f.amount; paid.push(Object.assign({ date: r.start }, f)); }
        flows = flows.filter(f => !(f.t === t && f.kind === 'adv'));
        // interest
        r.int = L * im; L += r.int;
        if (prov) { r.provInt = prov * im; prov += r.provInt; }
        if (dep) { const di = dep * monthlyRate(T.discountRate, 12, 'effective'); r.depInt = di; dep += di; }
        // depreciation
        if (t < depEnd) { r.dep = Math.min(A, depMonthly); A -= r.dep; }
        // arrears payments at t+1
        for (const f of flows.filter(f => f.t === t + 1 && f.kind === 'arr')) { r.payArr += f.amount; L -= f.amount; paid.push(Object.assign({ date: addMonths(commencement, t + 1) }, f)); }
        flows = flows.filter(f => !(f.t === t + 1 && f.kind === 'arr'));
        if (Math.abs(L) < 0.005) L = 0;
        if (Math.abs(A) < 0.005) A = 0;
        r.cash += r.payAdv + r.payArr;
        r.closeL = L; r.closeA = A; r.provClose = prov; r.depositClose = dep;
        rows.push(r);
    }
    const cashflows: CashFlow[] = paid.filter(p => p.t > 0 || p.kind === 'arr')
        .concat(p0 ? [{ t: 0, date: commencement, amount: p0, kind: 'adv', type: 'rent' }] : [])
        .sort((a, b) => a.t - b.t);
    return { mode: 'lessee', rows, events: evLog, initial, cashflows, termMonths: N, depEnd, endReason, owns };
}

/* ---- Lessee exemption (IFRS 16.6) --------------------------------------- */
function runExempt(lease: LeaseInput): ExemptResult {
    const T = lease.terms;
    const commencement = T.commencement || '';
    const { flows, N } = initialFlows(T);
    const total = flows.reduce((s, f) => s + f.amount, 0) + num(T.idc) - num(T.incentives);
    const perMonth = N ? total / N : 0;
    const rows: ExemptRow[] = [], paid: CashFlow[] = [];
    let accrual = 0; // positive = prepaid
    for (let t = 0; t < N; t++) {
        const r: ExemptRow = { t, start: addMonths(commencement, t), end: addDays(addMonths(commencement, t + 1), -1), expense: perMonth, cash: 0, prepaid: 0, events: [] };
        for (const f of flows.filter(f => (f.kind === 'adv' && f.t === t) || (f.kind === 'arr' && f.t === t + 1))) { r.cash += f.amount; paid.push(Object.assign({ date: f.kind === 'adv' ? r.start : addMonths(commencement, t + 1) }, f)); }
        if (t === 0) r.cash += num(T.idc) - num(T.incentives);
        accrual += r.cash - perMonth; r.prepaid = accrual;
        rows.push(r);
    }
    return { mode: 'exempt', exemption: T.exemption || '', rows, events: [], initial: { monthlyExpense: perMonth, total, termMonths: N }, cashflows: paid, termMonths: N };
}

/* ---- Lessor: finance lease (IFRS 16.67-80) ------------------------------- */
function runLessorFinance(lease: LeaseInput, settings: EngineSettings, cls: LessorClassification): LessorFinanceResult {
    const T = lease.terms, conv = settings.rateConvention, freqM = num(T.freqM) || 1;
    const commencement = T.commencement || '';
    const { flows: fRaw, N: N0 } = initialFlows(T);
    const f0: Flow[] = num(T.incentives) ? fRaw.concat([{ t: 0, amount: -num(T.incentives), kind: 'adv', type: 'incentive' }]) : fRaw;
    let N = N0;
    const urv = num(T.urv);
    const all: Flow[] = f0.concat(urv ? [{ t: N, amount: urv, kind: 'arr', type: 'unguaranteed residual value' }] : []);
    const fv = num(T.fairValue), ca = num(T.carryingAmount), lidc = num(T.lessorIDC);
    let im: number | null, implicitSolved = false;
    if (T.dealer) {
        im = num(T.marketRate) ? monthlyRate(T.marketRate, freqM, conv) : solveMonthly(all, fv, 0);
    } else if (num(T.discountRate) && T.rateBasis !== 'solve') {
        im = monthlyRate(T.discountRate, freqM, conv);
    } else {
        im = solveMonthly(all, fv + lidc, 0); implicitSolved = true;
    }
    const rate = im === null ? monthlyRate(T.discountRate || 0, freqM, conv) : im;
    const NI0 = pvAt(all, rate, 0);
    let revenue = 0, cogs = 0, gainOnDerecognition = 0;
    if (T.dealer) {
        const pvLP = pvAt(f0, rate, 0), pvURV = urv ? urv / Math.pow(1 + rate, N) : 0;
        revenue = Math.min(fv || pvLP, pvLP);
        cogs = ca - pvURV;
    } else gainOnDerecognition = NI0 - lidc - ca; // non-dealer: FV vs carrying amount
    let R = NI0;
    let flows = all.map(f => Object.assign({}, f));
    const r0 = all.filter(f => f.t === 0).reduce((s, f) => s + f.amount, 0);
    const rows: FinanceRow[] = [], evLog: FinanceEventResult[] = [], paid: CashFlow[] = [];
    const events = timedEvents(lease, commencement, e => e.status === 'approved', 1);
    let ended = false;
    for (let t = 0; t < N && !ended; t++) {
        const r: FinanceRow = { t, start: addMonths(commencement, t), end: addDays(addMonths(commencement, t + 1), -1), openL: R, addL: 0, remL: 0, derL: 0, gain: 0, int: 0, rcpAdv: 0, rcpArr: 0, cash: 0, events: [] };
        if (t === 0) { r.openL = 0; r.addL = NI0; r.cash -= (T.dealer ? 0 : ca) + lidc; }
        for (const ev of events.filter(e => e.t === t)) {
            const out: FinanceEventResult = { id: ev.id, type: ev.type, t, date: r.start, before: { L: R }, after: { L: R } };
            if (ev.type === 'terminate') {
                const back = num(ev.assetValue);
                r.derL += R; r.gain += back + num(ev.penalty) - R; r.cash += num(ev.penalty);
                out.assetValue = back; R = 0; flows = []; ended = true;
            } else {
                const plan = eventFlows(T, ev, flows.filter(f => f.type !== 'unguaranteed residual value'), t, N);
                const nf: Flow[] = plan.flows.concat(urv ? [{ t: plan.newEnd, amount: ev.urv != null && ev.urv !== '' ? num(ev.urv) : urv, kind: 'arr', type: 'unguaranteed residual value' }] : []);
                const Rn = pvAt(nf, rate, t); // IFRS 9 modification at the original effective rate (16.80(b))
                r.remL += Rn - R; r.gain += Rn - R;
                out.adjustment = Rn - R; R = Rn; flows = nf; N = plan.newEnd;
            }
            out.after = { L: R }; r.events.push(out); evLog.push(out);
        }
        if (ended) { r.closeL = 0; rows.push(r); break; }
        for (const f of flows.filter(f => f.t === t && f.kind === 'adv')) { r.rcpAdv += f.amount; R -= f.amount; paid.push(Object.assign({ date: r.start }, f)); }
        flows = flows.filter(f => !(f.t === t && f.kind === 'adv'));
        r.int = R * rate; R += r.int;
        for (const f of flows.filter(f => f.t === t + 1 && f.kind === 'arr')) {
            if (f.type === 'unguaranteed residual value') { r.assetReturned = f.amount; }
            else { r.rcpArr += f.amount; paid.push(Object.assign({ date: addMonths(commencement, t + 1) }, f)); }
            R -= f.amount;
        }
        flows = flows.filter(f => !(f.t === t + 1 && f.kind === 'arr'));
        if (Math.abs(R) < 0.005) R = 0;
        r.cash += r.rcpAdv + r.rcpArr; r.closeL = R; rows.push(r);
    }
    return {
        mode: 'lessor-finance', rows, events: evLog, classification: cls, cashflows: paid.sort((a, b) => a.t - b.t),
        initial: { netInvestment: NI0, receivedAtCommencement: r0, monthlyRate: rate, annualRate: annualFromMonthly(rate, freqM, conv), implicitSolved, revenue, cogs, sellingProfit: T.dealer ? revenue - cogs - lidc : 0, dealerIDC: T.dealer ? lidc : 0, gainOnDerecognition, urv, pvURV: urv ? urv / Math.pow(1 + rate, N0) : 0, termMonths: N0 },
        termMonths: N,
    };
}

/* ---- Lessor: operating lease (IFRS 16.81-88) ------------------------------- */
function runLessorOperating(lease: LeaseInput, cls: LessorClassification): LessorOperatingResult {
    const T = lease.terms;
    const commencement = T.commencement || '';
    const { flows: f0, N: N0 } = initialFlows(T);
    let N = N0;
    let flows = f0.map(f => Object.assign({}, f));
    // Incentives granted to the lessee reduce the lease payments (IFRS 16.81, 16.70(a)); netted against the first receipt
    let inc = num(T.incentives);
    for (const f of flows) { if (!inc) break; const d = Math.min(inc, f.amount); f.amount -= d; inc -= d; }
    if (inc) flows.unshift({ t: 0, amount: -inc, kind: 'adv', type: 'incentive' });
    const total = flows.reduce((s, f) => s + f.amount, 0);
    let perMonth = N ? total / N : 0;
    const ca = num(T.carryingAmount), lifeRem = num(T.underlyingRemainingLifeM) || num(T.usefulLifeM);
    const assetDep = lifeRem ? ca / lifeRem : 0;
    const lidc = num(T.lessorIDC), idcAmort = N ? lidc / N : 0;
    let acc = 0; // accrued (+) / deferred (-) lease income
    const rows: OperatingRow[] = [], evLog: OperatingEventResult[] = [], paid: CashFlow[] = [];
    const events = timedEvents(lease, commencement, e => e.status === 'approved', 1);
    let ended = false;
    for (let t = 0; t < N && !ended; t++) {
        const r: OperatingRow = { t, start: addMonths(commencement, t), end: addDays(addMonths(commencement, t + 1), -1), income: 0, cash: 0, assetDep, idcAmort, events: [] };
        for (const ev of events.filter(e => e.t === t)) {
            const out: OperatingEventResult = { id: ev.id, type: ev.type, t, date: r.start, before: { accrued: acc }, after: { accrued: acc } };
            if (ev.type === 'terminate') { r.gain = num(ev.penalty) - acc; r.cash += num(ev.penalty); acc = 0; ended = true; }
            else { // IFRS 16.87: a new lease from the effective date; accrued/deferred balance is part of its payments
                const plan = eventFlows(T, ev, flows, t, N);
                flows = plan.flows; N = plan.newEnd;
                const rem = flows.reduce((s, f) => s + f.amount, 0);
                perMonth = N - t > 0 ? (rem - acc) / (N - t) : 0;
                out.newMonthlyIncome = perMonth;
            }
            out.after = { accrued: acc }; r.events.push(out); evLog.push(out);
        }
        if (ended) { rows.push(r); break; }
        for (const f of flows.filter(f => (f.kind === 'adv' && f.t === t) || (f.kind === 'arr' && f.t === t + 1))) { r.cash += f.amount; paid.push(Object.assign({ date: f.kind === 'adv' ? r.start : addMonths(commencement, t + 1) }, f)); }
        flows = flows.filter(f => !((f.kind === 'adv' && f.t === t) || (f.kind === 'arr' && f.t === t + 1)));
        r.income = perMonth; acc += perMonth - r.cash; r.accrued = acc;
        rows.push(r);
    }
    return { mode: 'lessor-operating', rows, events: evLog, classification: cls, cashflows: paid, initial: { monthlyIncome: total / (N0 || 1), total, assetDepMonthly: assetDep, idc: lidc, termMonths: N0 }, termMonths: N };
}

export function run(lease: LeaseInput, settings: EngineSettings): EngineResult {
    const T = lease.terms;
    if (lease.role === 'lessor') {
        const cls = classifyLessor(T, settings);
        return cls.classification === 'finance' ? runLessorFinance(lease, settings, cls) : runLessorOperating(lease, cls);
    }
    if (T.exemption === 'short-term' || T.exemption === 'low-value') return runExempt(lease);
    return runLessee(lease, settings);
}

/* ---- Balances and aggregation ------------------------------------------- */
/** Read a numeric row field that only some modes have. */
const field = (r: EngineRow | undefined, k: string): number | undefined => r ? (r as unknown as Record<string, number | undefined>)[k] : undefined;

/** Balances at the end of the day `date`. */
export function balanceAt(res: EngineResult, date: string): Balance {
    const rows: EngineRow[] = res.rows;
    if (!rows.length || date < rows[0].start) return { L: 0, A: 0, accrued: 0, prepaid: 0 };
    const cur = rows.find(r => r.start <= date && date <= r.end);
    const f = (k: string) => field(cur, k) || 0;
    if (cur && cur.end !== date && field(cur, 'closeL') !== undefined) {
        // part-way through a month: payments and events at the start have happened; interest and depreciation accrue by day
        const days = (toD(cur.end).getTime() - toD(cur.start).getTime()) / DAY + 1, frac = ((toD(date).getTime() - toD(cur.start).getTime()) / DAY + 1) / days;
        const L = f('openL') + f('addL') + f('remL') - f('derL') - f('payAdv') - f('rcpAdv') + f('int') * frac;
        const A = f('openA') + f('addA') + f('remA') - f('derA') - f('imp') - f('dep') * frac;
        return { L: Math.abs(L) < 0.005 ? 0 : L, A: Math.abs(A) < 0.005 ? 0 : A, accrued: f('accrued'), prepaid: f('prepaid') };
    }
    let last: EngineRow | null = null;
    for (const r of rows) { if (r.end <= date) last = r; else break; }
    if (!last) return { L: 0, A: 0, accrued: 0, prepaid: 0 };
    return { L: field(last, 'closeL') || 0, A: field(last, 'closeA') || 0, accrued: field(last, 'accrued') || 0, prepaid: field(last, 'prepaid') || 0 };
}

const zeroTotals = (): Totals => Object.fromEntries(SUM_KEYS.map(k => [k, 0])) as Totals;

/** Aggregate monthly rows into buckets (by a key function). */
export function aggregate(res: EngineResult, keyFn: (r: EngineRow) => string | number): AggregateRow[] {
    const out: AggregateRow[] = [];
    let cur: AggregateRow | null = null;
    for (const r of res.rows as EngineRow[]) {
        const k = keyFn(r);
        if (!cur || cur.key !== k) {
            cur = Object.assign(zeroTotals(), { key: k, start: r.start, end: r.end, openL: field(r, 'openL') || 0, openA: field(r, 'openA') || 0, events: [] });
            out.push(cur);
        }
        for (const s of SUM_KEYS) cur[s] += field(r, s) || 0;
        cur.end = r.end; cur.closeL = field(r, 'closeL'); cur.closeA = field(r, 'closeA'); cur.accrued = field(r, 'accrued'); cur.prepaid = field(r, 'prepaid');
        cur.events = cur.events.concat(r.events || []);
    }
    return out;
}
/** Sum of row fields for months whose start lies in [from, to]. */
export function periodTotals(res: EngineResult, from: string, to: string): Totals {
    const tot = zeroTotals();
    for (const r of res.rows as EngineRow[]) if (r.start >= from && r.start <= to) for (const s of SUM_KEYS) tot[s] += field(r, s) || 0;
    return tot;
}
/** Undiscounted cash flows after `date`, bucketed (IFRS 16.58, 16.94, 16.97). */
export function maturity(res: EngineResult, date: string, bands: Band[]): { label: string; amount: number }[] {
    const out = bands.map(b => ({ label: b.label, amount: 0 }));
    for (const f of res.cashflows) {
        if (f.date <= date) continue;
        if (f.type === 'unguaranteed residual value') continue;
        const days = (toD(f.date).getTime() - toD(date).getTime()) / DAY;
        const idx = bands.findIndex(b => days <= b.maxDays);
        out[idx === -1 ? out.length - 1 : idx].amount += f.amount;
    }
    return out;
}

export const Engine = {
    run, runLessee, classifyLessor, initialFlows, leaseTerm, monthlyRate, annualFromMonthly, pvAt, solveMonthly,
    balanceAt, aggregate, periodTotals, maturity, addMonths, addDays, monthsBetween, EVENT_TYPES, num,
};
