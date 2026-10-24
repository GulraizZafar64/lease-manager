/* IFRS 16 calculation engine: identical to the validated browser engine. */
/* ======================================================================
   IFRS 16 calculation engine
   Monthly simulation. Month t covers [commencement + t months, + t+1 months).
   Advance payments fall at the start of a month, arrears at the end.
   Events (remeasurements, modifications, terminations) take effect at the
   start of a month, after arrears payments for the previous month and
   before advance payments for the new month (IFRS 16 examples 13, 15-19).
   ====================================================================== */
const Engine = (() => {
    const DAY = 864e5;
    const toD = iso => new Date(iso + 'T00:00:00Z');
    const iso = d => d.toISOString().slice(0, 10);
    function addMonths(s, n) {
        const d = toD(s), day = d.getUTCDate();
        d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
        const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
        d.setUTCDate(Math.min(day, last));
        return iso(d);
    }
    const addDays = (s, n) => iso(new Date(toD(s).getTime() + n * DAY));
    function monthsBetween(a, b) { // whole months from a to b, rounded to nearest
        const x = toD(a), y = toD(b);
        let m = (y.getUTCFullYear() - x.getUTCFullYear()) * 12 + (y.getUTCMonth() - x.getUTCMonth());
        const probe = addMonths(a, m);
        const diff = (toD(b) - toD(probe)) / DAY;
        if (diff > 15) m += 1; else if (diff < -15) m -= 1;
        return m;
    }
    const num = v => (v === '' || v === null || v === undefined || isNaN(Number(v))) ? 0 : Number(v);

    /* ---- Rates ---------------------------------------------------------- */
    // Convert an annual rate (%) to a monthly compounding rate.
    // 'effective': (1+r)^(1/12)-1, the convention used in the IFRS illustrative examples.
    // 'nominal'  : r / payments-per-year per payment period, compounded monthly within it.
    function monthlyRate(annualPct, freqM, convention) {
        const r = num(annualPct) / 100;
        if (convention === 'nominal') {
            const f = freqM || 1;
            return Math.pow(1 + r * f / 12, 1 / f) - 1;
        }
        return Math.pow(1 + r, 1 / 12) - 1;
    }
    function annualFromMonthly(im, freqM, convention) {
        if (convention === 'nominal') { const f = freqM || 1; return (Math.pow(1 + im, f) - 1) * 12 / f * 100; }
        return (Math.pow(1 + im, 12) - 1) * 100;
    }
    const pvAt = (flows, im, t0) => flows.reduce((s, f) => s + f.amount / Math.pow(1 + im, f.t - t0), 0);

    // Monthly IRR: solves pv(flows, i) = target by bisection.
    function solveMonthly(flows, target, t0 = 0) {
        let lo = -0.0099, hi = 0.2;
        const g = i => pvAt(flows, i, t0) - target;
        if (g(lo) * g(hi) > 0) return null;
        for (let k = 0; k < 200; k++) {
            const mid = (lo + hi) / 2;
            if (g(lo) * g(mid) <= 0) hi = mid; else lo = mid;
        }
        return (lo + hi) / 2;
    }

    /* ---- Lease term ------------------------------------------------------ */
    function leaseTerm(T) {
        const base = num(T.termMonths);
        if (T.termination && T.termination.certain && num(T.termination.month) > 0) return Math.min(base, num(T.termination.month));
        if (T.extension && T.extension.certain && num(T.extension.months) > 0) return base + num(T.extension.months);
        return base;
    }

    /* ---- Cash flows ------------------------------------------------------ */
    // One rent stream between month `from` (inclusive) and `to` (exclusive term end).
    function rentStream({ from, to, amount, freqM, timing, escPct, escEveryM, escAnchor, rentFree, label }) {
        const out = [], f = freqM || 1;
        for (let start = from; start < to; start += f) {
            if (start + f > to && timing === 'arrears' && start + f - to > 0 && start + f > to) {
                // a final stub period shorter than the frequency: pay at the term end
            }
            let amt = num(amount);
            if (num(escPct) && num(escEveryM)) amt *= Math.pow(1 + num(escPct) / 100, Math.floor((start - (escAnchor ?? from)) / num(escEveryM)));
            if (rentFree && start < from + rentFree) amt = 0;
            const t = timing === 'arrears' ? Math.min(start + f, to) : start;
            if (amt) out.push({ t, amount: amt, kind: timing === 'arrears' ? 'arr' : 'adv', type: label || 'rent' });
        }
        return out;
    }

    // Lease payments for the lease term at commencement (IFRS 16.27).
    function initialFlows(T) {
        const N = leaseTerm(T);
        const base = num(T.termMonths);
        const svc = T.combine ? 0 : num(T.serviceComponent);
        const amt = Math.max(0, num(T.payment) - svc);
        const esc = T.escalation && T.escalation.type === 'fixed' ? T.escalation : null;
        let flows = rentStream({
            from: 0, to: Math.min(base, N), amount: amt, freqM: num(T.freqM) || 1, timing: T.timing,
            escPct: esc ? esc.rate : 0, escEveryM: esc ? esc.everyM : 0, escAnchor: 0, rentFree: num(T.rentFreeMonths)
        });
        if (N > base) { // extension reasonably certain
            const ext = T.extension;
            const extAmt = num(ext.payment) ? Math.max(0, num(ext.payment) - svc) : null;
            const last = flows.length ? flows[flows.length - 1].amount : amt;
            flows = flows.concat(rentStream({
                from: base, to: N, amount: extAmt ?? (esc ? last * (1 + num(esc.rate) / 100) : last), freqM: num(T.freqM) || 1, timing: T.timing,
                escPct: extAmt === null && esc ? esc.rate : 0, escEveryM: esc ? esc.everyM : 0, escAnchor: base, label: 'extension'
            }));
        }
        if (T.termination && T.termination.certain && num(T.termination.penalty)) flows.push({ t: N, amount: num(T.termination.penalty), kind: 'arr', type: 'termination penalty' });
        if (T.purchase && T.purchase.certain && num(T.purchase.price)) flows.push({ t: N, amount: num(T.purchase.price), kind: 'arr', type: 'purchase option' });
        if (num(T.rvg)) flows.push({ t: N, amount: num(T.rvg), kind: 'arr', type: 'residual value guarantee' });
        return { flows: flows.sort((a, b) => a.t - b.t), N };
    }

    function depEndMonth(T, N) {
        const life = num(T.usefulLifeM);
        const owns = T.ownershipTransfer || (T.purchase && T.purchase.certain);
        if (owns && life) return life;          // IFRS 16.32: useful life of the underlying asset
        return life ? Math.min(N, life) : N;     // otherwise earlier of useful life and lease term
    }

    /* ---- Lessor classification (IFRS 16.61-66) ----------------------------- */
    function classifyLessor(T, settings) {
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
            { key: 'specialised', label: 'Asset is of a specialised nature', met: !!T.specialised, ref: '16.63(e)' }
        ];
        const auto = ind.some(i => i.met) ? 'finance' : 'operating';
        const cls = T.classification && T.classification !== 'auto' ? T.classification : auto;
        return { indicators: ind, auto, classification: cls, pvRatio: fv ? pv / fv : null };
    }

    /* ---- Event plan builder ----------------------------------------------- */
    // Returns the new future cash flows from month te for an event.
    function eventFlows(T, ev, current, te, oldEnd) {
        const newEnd = ev.newEndMonth != null && ev.newEndMonth !== '' ? num(ev.newEndMonth) : oldEnd;
        const rent = current.filter(f => f.type === 'rent' || f.type === 'extension');
        const keep = rent.filter(f => f.t < newEnd || (f.kind === 'arr' && f.t === newEnd));
        const hasNew = ev.newPayment != null && ev.newPayment !== '';
        const escF = (tt) => num(ev.escPct) && num(ev.escEveryM) ? Math.pow(1 + num(ev.escPct) / 100, Math.floor(Math.max(0, tt - te) / num(ev.escEveryM))) : 1;
        const periodStart = f => T.timing === 'arrears' ? f.t - (num(T.freqM) || 1) : f.t;
        let out = keep.map(f => Object.assign({}, f, { amount: hasNew ? num(ev.newPayment) * escF(periodStart(f)) : f.amount }));
        if (newEnd > oldEnd) {
            const freqM = num(T.freqM) || 1;
            const last = out.length ? out[out.length - 1].amount : num(T.payment);
            const extAmt = ev.extPayment != null && ev.extPayment !== '' ? num(ev.extPayment) : (ev.newPayment != null && ev.newPayment !== '' ? num(ev.newPayment) : last);
            // continue the existing payment calendar beyond the old end
            const lastStart = rent.length ? (T.timing === 'arrears' ? rent[rent.length - 1].t - freqM : rent[rent.length - 1].t) : te - freqM;
            const from = Math.max(oldEnd, lastStart + freqM);
            out = out.concat(rentStream({ from, to: newEnd, amount: extAmt, freqM, timing: T.timing, label: 'extension', escPct: hasNew ? num(ev.escPct) : 0, escEveryM: num(ev.escEveryM), escAnchor: te }).map(f => hasNew && num(ev.escPct) ? f : f));
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

    const EVENT_TYPES = {
        'reassess-index': { label: 'Change in an index or rate (e.g. CPI)', rate: 'unchanged', ref: '16.42(b), 16.43', modification: false },
        'reassess-floating': { label: 'Change in floating interest rate', rate: 'revised', ref: '16.43', modification: false },
        'reassess-rvg': { label: 'Change in amount expected under a residual value guarantee', rate: 'unchanged', ref: '16.42(a)', modification: false },
        'reassess-term': { label: 'Reassessment of lease term (extension/termination option)', rate: 'revised', ref: '16.40(a), 16.20-21', modification: false },
        'reassess-purchase': { label: 'Reassessment of purchase option', rate: 'revised', ref: '16.40(b)', modification: false },
        'mod-change': { label: 'Modification: change in consideration or term extension', rate: 'revised', ref: '16.44-46(b)', modification: true },
        'mod-decrease': { label: 'Modification: decrease in scope (area or term)', rate: 'revised', ref: '16.46(a)', modification: true },
        'mod-separate': { label: 'Modification accounted for as a separate lease', rate: 'n/a', ref: '16.44', modification: true },
        'terminate': { label: 'Early termination', rate: 'n/a', ref: '16.46(a) by analogy', modification: true },
        'impair': { label: 'Impairment of right-of-use asset', rate: 'n/a', ref: '16.33, IAS 36', modification: false }
    };

    /* ---- Lessee simulation ------------------------------------------------- */
    function runLessee(lease, settings) {
        const T = lease.terms, conv = settings.rateConvention;
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
        const rows = [], evLog = [], paid = [];
        const events = (lease.events || []).filter(e => e.status === 'approved' && e.type !== 'mod-separate')
            .map(e => Object.assign({}, e, { t: monthsBetween(T.commencement, e.effective) }))
            .filter(e => e.t >= 0).sort((a, b) => a.t - b.t);
        let ended = false, endReason = null;

        for (let t = 0; t < Math.max(N, depEnd) && !ended; t++) {
            const r = { t, start: addMonths(T.commencement, t), end: addDays(addMonths(T.commencement, t + 1), -1), openL: L, openA: A, addL: 0, addA: 0, remL: 0, remA: 0, derL: 0, derA: 0, imp: 0, gain: 0, payAdv: 0, payArr: 0, int: 0, dep: 0, provInt: 0, depInt: 0, cash: 0, events: [] };
            if (t === 0) { r.openL = 0; r.openA = 0; r.addL = L0; r.addA = rou0; r.cash += p0 + num(T.prepaid) + num(T.idc) - num(T.incentives) + deposit; }

            for (const ev of events.filter(e => e.t === t && t > 0)) {
                const info = EVENT_TYPES[ev.type] || {};
                const before = { L, A };
                const out = { id: ev.id, type: ev.type, t, date: r.start, before, label: info.label };
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
                    const newRate = info.rate === 'revised' && ev.newRate !== '' && ev.newRate != null ? num(ev.newRate) : null;
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
            for (const f of flows.filter(f => f.t === t + 1 && f.kind === 'arr')) { r.payArr += f.amount; L -= f.amount; paid.push(Object.assign({ date: addMonths(T.commencement, t + 1) }, f)); }
            flows = flows.filter(f => !(f.t === t + 1 && f.kind === 'arr'));
            if (Math.abs(L) < 0.005) L = 0;
            if (Math.abs(A) < 0.005) A = 0;
            r.cash += r.payAdv + r.payArr;
            r.closeL = L; r.closeA = A; r.provClose = prov; r.depositClose = dep;
            rows.push(r);
        }
        return { mode: 'lessee', rows, events: evLog, initial, cashflows: paid.filter(p => p.t > 0 || p.kind === 'arr').concat(p0 ? [{ t: 0, date: T.commencement, amount: p0, kind: 'adv', type: 'rent' }] : []).sort((a, b) => a.t - b.t), termMonths: N, depEnd, endReason, owns };
    }

    /* ---- Lessee exemption (IFRS 16.6) --------------------------------------- */
    function runExempt(lease, settings) {
        const T = lease.terms;
        const { flows, N } = initialFlows(T);
        const total = flows.reduce((s, f) => s + f.amount, 0) + num(T.idc) - num(T.incentives);
        const perMonth = N ? total / N : 0;
        const rows = [], paid = [];
        let accrual = 0; // positive = prepaid
        for (let t = 0; t < N; t++) {
            const r = { t, start: addMonths(T.commencement, t), end: addDays(addMonths(T.commencement, t + 1), -1), expense: perMonth, cash: 0, events: [] };
            for (const f of flows.filter(f => (f.kind === 'adv' && f.t === t) || (f.kind === 'arr' && f.t === t + 1))) { r.cash += f.amount; paid.push(Object.assign({ date: f.kind === 'adv' ? r.start : addMonths(T.commencement, t + 1) }, f)); }
            if (t === 0) r.cash += num(T.idc) - num(T.incentives);
            accrual += r.cash - perMonth; r.prepaid = accrual;
            rows.push(r);
        }
        return { mode: 'exempt', exemption: T.exemption, rows, events: [], initial: { monthlyExpense: perMonth, total, termMonths: N }, cashflows: paid, termMonths: N };
    }

    /* ---- Lessor: finance lease (IFRS 16.67-80) ------------------------------- */
    function runLessorFinance(lease, settings, cls) {
        const T = lease.terms, conv = settings.rateConvention, freqM = num(T.freqM) || 1;
        const { flows: fRaw, N: N0 } = initialFlows(T);
        const f0 = num(T.incentives) ? fRaw.concat([{ t: 0, amount: -num(T.incentives), kind: 'adv', type: 'incentive' }]) : fRaw;
        let N = N0;
        const urv = num(T.urv);
        const all = f0.concat(urv ? [{ t: N, amount: urv, kind: 'arr', type: 'unguaranteed residual value' }] : []);
        const fv = num(T.fairValue), ca = num(T.carryingAmount), lidc = num(T.lessorIDC);
        let im, implicitSolved = false;
        if (T.dealer) {
            im = num(T.marketRate) ? monthlyRate(T.marketRate, freqM, conv) : solveMonthly(all, fv, 0);
        } else if (num(T.discountRate) && T.rateBasis !== 'solve') {
            im = monthlyRate(T.discountRate, freqM, conv);
        } else {
            im = solveMonthly(all, fv + lidc, 0); implicitSolved = true;
        }
        if (im === null) im = monthlyRate(T.discountRate || 0, freqM, conv);
        const NI0 = pvAt(all, im, 0);
        let revenue = 0, cogs = 0, gainOnDerecognition = 0;
        if (T.dealer) {
            const pvLP = pvAt(f0, im, 0), pvURV = urv ? urv / Math.pow(1 + im, N) : 0;
            revenue = Math.min(fv || pvLP, pvLP);
            cogs = ca - pvURV;
        } else gainOnDerecognition = NI0 - lidc - ca; // non-dealer: FV vs carrying amount
        let R = NI0;
        let flows = all.map(f => Object.assign({}, f));
        const r0 = all.filter(f => f.t === 0).reduce((s, f) => s + f.amount, 0);
        const rows = [], evLog = [], paid = [];
        const events = (lease.events || []).filter(e => e.status === 'approved').map(e => Object.assign({}, e, { t: monthsBetween(T.commencement, e.effective) })).filter(e => e.t > 0).sort((a, b) => a.t - b.t);
        let ended = false;
        for (let t = 0; t < N && !ended; t++) {
            const r = { t, start: addMonths(T.commencement, t), end: addDays(addMonths(T.commencement, t + 1), -1), openL: R, addL: 0, remL: 0, derL: 0, gain: 0, int: 0, rcpAdv: 0, rcpArr: 0, cash: 0, events: [] };
            if (t === 0) { r.openL = 0; r.addL = NI0; r.cash -= (T.dealer ? 0 : ca) + lidc; }
            for (const ev of events.filter(e => e.t === t)) {
                const out = { id: ev.id, type: ev.type, t, date: r.start, before: { L: R } };
                if (ev.type === 'terminate') {
                    const back = num(ev.assetValue);
                    r.derL += R; r.gain += back + num(ev.penalty) - R; r.cash += num(ev.penalty);
                    out.assetValue = back; R = 0; flows = []; ended = true;
                } else {
                    const plan = eventFlows(T, ev, flows.filter(f => f.type !== 'unguaranteed residual value'), t, N);
                    const nf = plan.flows.concat(urv ? [{ t: plan.newEnd, amount: ev.urv != null && ev.urv !== '' ? num(ev.urv) : urv, kind: 'arr', type: 'unguaranteed residual value' }] : []);
                    const Rn = pvAt(nf, im, t); // IFRS 9 modification at the original effective rate (16.80(b))
                    r.remL += Rn - R; r.gain += Rn - R;
                    out.adjustment = Rn - R; R = Rn; flows = nf; N = plan.newEnd;
                }
                out.after = { L: R }; r.events.push(out); evLog.push(out);
            }
            if (ended) { r.closeL = 0; rows.push(r); break; }
            for (const f of flows.filter(f => f.t === t && f.kind === 'adv')) { r.rcpAdv += f.amount; R -= f.amount; paid.push(Object.assign({ date: r.start }, f)); }
            flows = flows.filter(f => !(f.t === t && f.kind === 'adv'));
            r.int = R * im; R += r.int;
            for (const f of flows.filter(f => f.t === t + 1 && f.kind === 'arr')) {
                if (f.type === 'unguaranteed residual value') { r.assetReturned = f.amount; }
                else { r.rcpArr += f.amount; paid.push(Object.assign({ date: addMonths(T.commencement, t + 1) }, f)); }
                R -= f.amount;
            }
            flows = flows.filter(f => !(f.t === t + 1 && f.kind === 'arr'));
            if (Math.abs(R) < 0.005) R = 0;
            r.cash += r.rcpAdv + r.rcpArr; r.closeL = R; rows.push(r);
        }
        return {
            mode: 'lessor-finance', rows, events: evLog, classification: cls, cashflows: paid.sort((a, b) => a.t - b.t),
            initial: { netInvestment: NI0, receivedAtCommencement: r0, monthlyRate: im, annualRate: annualFromMonthly(im, freqM, conv), implicitSolved, revenue, cogs, sellingProfit: T.dealer ? revenue - cogs - lidc : 0, dealerIDC: T.dealer ? lidc : 0, gainOnDerecognition, urv, pvURV: urv ? urv / Math.pow(1 + im, N0) : 0, termMonths: N0 },
            termMonths: N
        };
    }

    /* ---- Lessor: operating lease (IFRS 16.81-88) ------------------------------- */
    function runLessorOperating(lease, settings, cls) {
        const T = lease.terms;
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
        const rows = [], evLog = [], paid = [];
        const events = (lease.events || []).filter(e => e.status === 'approved').map(e => Object.assign({}, e, { t: monthsBetween(T.commencement, e.effective) })).filter(e => e.t > 0).sort((a, b) => a.t - b.t);
        let ended = false;
        for (let t = 0; t < N && !ended; t++) {
            const r = { t, start: addMonths(T.commencement, t), end: addDays(addMonths(T.commencement, t + 1), -1), income: 0, cash: 0, assetDep, idcAmort, events: [] };
            for (const ev of events.filter(e => e.t === t)) {
                const out = { id: ev.id, type: ev.type, t, date: r.start, before: { accrued: acc } };
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
            for (const f of flows.filter(f => (f.kind === 'adv' && f.t === t) || (f.kind === 'arr' && f.t === t + 1))) { r.cash += f.amount; paid.push(Object.assign({ date: f.kind === 'adv' ? r.start : addMonths(T.commencement, t + 1) }, f)); }
            flows = flows.filter(f => !((f.kind === 'adv' && f.t === t) || (f.kind === 'arr' && f.t === t + 1)));
            r.income = perMonth; acc += perMonth - r.cash; r.accrued = acc;
            rows.push(r);
        }
        return { mode: 'lessor-operating', rows, events: evLog, classification: cls, cashflows: paid, initial: { monthlyIncome: total / (N0 || 1), total, assetDepMonthly: assetDep, idc: lidc, termMonths: N0 }, termMonths: N };
    }

    function run(lease, settings) {
        const T = lease.terms;
        if (lease.role === 'lessor') {
            const cls = classifyLessor(T, settings);
            return cls.classification === 'finance' ? runLessorFinance(lease, settings, cls) : runLessorOperating(lease, settings, cls);
        }
        if (T.exemption === 'short-term' || T.exemption === 'low-value') return runExempt(lease, settings);
        return runLessee(lease, settings);
    }

    /* ---- Balances and aggregation ------------------------------------------- */
    // Balances at the end of the day `date`.
    function balanceAt(res, date) {
        const rows = res.rows;
        if (!rows.length || date < rows[0].start) return { L: 0, A: 0, accrued: 0, prepaid: 0 };
        const cur = rows.find(r => r.start <= date && date <= r.end);
        if (cur && cur.end !== date && cur.closeL !== undefined) {
            // part-way through a month: payments and events at the start have happened; interest and depreciation accrue by day
            const days = (toD(cur.end) - toD(cur.start)) / DAY + 1, f = ((toD(date) - toD(cur.start)) / DAY + 1) / days;
            const L = (cur.openL || 0) + (cur.addL || 0) + (cur.remL || 0) - (cur.derL || 0) - (cur.payAdv || 0) - (cur.rcpAdv || 0) + (cur.int || 0) * f;
            const A = (cur.openA || 0) + (cur.addA || 0) + (cur.remA || 0) - (cur.derA || 0) - (cur.imp || 0) - (cur.dep || 0) * f;
            return { L: Math.abs(L) < 0.005 ? 0 : L, A: Math.abs(A) < 0.005 ? 0 : A, accrued: cur.accrued || 0, prepaid: cur.prepaid || 0 };
        }
        let last = null;
        for (const r of rows) { if (r.end <= date) last = r; else break; }
        if (!last) return { L: 0, A: 0, accrued: 0, prepaid: 0 };
        return { L: last.closeL || 0, A: last.closeA || 0, accrued: last.accrued || 0, prepaid: last.prepaid || 0 };
    }

    const SUM_KEYS = ['addL', 'addA', 'remL', 'remA', 'derL', 'derA', 'imp', 'gain', 'payAdv', 'payArr', 'int', 'dep', 'provInt', 'depInt', 'cash', 'rcpAdv', 'rcpArr', 'income', 'expense', 'assetDep', 'idcAmort'];
    // Aggregate monthly rows into buckets of `size` months (or by a key function).
    function aggregate(res, keyFn) {
        const out = [];
        let cur = null;
        for (const r of res.rows) {
            const k = keyFn(r);
            if (!cur || cur.key !== k) {
                cur = { key: k, start: r.start, end: r.end, openL: r.openL || 0, openA: r.openA || 0, events: [] };
                SUM_KEYS.forEach(s => cur[s] = 0);
                out.push(cur);
            }
            SUM_KEYS.forEach(s => cur[s] += r[s] || 0);
            cur.end = r.end; cur.closeL = r.closeL; cur.closeA = r.closeA; cur.accrued = r.accrued; cur.prepaid = r.prepaid;
            cur.events = cur.events.concat(r.events || []);
        }
        return out;
    }
    // Sum of row fields for months whose start lies in [from, to].
    function periodTotals(res, from, to) {
        const tot = {}; SUM_KEYS.forEach(s => tot[s] = 0);
        for (const r of res.rows) if (r.start >= from && r.start <= to) SUM_KEYS.forEach(s => tot[s] += r[s] || 0);
        return tot;
    }
    // Undiscounted cash flows after `date`, bucketed (IFRS 16.58, 16.94, 16.97)
    function maturity(res, date, bands) {
        const out = bands.map(b => ({ label: b.label, amount: 0 }));
        for (const f of res.cashflows) {
            if (f.date <= date) continue;
            if (f.type === 'unguaranteed residual value') continue;
            const m = monthsBetween(date, f.date) + (toD(f.date) > toD(addMonths(date, monthsBetween(date, f.date))) ? 0 : 0);
            const days = (toD(f.date) - toD(date)) / DAY;
            const idx = bands.findIndex(b => days <= b.maxDays);
            out[idx === -1 ? out.length - 1 : idx].amount += f.amount;
        }
        return out;
    }

    return { run, runLessee, classifyLessor, initialFlows, leaseTerm, monthlyRate, annualFromMonthly, pvAt, solveMonthly, balanceAt, aggregate, periodTotals, maturity, addMonths, addDays, monthsBetween, EVENT_TYPES, num };
})();
export default Engine;
