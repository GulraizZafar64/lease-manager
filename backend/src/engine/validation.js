import Engine from './engine.js';
/* Validation suite: IFRS 16 illustrative examples and the uploaded workbooks.
   Each case builds a lease, runs the engine and compares named figures with the
   published answer (tolerance in currency units, for the examples' rounding). */
const VALIDATION = (() => {
    const base = (o) => Object.assign({
        payment: 0, freqM: 12, timing: 'advance', termMonths: 120, discountRate: 5, rateBasis: 'IBR',
        escalation: { type: 'none' }, extension: null, termination: null, purchase: null, rvg: 0,
        idc: 0, incentives: 0, prepaid: 0, restoration: 0, deposit: 0, usefulLifeM: 0, ownershipTransfer: false,
        exemption: 'none', serviceComponent: 0, combine: true, rentFreeMonths: 0
    }, o);
    const S = { rateConvention: 'effective', majorPartPct: 75, substantiallyAllPct: 90 };
    const yearRow = (res, y) => Engine.aggregate(res, r => Math.floor(r.t / 12))[y - 1];
    const ev = (o) => Object.assign({ id: 'e', status: 'approved' }, o);

    const cases = [
        {
            id: 'IE-13', source: 'IFRS 16 IE Example 13 / your "Initial measurement" sheet', title: 'Lessee: initial measurement, IDC, incentive, change in lease term at revised rate',
            lease: { role: 'lessee', terms: base({ commencement: '2001-01-01', payment: 50000, extension: { months: 60, payment: 55000, certain: false }, idc: 20000, incentives: 5000 }), events: [ev({ type: 'reassess-term', effective: '2007-01-01', newEndMonth: 180, extPayment: 55000, newRate: 6 })] },
            checks: res => [
                ['Lease liability at commencement', res.initial.liability, 355391],
                ['Right-of-use asset at commencement', res.initial.rou, 420391],
                ['Liability end of year 6 (before remeasurement)', yearRow(res, 6).closeL, 186162],
                ['Interest expense year 6', yearRow(res, 6).int, 8865],
                ['Remeasured liability, year 7', res.events[0].remeasured, 378174],
                ['Adjustment to ROU asset', res.events[0].adjustment, 192012],
                ['ROU asset after remeasurement', res.events[0].after.A, 360169],
                ['Depreciation year 7', yearRow(res, 7).dep, 40019],
                ['Interest expense year 7', yearRow(res, 7).int, 19690]
            ]
        },
        {
            id: 'IE-14', source: 'IFRS 16 IE Example 14 / your "Change in interest rate" sheet', title: 'Lessee: CPI-linked payments remeasured at unchanged rate',
            lease: { role: 'lessee', terms: base({ commencement: '2001-01-01', payment: 50000 }), events: [ev({ type: 'reassess-index', effective: '2003-01-01', newPayment: 54000 })] },
            checks: res => [
                ['Lease liability at commencement', res.initial.liability, 355391],
                ['Interest years 1-2', yearRow(res, 1).int + yearRow(res, 2).int, 33928],
                ['Liability before remeasurement', res.events[0].before.L, 339319],
                ['Remeasured liability', res.events[0].remeasured, 366464],
                ['ROU adjustment', res.events[0].adjustment, 27145],
                ['ROU after adjustment', res.events[0].after.A, 351458],
                ['Depreciation year 3', yearRow(res, 3).dep, 43932],
                ['Interest year 3', yearRow(res, 3).int, 15623]
            ]
        },
        {
            id: 'IE-16', source: 'IFRS 16 IE Example 16 / your Example 6', title: 'Modification: extension of term at revised rate',
            lease: { role: 'lessee', terms: base({ commencement: '2001-01-01', payment: 100000, timing: 'arrears', discountRate: 6 }), events: [ev({ type: 'mod-change', effective: '2007-01-01', newEndMonth: 168, newRate: 7 })] },
            checks: res => [
                ['Liability before modification', res.events[0].before.L, 346511],
                ['Modified liability', res.events[0].remeasured, 597130],
                ['Adjustment to ROU asset', res.events[0].adjustment, 250619]
            ]
        },
        {
            id: 'IE-17', source: 'IFRS 16 IE Example 17 / your Example 7', title: 'Modification: decrease in scope (50% of space)',
            lease: { role: 'lessee', terms: base({ commencement: '2001-01-01', payment: 50000, timing: 'arrears', discountRate: 6 }), events: [ev({ type: 'mod-decrease', effective: '2006-01-01', areaRetainedPct: 50, newPayment: 30000, newRate: 5 })] },
            checks: res => [
                ['Pre-modification ROU asset', res.events[0].before.A, 184002],
                ['Pre-modification liability', res.events[0].before.L, 210618],
                ['Decrease in ROU asset', res.events[0].partial.dA, 92001],
                ['Decrease in liability', res.events[0].partial.dL, 105309],
                ['Gain in profit or loss', res.events[0].partial.gain, 13308],
                ['Modified liability', res.events[0].remeasured, 129884],
                ['ROU adjustment for revised consideration', res.events[0].adjustment, 24575]
            ]
        },
        {
            id: 'IE-18', source: 'IFRS 16 IE Example 18 / your Example 8', title: 'Modification: more space, shorter term',
            lease: { role: 'lessee', terms: base({ commencement: '2001-01-01', payment: 100000, timing: 'arrears', discountRate: 6 }), events: [ev({ type: 'mod-decrease', effective: '2006-01-01', newEndMonth: 96, newPayment: 150000, newRate: 7 })] },
            checks: res => [
                ['Pre-modification ROU asset', res.events[0].before.A, 368004],
                ['Pre-modification liability', res.events[0].before.L, 421236],
                ['Decrease in ROU asset', res.events[0].partial.dA, 147202],
                ['Decrease in liability', res.events[0].partial.dL, 153935],
                ['Gain in profit or loss', res.events[0].partial.gain, 6733],
                ['Modified liability', res.events[0].remeasured, 393647],
                ['ROU asset after modification', res.events[0].after.A, 347148],
                ['Depreciation year 6', yearRow(res, 6).dep, 115716],
                ['Interest year 6', yearRow(res, 6).int, 27555]
            ]
        },
        {
            id: 'IE-19', source: 'IFRS 16 IE Example 19 / your Example 9', title: 'Modification: change in consideration only',
            lease: { role: 'lessee', terms: base({ commencement: '2001-01-01', payment: 100000, timing: 'arrears', discountRate: 6 }), events: [ev({ type: 'mod-change', effective: '2006-01-01', newPayment: 95000, newRate: 7 })] },
            checks: res => [
                ['Liability before modification', res.events[0].before.L, 421236],
                ['Modified liability', res.events[0].remeasured, 389519],
                ['Adjustment to ROU asset', res.events[0].adjustment, -31717]
            ]
        },
        {
            id: 'WB-2', source: 'Your workbook, Example 2 (monthly, extension at half rent)', title: 'Monthly arrears payments with extension reasonably certain',
            lease: { role: 'lessee', terms: base({ commencement: '2001-01-01', payment: 10000, freqM: 1, timing: 'arrears', termMonths: 12, discountRate: 3, extension: { months: 12, payment: 5000, certain: true }, idc: 1200 }), events: [] },
            checks: res => [
                ['Lease liability at commencement', res.initial.liability, 175427],
                ['Right-of-use asset', res.initial.rou, 176627],
                ['Interest month 1', res.rows[0].int, 433],
                ['Interest year 1', yearRow(res, 1).int, 3622],
                ['Depreciation year 1', yearRow(res, 1).dep, 88314]
            ]
        },
        {
            id: 'WB-3', source: 'Your workbook, Example 3 (Stamper Co)', title: 'Purchase obligation; implicit rate; depreciation over useful life',
            lease: { role: 'lessee', terms: base({ commencement: '2001-01-01', payment: 110000, timing: 'arrears', termMonths: 60, discountRate: 0, rateBasis: 'solve', fairValue: 500000, lessorIDC: 3000, purchase: { price: 1000, certain: true }, idc: 2000, usefulLifeM: 72 }), events: [] },
            checks: res => [
                ['Implicit rate (%)', res.initial.annualRate, 3.11, 0.01],
                ['Lease liability', res.initial.liability, 503000],
                ['Right-of-use asset', res.initial.rou, 505000],
                ['Interest year 1', yearRow(res, 1).int, 15660],
                ['Depreciation year 1 (6-year life)', yearRow(res, 1).dep, 84167]
            ]
        },
        {
            id: 'WB-4', source: 'Your workbook, Example 4', title: 'Monthly payments with a 3-month rent-free period',
            lease: { role: 'lessee', terms: base({ commencement: '2001-03-01', payment: 2000, freqM: 1, timing: 'arrears', termMonths: 48, discountRate: 4, rentFreeMonths: 3, idc: 5000 }), events: [] },
            checks: res => [
                ['Lease liability', res.initial.liability, 82742],
                ['Right-of-use asset', res.initial.rou, 87742],
                ['Interest Mar-Dec', Engine.periodTotals(res, '2001-03-01', '2001-12-31').int, 2611],
                ['Depreciation Mar-Dec', Engine.periodTotals(res, '2001-03-01', '2001-12-31').dep, 18280]
            ]
        },
        {
            id: 'WB-6', source: 'Your workbook, Example 6 (Delia)', title: 'Annual advance payments; extension becomes reasonably certain',
            lease: { role: 'lessee', terms: base({ commencement: '2001-01-01', payment: 25000, termMonths: 48, discountRate: 4, idc: 3000 }), events: [ev({ type: 'reassess-term', effective: '2003-01-01', newEndMonth: 72, extPayment: 25000, newRate: 3.5 })] },
            checks: res => [
                ['Lease liability', res.initial.liability, 94377 - 25000],
                ['Right-of-use asset', res.initial.rou, 97377],
                ['Depreciation year 1', yearRow(res, 1).dep, 24344],
                ['Liability increase on remeasurement', res.events[0].adjustment, 46002],
                ['Depreciation year 3 (4 years remaining)', yearRow(res, 3).dep, 23673]
            ]
        },
        {
            id: 'WB-7', source: 'Your workbook, Example 7 (Celia)', title: 'Separate lease: original lease measured at 5%',
            lease: { role: 'lessee', terms: base({ commencement: '2001-01-01', payment: 120000, timing: 'arrears', termMonths: 96, discountRate: 5 }), events: [] },
            checks: res => [['Lease liability', res.initial.liability, 775586], ['Interest year 1', yearRow(res, 1).int, 38779]]
        },
        {
            id: 'LR-11', source: 'Your PDF, FinanceLease Co', title: 'Lessor finance lease: implicit rate solved from FV + IDC',
            lease: { role: 'lessor', terms: base({ commencement: '2001-01-01', payment: 110000, timing: 'arrears', termMonths: 60, discountRate: 0, rateBasis: 'solve', fairValue: 500000, carryingAmount: 500000, lessorIDC: 3000, urv: 1000, usefulLifeM: 72, classification: 'finance' }), events: [] },
            checks: res => [
                ['Net investment', res.initial.netInvestment, 503000],
                ['Implicit rate (%)', res.initial.annualRate, 3.11, 0.01],
                ['Finance income year 1', yearRow(res, 1).int, 15660],
                ['Net investment end of year 1', yearRow(res, 1).closeL, 408660]
            ]
        },
        {
            id: 'LR-12', source: 'Your PDF, CarProd', title: 'Manufacturer lessor: selling profit and finance income',
            lease: { role: 'lessor', terms: base({ commencement: '2001-01-01', payment: 8500, timing: 'arrears', termMonths: 48, fairValue: 30000, carryingAmount: 27000, lessorIDC: 1000, dealer: true, ownershipTransfer: true, classification: 'auto' }), events: [] },
            checks: res => [
                ['Classified as finance', res.mode === 'lessor-finance' ? 1 : 0, 1],
                ['Implicit rate (%)', res.initial.annualRate, 5.20, 0.01],
                ['Revenue', res.initial.revenue, 30000],
                ['Selling profit after IDC', res.initial.sellingProfit, 2000],
                ['Finance income year 1', yearRow(res, 1).int, 1560]
            ]
        },
        {
            id: 'LR-13', source: 'Your PDF, Lessor Co', title: 'Lessor operating lease with a first-year discount',
            lease: { role: 'lessor', terms: base({ commencement: '2001-01-01', payment: 170000, timing: 'arrears', termMonths: 72, rentFreeMonths: 0, carryingAmount: 1000000, usefulLifeM: 120, fairValue: 1000000, classification: 'operating' }), events: [], firstYearOverride: 50000 },
            checks: res => [
                ['Rental income year 1', yearRow(res, 1).income, 150000],
                ['Depreciation year 1', yearRow(res, 1).assetDep, 100000]
            ]
        }
    ];
    // Lessor Co: first rental 50,000 instead of 170,000, i.e. an incentive of 120,000 netted against the first receipt.
    cases.find(c => c.id === 'LR-13').lease.terms.incentives = 120000;

    function run(settings) {
        return cases.map(c => {
            const lease = JSON.parse(JSON.stringify(c.lease));
            const res = Engine.run(lease, Object.assign({}, S, settings || {}, { rateConvention: 'effective' }));
            const rows = c.checks(res).map(([label, got, exp, tol]) => {
                const t = tol ?? Math.max(2, Math.abs(exp) * 0.00002);
                return { label, got, exp, pass: Math.abs(got - exp) <= t };
            });
            return { id: c.id, title: c.title, source: c.source, rows, pass: rows.every(r => r.pass) };
        });
    }
    return { run, cases };
})();
export default VALIDATION;
