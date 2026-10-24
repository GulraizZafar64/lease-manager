/* ======================================================================
   IFRS 16 guidance library
   Each topic: scenario, treatment, paragraph references, journal pattern.
   Topic bodies are authored HTML and rendered as-is.
   ====================================================================== */
export interface KbTopic { id: string; group: string; title: string; refs: string; tags: string; body: string }

export const KB: KbTopic[] = [
 { id: 'identify', group: 'Scope and identification', title: 'Does the contract contain a lease?', refs: '16.9-11, B9-B31', tags: 'identified asset substitution right direct use economic benefits service contract chiller freezer dedicated',
   body: `<p>A contract contains a lease if it conveys the right to control the use of an <strong>identified asset</strong> for a period of time in exchange for consideration. Control means the customer has both the right to obtain substantially all of the economic benefits from use, and the right to direct how and for what purpose the asset is used (B9).</p>
   <ul><li><strong>Identified asset</strong>: explicitly or implicitly specified. Not identified if the supplier has a <em>substantive</em> substitution right: practically able to substitute and would benefit economically from doing so (B14-B19). A capacity portion qualifies only if physically distinct, or substantially all of the capacity (B20).</li>
   <li><strong>Economic benefits</strong>: primary output and by-products, within the defined scope of use (B21-B23).</li>
   <li><strong>Right to direct</strong>: the customer decides how and for what purpose, or those decisions are predetermined and the customer operates the asset or designed it (B24-B30). Protective rights do not prevent this.</li></ul>
   <p><strong>Distribution example:</strong> chillers placed free at retail outlets on condition the retailer stocks your products. Usually the retailer cannot direct the use (you restrict it to your products and can relocate units), so the arrangement is often not a lease from the retailer's side; you keep the chillers in PPE. If the retailer pays a fee and controls use, assess as a lessor.</p>
   <p>Use the decision tree under Calculators to document the assessment.</p>` },
 { id: 'components', group: 'Scope and identification', title: 'Separating lease and non-lease components', refs: '16.12-17, B32-B33', tags: 'maintenance service charge allocation stand-alone price practical expedient combine utilities security',
   body: `<p>Account for each lease component separately from non-lease components (such as maintenance, security, utilities). Allocate the consideration on the relative stand-alone prices of the lease components and the aggregate stand-alone price of the non-lease components (16.13-14).</p>
   <p><strong>Practical expedient (lessee):</strong> by class of underlying asset, elect not to separate and account for the whole as a single lease component (16.15). This increases the liability. Lessors must always separate, applying IFRS 15 (16.17).</p>
   <p>Activities that do not transfer a good or service (admin fees, property taxes the lessor pays) are not components; they form part of the total consideration allocated (B33).</p>
   <p>Your workbook example: 3 printers, a cutting system and a copier with maintenance, total 120,000, is allocated 26,277 to each printer and 3,942 to maintenance on stand-alone prices. The Allocation calculator does this.</p>` },
 { id: 'term', group: 'Measurement', title: 'Lease term and reasonably certain options', refs: '16.18-21, B34-B41', tags: 'extension renewal termination option lock-in reasonably certain non-cancellable notice period leasehold improvements',
   body: `<p>Lease term = the non-cancellable period, plus periods covered by an option to extend if the lessee is <strong>reasonably certain</strong> to exercise it, plus periods covered by an option to terminate if the lessee is reasonably certain <em>not</em> to exercise it (16.18).</p>
   <p>Consider all facts that create an economic incentive (B37): option rents compared with market rates, significant leasehold improvements, relocation and disruption costs, termination penalties, importance of the asset to operations (e.g. a key distribution depot), and past practice (B40).</p>
   <p><strong>Lock-in clauses common in Pakistan:</strong> if either party can terminate after a lock-in with no more than an insignificant penalty, the lease is no longer enforceable after that point (B34), so the non-cancellable period ends at the lock-in. The IFRS Interpretations Committee (November 2019) said “penalty” is read broadly: include economic penalties such as leasehold improvements you would abandon.</p>
   <p>Reassess only on a significant event or change in circumstances within the lessee's control (16.20), and remeasure at a revised discount rate (16.40). In this system: Remeasure or modify, “Reassessment of lease term”.</p>` },
 { id: 'payments', group: 'Measurement', title: 'Lease payments: what goes into the liability', refs: '16.27-28, 16.38, B42', tags: 'fixed variable index CPI KIBOR rate in-substance fixed residual value guarantee purchase option penalty sales turnover rent',
   body: `<p>The liability includes payments not yet paid at commencement (16.27):</p>
   <ul><li>fixed payments, including in-substance fixed payments (B42), less incentives receivable;</li><li>variable payments that depend on an index or a rate (CPI, KIBOR), measured using the index or rate at commencement (16.28);</li><li>amounts expected to be payable under residual value guarantees;</li><li>the exercise price of a purchase option reasonably certain to be exercised;</li><li>termination penalties, if the term reflects exercising a termination option.</li></ul>
   <p><strong>Excluded:</strong> variable payments linked to performance or use, such as a percentage of sales (expensed when incurred, 16.38(b)); non-lease components unless combined; sales tax recoverable.</p>
   <p><strong>Fixed escalations</strong> (e.g. 10% each year, common in Pakistani rent agreements) are fixed payments: include every future step at commencement. <strong>Index-linked</strong> resets are included at today's level and remeasured when they change.</p>` },
 { id: 'rate', group: 'Measurement', title: 'Discount rate: implicit rate and incremental borrowing rate', refs: '16.26, Appendix A', tags: 'IBR incremental borrowing rate implicit KIBOR spread yield curve term security currency',
   body: `<p>Discount at the <strong>rate implicit in the lease</strong> if it can be readily determined; otherwise at the lessee's <strong>incremental borrowing rate</strong> (IBR): the rate the lessee would pay to borrow, over a similar term and with similar security, the funds needed to obtain an asset of similar value in a similar economic environment.</p>
   <p>Building an IBR in Pakistan usually starts from KIBOR (or the PKRV curve) for the lease tenor, plus the entity's credit spread, adjusted for security (the asset) and the lease's payment profile. Foreign-currency leases need a rate in that currency.</p>
   <p>The implicit rate is the rate at which PV of lease payments plus unguaranteed residual value equals the fair value of the asset plus the lessor's initial direct costs. Lessees rarely know the residual value and lessor costs; the system can solve it when you enter them (Measurement tab, “Solve implicit rate”).</p>
   <p><strong>Rate convention:</strong> the IFRS illustrative examples convert annual rates to monthly as (1+r)^(1/12)-1 (effective). Many local Excel models use r/12 (nominal). Choose in Settings; disclose and apply it consistently.</p>` },
 { id: 'initial', group: 'Measurement', title: 'Initial measurement of the right-of-use asset', refs: '16.23-25, IAS 37', tags: 'right-of-use cost initial direct costs incentives restoration dismantling prepaid security deposit commission stamp duty',
   body: `<p>Cost of the right-of-use asset (16.24) = initial lease liability + payments made at or before commencement, less incentives received + initial direct costs + estimated costs to dismantle, remove or restore (recognised as an IAS 37 provision).</p>
   <p><strong>Initial direct costs</strong> are incremental costs that would not have been incurred without the lease: broker commission, stamp duty and registration on the lease deed, payments to a former tenant. Internal staff costs and general legal advice are excluded.</p>
   <p><strong>Refundable security deposits</strong> are financial assets under IFRS 9 measured at fair value; the difference between the amount paid and fair value is a prepaid lease payment added to the right-of-use asset. The system does this and unwinds the deposit as finance income.</p>
   <pre>Dr Right-of-use asset
Dr Bank (incentive received)
Dr Security deposit (fair value)
    Cr Lease liability
    Cr Bank (advance rent, IDC, deposit)
    Cr Restoration provision</pre>` },
 { id: 'subsequent', group: 'Measurement', title: 'Subsequent measurement: interest and depreciation', refs: '16.29-38', tags: 'depreciation interest effective interest straight-line useful life impairment revaluation investment property',
   body: `<p>The liability accrues interest at the discount rate and is reduced by payments (16.36). The right-of-use asset is depreciated under IAS 16 (16.31): from commencement to the earlier of the end of its useful life and the end of the lease term, or over the useful life if ownership transfers or a purchase option is reasonably certain (16.32). Test for impairment under IAS 36 (16.33).</p>
   <p>Total expense is front-loaded compared with straight-line rent: interest is highest early. The dashboard chart “Lease cost against cash” shows this for your portfolio.</p>
   <pre>Monthly:
Dr Interest on lease liabilities     Cr Lease liability
Dr Lease liability                   Cr Bank
Dr Depreciation - ROU assets         Cr Accumulated depreciation - ROU</pre>` },
 { id: 'reassess', group: 'Changes to leases', title: 'Remeasurement: which discount rate?', refs: '16.39-43', tags: 'remeasurement reassessment revised rate unchanged rate index option residual value floating',
   body: `<p>Remeasure the liability and adjust the right-of-use asset (16.39). If the asset is reduced to zero, any further reduction goes to profit or loss.</p>
   <table><thead><tr><th>Trigger</th><th>Rate</th><th>Ref</th></tr></thead><tbody>
   <tr><td>Change in lease term (option reassessment)</td><td>Revised</td><td>16.40(a)</td></tr>
   <tr><td>Change in assessment of a purchase option</td><td>Revised</td><td>16.40(b)</td></tr>
   <tr><td>Change in amount expected under a residual value guarantee</td><td>Unchanged</td><td>16.42(a)</td></tr>
   <tr><td>Change in payments from an index or rate (CPI) when cash flows change</td><td>Unchanged</td><td>16.42(b)</td></tr>
   <tr><td>Change in floating interest rates (KIBOR-linked rent)</td><td>Revised to reflect the rate change</td><td>16.43</td></tr></tbody></table>
   <p>An index change is recognised only when the cash flows actually change (the reset takes effect), not when the index moves.</p>` },
 { id: 'modification', group: 'Changes to leases', title: 'Lease modifications', refs: '16.44-46', tags: 'modification separate lease decrease scope partial termination extension consideration rent reduction renegotiation additional space',
   body: `<p>A modification is a change in scope or consideration that was not part of the original terms. Classify it:</p>
   <ol><li><strong>Separate lease</strong> if it adds the right to use one or more additional assets <em>and</em> the price rises by an amount commensurate with the stand-alone price (16.44). The original lease is untouched.</li>
   <li>Otherwise, at the effective date, allocate the consideration, determine the new term and remeasure the liability at a <strong>revised</strong> discount rate (16.45):
   <ul><li>decrease in scope (less space, shorter term): reduce the asset proportionately to reflect the partial or full termination, recognise a gain or loss, then adjust for the remaining remeasurement (16.46(a));</li><li>all other modifications (rent change, extension, extra space not at stand-alone price): adjust the asset by the remeasurement (16.46(b)).</li></ul></li></ol>
   <p>IFRS 16 IE Examples 15-19 are reproduced in the Validation screen and match to the unit.</p>
   <pre>Decrease in scope:
Dr Lease liability (proportionate)
    Cr Right-of-use asset (proportionate)
    Cr Gain on modification (difference)
Then: Dr/Cr Right-of-use asset   Cr/Dr Lease liability (remeasurement)</pre>` },
 { id: 'concession', group: 'Changes to leases', title: 'Rent waivers and concessions', refs: '16.44-46, 16.38, IFRS 9.3.3.1', tags: 'rent waiver forgiveness discount concession covid reduction',
   body: `<p>The COVID-19 practical expedient (16.46A-46B) only applied to concessions affecting payments originally due on or before 30 June 2022 and is no longer available. A rent waiver now is either:</p>
   <ul><li>a modification (if it changes consideration not in the original terms), measured at a revised rate; or</li><li>where the landlord forgives specific amounts already due and nothing else changes, some entities derecognise that part of the liability under IFRS 9 (extinguishment), with a gain. The Interpretations Committee discussed this in 2022 (IFRIC agenda decision on lessor forgiveness); lessees should set and disclose a policy.</li></ul>` },
 { id: 'termination', group: 'Changes to leases', title: 'Early termination', refs: '16.46(a) by analogy, IFRS 9.3.3.1', tags: 'termination surrender penalty early exit derecognition',
   body: `<p>Derecognise the right-of-use asset and lease liability; recognise the difference and any termination penalty in profit or loss. If the termination is agreed in advance for a future date, remeasure at the agreement date for the shortened term (a decrease in scope) and run the remaining term to the exit date.</p>
   <pre>Dr Lease liability
Dr Accumulated depreciation - ROU
    Cr Right-of-use asset
    Cr Bank (penalty)
    Dr/Cr Gain or loss on termination</pre>` },
 { id: 'exemptions', group: 'Exemptions', title: 'Short-term and low-value leases', refs: '16.5-8, B3-B8', tags: 'short-term low-value exemption 12 months laptop phone printer copier small furniture election',
   body: `<p><strong>Short-term:</strong> lease term of 12 months or less at commencement and no purchase option. Election by class of underlying asset (16.8). A modification or change in term makes it a new lease (16.7).</p>
   <p><strong>Low-value:</strong> assessed on the value of the asset when new, regardless of the lessee's size or materiality (B3-B4). The Board had in mind around USD 5,000 or less (BC100). Not available if the lessee subleases or expects to sublease, or the asset depends on other assets (B5-B7). Cars, trucks and property do not qualify (B6). Election lease by lease.</p>
   <p>Expense the payments straight-line (16.6) and disclose the expense (16.53(c)-(d)) and short-term commitments where relevant (16.55).</p>
   <p><strong>Correction to your uploaded example:</strong> the “low value lease for new lorry” (LessieCorp) does not qualify. A lorry worth EUR 35,000 is not a low-value asset (B6), so it must be recognised on balance sheet unless the term is 12 months or less.</p>` },
 { id: 'presentation', group: 'Presentation and disclosure', title: 'Presentation', refs: '16.47-50, IAS 1, IAS 7', tags: 'balance sheet current non-current cash flow statement presentation',
   body: `<p>Present right-of-use assets separately from other assets (or disclose the line items that include them) and lease liabilities separately from other liabilities (16.47). Right-of-use assets meeting the investment property definition are presented as investment property.</p>
   <p>Interest on lease liabilities is a finance cost, separate from depreciation (16.49). Cash flows: principal in financing; interest per IAS 7 policy; short-term, low-value and variable payments in operating (16.50).</p>
   <p>Split liabilities into current and non-current (IAS 1.60-61). The system takes the principal to be settled within 12 months as current.</p>` },
 { id: 'disclosure-lessee', group: 'Presentation and disclosure', title: 'Lessee disclosures', refs: '16.51-60', tags: 'disclosure note maturity analysis depreciation by class qualitative',
   body: `<p>Quantitative disclosures in a single note or section, in tabular form (16.52-54): depreciation by class; interest expense; short-term, low-value and variable expense; sublease income; total cash outflow; additions; sale and leaseback gains; carrying amount by class. Maturity analysis of lease liabilities under IFRS 7 (16.58).</p>
   <p>Qualitative (16.59): nature of leasing activities, future cash outflows not reflected in the liability (variable payments, extension and termination options, residual value guarantees, leases not yet commenced), restrictions and covenants, sale and leaseback.</p>
   <p>Reports and disclosures produces the quantitative note; the checklist shows what needs narrative. The AI advisor can draft narrative from your portfolio.</p>` },
 { id: 'lessor-class', group: 'Lessors', title: 'Lessor classification: finance or operating', refs: '16.61-66, B53-B57', tags: 'lessor classification finance operating risks rewards land building indicators sublease',
   body: `<p>A finance lease transfers substantially all the risks and rewards incidental to ownership; otherwise it is an operating lease (16.62). Indicators (16.63): ownership transfers; purchase option at a price expected to be sufficiently below fair value; term is the major part of economic life; PV of lease payments amounts to substantially all of fair value; specialised asset. Further indicators (16.64): lessee bears cancellation losses; residual fair value fluctuations fall to the lessee; secondary period at below-market rent.</p>
   <p>IFRS sets no bright lines. The thresholds in Settings (75% of life, 90% of fair value) are a common practice reference, not rules.</p>
   <p><strong>Land and buildings:</strong> classify each element separately; allocate payments on relative fair values of the leasehold interests (B55-B57). Land is often operating because of its indefinite life, unless title passes.</p>
   <p><strong>Subleases:</strong> classify by reference to the right-of-use asset from the head lease, not the underlying asset (B58).</p>` },
 { id: 'lessor-finance', group: 'Lessors', title: 'Lessor finance leases, including manufacturer or dealer', refs: '16.67-80', tags: 'net investment finance income manufacturer dealer selling profit hire purchase unguaranteed residual',
   body: `<p>At commencement recognise a receivable equal to the net investment in the lease: PV of lease payments receivable plus PV of unguaranteed residual value, discounted at the implicit rate. Initial direct costs are included automatically because the implicit rate is defined to include them (16.69).</p>
   <p>Finance income on a constant periodic rate of return (16.75). Apply IFRS 9 derecognition and impairment (expected credit losses) to the net investment (16.77).</p>
   <p><strong>Manufacturer or dealer:</strong> revenue = lower of fair value and PV of lease payments at a market rate; cost of sales = carrying amount less PV of unguaranteed residual; costs of obtaining the lease are expensed (16.71-74). An artificially low rate restricts selling profit.</p>
   <pre>Dr Net investment in leases
Dr Cost of sales
    Cr Revenue
    Cr Inventory</pre>` },
 { id: 'lessor-op', group: 'Lessors', title: 'Lessor operating leases', refs: '16.81-88', tags: 'operating lease income straight-line incentives rent-free depreciation',
   body: `<p>Recognise lease payments as income on a straight-line basis, or another systematic basis if more representative (16.81). Incentives and rent-free periods are spread over the term. Initial direct costs are added to the asset and expensed over the term (16.83). Keep depreciating the underlying asset (16.84).</p>
   <p>A modification is a new lease from the effective date; accrued or prepaid amounts are part of the new lease payments (16.87).</p>` },
 { id: 'slb', group: 'Special transactions', title: 'Sale and leaseback', refs: '16.98-103, 16.102A', tags: 'sale and leaseback slb gain retained rights financing above market below market',
   body: `<p>First decide under IFRS 15 whether the transfer is a sale (16.98). If not, the seller keeps the asset and recognises a financial liability (IFRS 9).</p>
   <p>If it is a sale: the seller-lessee measures the right-of-use asset at the proportion of the previous carrying amount that relates to the right of use retained, and recognises only the gain relating to the rights transferred (16.100). Off-market terms are adjusted: a price above fair value is additional financing; below fair value is a prepayment of rent (16.101).</p>
   <p>The 2022 amendment (16.102A, effective 2024) requires the seller-lessee not to recognise any gain relating to the retained right of use when subsequently measuring the liability, including for variable payments.</p>
   <p>The Sale and leaseback calculator reproduces IFRS 16 IE Example 24 (CU 1.8m building): ROU 699,555, gain 240,355, financial liability 1,459,200.</p>` },
 { id: 'fx', group: 'Special transactions', title: 'Foreign currency leases', refs: 'IAS 21.23, 16 BC', tags: 'foreign currency USD dollar exchange monetary non-monetary translation',
   body: `<p>A lease liability in a foreign currency is a monetary item: retranslate at the closing rate with differences in profit or loss (IAS 21.23, 28). The right-of-use asset is non-monetary: carry it at the historical rate at commencement. Discount at an IBR in the lease currency.</p>
   <p>In this system each lease is measured in its own currency. Portfolio totals convert at the rates in Settings for presentation; book the exchange differences on liabilities through your general ledger revaluation.</p>` },
 { id: 'tax', group: 'Special transactions', title: 'Deferred tax on leases', refs: 'IAS 12.15, 12.22A-22B (2021)', tags: 'deferred tax temporary difference income tax ordinance rentals deductible',
   body: `<p>Where tax deducts lease rentals as paid (as under Pakistan's Income Tax Ordinance 2001 for operating-type rent), the right-of-use asset has a tax base of nil and the liability a tax base of nil, creating taxable and deductible temporary differences.</p>
   <p>The May 2021 amendment to IAS 12 removed the initial recognition exemption for transactions that give rise to equal taxable and deductible temporary differences, so recognise a deferred tax liability (on the ROU asset) and a deferred tax asset (on the liability, subject to recoverability) from commencement. Effective for periods beginning on or after 1 January 2023.</p>` },
 { id: 'deposit', group: 'Special transactions', title: 'Security deposits and advance rent', refs: 'IFRS 9.5.1.1-1A, 16.24(b)', tags: 'security deposit advance rent interest-free refundable fair value',
   body: `<p>An interest-free refundable deposit is a financial asset measured at fair value on initial recognition: the present value of the refund at a market rate. The excess paid is in substance additional rent, added to the right-of-use asset as a prepaid lease payment. The deposit then accretes interest income to the refund amount.</p>
   <p>Advance rent paid before commencement is part of the right-of-use asset (16.24(b)). Advance rent within the lease (e.g. 12 months paid upfront) is simply a payment in advance and reduces the liability.</p>` },
 { id: 'restoration', group: 'Special transactions', title: 'Restoration and leasehold improvements', refs: '16.24(d), IAS 37, IAS 16', tags: 'restoration dismantling make good leasehold improvements provision',
   body: `<p>Obligations to restore the premises are IAS 37 provisions measured at present value, added to the right-of-use asset at commencement (or to the improvement asset if the obligation arises from improvements). The discount unwinds as a finance cost.</p>
   <p>Leasehold improvements are PPE (IAS 16), depreciated over the shorter of their useful life and the lease term. Significant improvements are evidence that extension options are reasonably certain (B37(b)). Reimbursement by the lessor for improvements is not a lease incentive under IFRS 16 (IE Example 13).</p>` },
 { id: 'transition', group: 'Special transactions', title: 'Transition', refs: '16.C1-C20', tags: 'transition first time adoption modified retrospective',
   body: `<p>IFRS 16 applied from 1 January 2019. Options were full retrospective or modified retrospective (cumulative effect in opening retained earnings, comparatives not restated) with practical expedients. In Pakistan the standard was notified for companies following IFRS for periods from the same date. New first-time adopters apply IFRS 1.</p>` },
 { id: 'portfolio', group: 'Special transactions', title: 'Portfolio approach and materiality', refs: '16.B1, 16.2', tags: 'portfolio approach similar leases vehicles materiality',
   body: `<p>A portfolio of leases with similar characteristics (e.g. a fleet of delivery vehicles on the same terms) may be accounted for together if the effect is not materially different from lease-by-lease accounting (B1). Record them as one lease in this system with a description of the units.</p>` }
];
export const KB_ERRATA: [source: string, issue: string][] = [
    ['Examples and solutions IFRS 16, E-1', 'The liability includes the full Rs 10,000 residual value guarantee. IFRS 16.27(c) includes only the amount expected to be payable. With a Rs 1,000 expected salvage value the expected shortfall is Rs 9,000, so the liability should be (50,000 × 2.4869) + (9,000 × 0.7513) = Rs 131,104. Even with the full guarantee the exact figure is Rs 131,856; the 131,842 shown comes from rounded factors. The ledger also shows different interest figures in the schedule (13,186) and interest account (13,184; 5,453 vs 5,471).'],
    ['Examples and solutions IFRS 16, E-2', 'The schedule mixes advance and arrears timing: year 1 shows no payment and 9,429 interest on 94,290, while the first payment was made at commencement. With an advance payment, the liability after the first payment is PV of the remaining two payments plus the purchase option. The Rs 2,000 insurance is a non-lease component, not an “executory cost” (IAS 17 term).'],
    ['Examples and solutions IFRS 16, E-3 and E-4', 'These use US GAAP / IAS 17 terminology (sales-type, direct financing, leveraged lease, minimum lease payments) which IFRS 16 does not use. E-4 records “Bank 139,358 / Unearned lease revenue 20,642” which does not balance against a lease receivable of 160,000 on the same basis as the narrative.'],
    ['IFRS 16 Examples (LessieCorp lorry)', 'Treated as a low-value lease. A lorry is not a low-value asset (16.B6), so the exemption cannot apply; only the short-term exemption could, and the term is 4 years.'],
    ['IFRS 16 Examples (lessor classification options 1 and 2)', 'Uses “minimum lease payments” (IAS 17). Under IFRS 16 the test uses lease payments as defined in Appendix A. The conclusions still hold.'],
    ['Examples workbook, Example 5', 'The remeasurement adjustment is shown as 96,873, adding the liabilities instead of subtracting: 48,940 − 47,933 = 1,007. The ROU carrying amount and monthly depreciation that follow are therefore overstated (new carrying amount should be about 46,706, depreciation about 1,868 a month).'],
    ['Examples workbook, Example 6', 'Narrative says “after the third payment was made” on 1 January 20X3, but the remeasurement table excludes the 20X3 payment and depreciates over 4 years. The arithmetic (46,002 adjustment) is correct; the wording should say the reassessment is on 1 January 20X3 including that day’s payment.'],
    ['IFRS 16 Examples, Example 7 heading', 'Labelled “Example 7” in one file and “Example 17” in the IASB illustrative examples; numbers agree with IE Example 17.']
];
export function kbSearch(q: string): KbTopic[] {
    const words = String(q || '').toLowerCase().split(/\W+/).filter(w => w.length > 2);
    return KB.map(t => { const hay = (t.title + ' ' + t.tags + ' ' + t.refs + ' ' + t.body).toLowerCase(); return { t, s: words.reduce((s, w) => s + (hay.split(w).length - 1) * (t.title.toLowerCase().includes(w) ? 4 : t.tags.includes(w) ? 3 : 1), 0) }; })
        .filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.t);
}
