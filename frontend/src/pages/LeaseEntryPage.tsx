import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { ScreenProps } from './registry';
import { leaseTerm, num as N } from '../domain/engine';
import { blankLease, contractEnd, isLive } from '../domain/lease';
import { ASSET_CLASSES, CURRENCIES, SETTINGS } from '../domain/settings';
import { Store } from '../domain/store';
import { entities, entityAllowed, gate, logHistory } from '../domain/enterprise';
import { go, goBack } from '../domain/nav';
import { useAppState } from '../hooks/useAppState';
import { MeasurementPanel } from '../components/lease/MeasurementPanel';
import { openEventWizard } from '../components/lease/EventWizard';
import { nextLeaseId } from '../domain/lease';
import { toast } from '../utils/uiStore';
import { deepClone, getPath, setPath } from '../utils/format';
import { fmtDate, todayISO } from '../utils/dates';
import type { Lease, LeaseStatus } from '../types/lease';

/* Lease entry and editing (one form, new and edit modes).
   Inputs carry data-k="path" (e.g. terms.escalation.rate). Inputs with
   data-fin are measurement inputs: locked once a lease is live, because
   changes after commencement must go through remeasurement/modification. */

interface FieldOpts { readOnly?: boolean; req?: boolean; fin?: boolean; type?: string; ph?: string; step?: string; min?: number; hint?: ReactNode }
type FormEl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Field helpers (the original F.text / F.num / F.sel / F.chk). `locked` disables measurement inputs. */
function fieldHelpers(locked: boolean) {
    const fin = (o: FieldOpts) => o.fin ? { 'data-fin': '', disabled: locked } : {};
    const req = (o: FieldOpts) => o.req ? <>{' '}<span className="req">*</span></> : null;
    const hint = (o: FieldOpts) => o.hint ? <div className="hint">{o.hint}</div> : null;
    const F = {
        text: (k: string, label: ReactNode, o: FieldOpts = {}) => (
            <div className="fg"><label htmlFor={`f-${k}`}>{label}{req(o)}</label><input id={`f-${k}`} data-k={k} type={o.type || 'text'} {...fin(o)} placeholder={o.ph} step={o.step} min={o.min} readOnly={o.readOnly} />{hint(o)}</div>
        ),
        num: (k: string, label: ReactNode, o: FieldOpts = {}) => F.text(k, label, Object.assign({ type: 'number', step: 'any' }, o)),
        sel: (k: string, label: ReactNode, opts: [string | number, string][], o: FieldOpts = {}) => (
            <div className="fg"><label htmlFor={`f-${k}`}>{label}{req(o)}</label><select id={`f-${k}`} data-k={k} {...fin(o)}>{opts.map(([v, t]) => <option key={String(v)} value={String(v)}>{t}</option>)}</select>{hint(o)}</div>
        ),
        chk: (k: string, label: ReactNode, o: FieldOpts = {}) => (
            <div className="fg"><label className="check"><input type="checkbox" data-k={k} id={`f-${k}`} {...fin(o)} />{' '}<span>{label}{o.hint ? <span className="hint" style={{ display: 'block' }}>{o.hint}</span> : null}</span></label></div>
        ),
    };
    return F;
}

const TABS: [string, string][] = [['g', 'Contract'], ['t', 'Term and options'], ['p', 'Payments'], ['m', 'Measurement'], ['a', 'Asset'], ['r', 'Lessor'], ['x', 'Late payment rules']];

export function LeaseEntryPage({ params: p }: ScreenProps<'entry'>) {
    useAppState();
    const editing = p.mode === 'edit';
    const [base] = useState<Lease>(() => {
        const b: Lease = editing ? deepClone(Store.get(p.id || '') as Lease) : (p.prefill ? deepClone(p.prefill) : blankLease());
        if (!editing) {
            b.id = b.id || nextLeaseId(b.role);
            if (!N(b.terms.discountRate) && SETTINGS.defaultRate) b.terms.discountRate = SETTINGS.defaultRate;
        }
        return b;
    });
    const locked = editing && isLive(base);
    const roleOpts: [string, string][] = [['lessee', 'Lessee (we lease the asset)'], ['lessor', 'Lessor (we lease it out)']];
    const formRef = useRef<HTMLFormElement>(null);
    const [tab, setTab] = useState(p.tab || 'g');
    const [live, setLive] = useState<Lease>(base);
    const F = fieldHelpers(locked);

    const read = (): Lease => {
        const l = deepClone(base);
        formRef.current?.querySelectorAll<FormEl>('[data-k]').forEach(el => {
            const k = el.dataset.k || '';
            let v: string | number | boolean = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
            if (el.type === 'number') v = v === '' ? '' : Number(v);
            if (k === 'terms.freqM') v = Number(v);
            setPath(l, k, v);
        });
        return l;
    };
    const update = () => setLive(read());

    // fill (once, as the original did after building the form)
    useLayoutEffect(() => {
        const form = formRef.current;
        if (!form) return;
        form.querySelectorAll<FormEl>('[data-k]').forEach(el => {
            const v = getPath(base, el.dataset.k || '');
            if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!v; else el.value = v == null ? '' : String(v);
        });
        update();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const selectTab = (k: string) => flushSync(() => setTab(k));
    const validate = (l: Lease, strict: boolean): boolean => {
        const errs: [string, string, string][] = [];
        if (!l.id.trim()) errs.push(['g', 'id', 'Enter a lease ID.']);
        if (!editing && Store.get(l.id)) errs.push(['g', 'id', 'That lease ID is already used.']);
        if (strict) {
            if (!l.name.trim()) errs.push(['g', 'name', 'Enter a description.']);
            if (!l.counterparty.trim()) errs.push(['g', 'counterparty', 'Enter the counterparty.']);
            if (!l.terms.commencement) errs.push(['t', 'terms.commencement', 'Enter the commencement date.']);
            if (!(N(l.terms.termMonths) > 0)) errs.push(['t', 'terms.termMonths', 'Enter the non-cancellable period in months.']);
            if (!(N(l.terms.payment) > 0)) errs.push(['p', 'terms.payment', 'Enter the payment amount.']);
            if (l.role === 'lessee' && l.terms.exemption === 'none' && !N(l.terms.discountRate) && l.terms.rateBasis !== 'solve') errs.push(['m', 'terms.discountRate', 'Enter a discount rate. Without one the liability would be undiscounted.']);
            if (l.terms.rateBasis === 'solve' && !N(l.terms.fairValue)) errs.push(['m', 'terms.fairValue', 'Enter the fair value to solve the implicit rate.']);
            if (l.terms.exemption === 'short-term' && (leaseTerm(l.terms) > 12 || (l.terms.purchase && N(l.terms.purchase.price)))) errs.push(['t', 'terms.exemption', 'A lease with a term over 12 months or a purchase option is not short-term (Appendix A).']);
            if (l.role === 'lessor' && l.terms.dealer && !N(l.terms.fairValue)) errs.push(['r', 'terms.fairValue', 'Enter the fair value (selling price) for a dealer lease.']);
        }
        if (errs.length) { selectTab(errs[0][0]); const el = formRef.current?.querySelector<HTMLElement>(`[data-k="${errs[0][1]}"]`); if (el) el.focus(); toast(errs[0][2]); return false; }
        return true;
    };
    const save = async (status: LeaseStatus) => {
        const l = read();
        if (!validate(l, status !== 'draft')) return;
        const old = editing ? Store.get(p.id || '') : null;
        if (!editing) { l.createdAt = todayISO(); l.history = l.history || []; }
        if (editing && old && isLive(old)) { logHistory(l, 'Details edited'); }
        else {
            l.status = status;
            logHistory(l, status === 'draft' ? 'Saved as draft' : status === 'pending' ? 'Submitted for approval' : 'Created and activated');
        }
        delete l._source;
        if (!await Store.save(l)) return;
        toast(status === 'draft' ? 'Draft saved' : status === 'pending' ? 'Submitted for approval' : 'Lease saved');
        go('detail', { id: l.id }, { replace: editing });
    };
    const pane = (k: string) => ({ 'data-fp': k, hidden: tab !== k });

    return (
        <div className="entry">
            <div className="card">
                {locked ? <div className="banner warn" style={{ margin: '14px 16px 0' }}><div><strong>Measurement inputs are locked</strong><p>This lease is live. Changes to term, payments or rates after commencement are remeasurements or modifications under IFRS 16.39-46, each with its own discount-rate rule. Use “Remeasure or modify” so the change is measured, journalled and approved.</p></div><div className="banner-actions"><button className="btn" id="go-event" {...gate('lease.change')} onClick={() => openEventWizard(Store.get(p.id || ''))}>Remeasure or modify</button></div></div> : null}
                {p.prefill && p.prefill._source ? <div className="banner" style={{ margin: '14px 16px 0' }}><div><strong>Filled from {p.prefill._source}</strong><p>Check every value against the contract. Judgements such as whether options are reasonably certain are not in the document and default to “no”.</p></div></div> : null}
                <div className="tabs" role="tablist">{TABS.map(([k, v]) => <button key={k} type="button" className={`tab${tab === k ? ' active' : ''}`} data-ft={k} hidden={k === 'r' ? live.role !== 'lessor' : undefined} onClick={() => setTab(k)}>{v}</button>)}</div>
                <form id="lease-form" className="pad" noValidate ref={formRef} onInput={update} onChange={update} onSubmit={e => { e.preventDefault(); save(editing && isLive(base) ? base.status : SETTINGS.requireApproval ? 'pending' : 'active'); }}>
                    <div {...pane('g')}>
                        <div className="row2">{F.text('id', 'Lease ID', { req: true, readOnly: editing })}{F.text('contractNumber', 'Contract number')}</div>
                        {F.text('name', 'Description', { req: true, ph: 'e.g. Distribution warehouse, Port Qasim' })}
                        <div className="row2">{F.sel('role', 'Role', roleOpts, { fin: true, req: true })}{F.text('counterparty', 'Counterparty (lessor or lessee)', { req: true })}</div>
                        <div className="row3">{F.sel('entity', 'Reporting entity', entities().filter(e => entityAllowed(e.name)).map(e => [e.name, `${e.name} (${e.functionalCurrency})`]))}{F.text('costCentre', 'Cost centre')}{F.sel('currency', 'Currency', CURRENCIES.map(c => [c, c]), { fin: true })}</div>
                        <div className="fg"><label htmlFor="f-notes">Notes</label><textarea id="f-notes" data-k="notes" rows={2} placeholder="Judgements made, approvals, links to files"></textarea></div>
                    </div>
                    <div {...pane('t')}>
                        <div className="row3">{F.text('terms.commencement', 'Commencement date', { type: 'date', req: true, fin: true, hint: 'When the lessor makes the asset available for use (16.Appendix A), not the signing date.' })}{F.num('terms.termMonths', 'Non-cancellable period (months)', { req: true, fin: true, min: 1 })}<div className="fg"><label>Contract end date</label><input id="f-endview" readOnly value={live.terms.commencement && N(live.terms.termMonths) ? fmtDate(contractEnd(live)) : ''} /></div></div>
                        <fieldset><legend>Extension option</legend><div className="row3">{F.num('terms.extension.months', 'Extension (months)', { fin: true })}{F.num('terms.extension.payment', 'Payment during extension', { fin: true, hint: 'Leave blank to continue the escalated payment.' })}{F.chk('terms.extension.certain', 'Lessee is reasonably certain to extend', { fin: true, hint: '16.19, B37: below-market rent, leasehold improvements, relocation cost, importance of the asset.' })}</div></fieldset>
                        <fieldset><legend>Termination option</legend><div className="row3">{F.num('terms.termination.month', 'Can terminate after month', { fin: true })}{F.num('terms.termination.penalty', 'Termination penalty', { fin: true })}{F.chk('terms.termination.certain', 'Lessee is reasonably certain to terminate', { fin: true })}</div></fieldset>
                        <fieldset><legend>Purchase option and residual value</legend><div className="row3">{F.num('terms.purchase.price', 'Purchase option price', { fin: true })}{F.chk('terms.purchase.certain', 'Reasonably certain to purchase', { fin: true, hint: 'Included in the liability and depreciation runs over useful life (16.27(d), 16.32).' })}{F.num('terms.rvg', 'Residual value guarantee: amount expected to be payable', { fin: true, hint: 'Only the expected shortfall, not the full guarantee (16.27(c)).' })}</div></fieldset>
                        {F.sel('terms.exemption', 'Recognition exemption', [['none', 'None: recognise a right-of-use asset and lease liability'], ['short-term', 'Short-term lease (12 months or less, no purchase option)'], ['low-value', 'Low-value asset (value when new, e.g. below USD 5,000)']], { fin: true, hint: 'Short-term is an election by class of asset (16.8); low-value is lease by lease (16.8, B3-B8).' })}
                    </div>
                    <div {...pane('p')}>
                        <div className="row4">{F.num('terms.payment', 'Payment amount', { req: true, fin: true })}{F.sel('terms.freqM', 'Frequency', [[1, 'Monthly'], [3, 'Quarterly'], [6, 'Half-yearly'], [12, 'Annually']], { fin: true })}{F.sel('terms.timing', 'Timing', [['advance', 'In advance (start of period)'], ['arrears', 'In arrears (end of period)']], { fin: true })}{F.num('terms.rentFreeMonths', 'Rent-free months at start', { fin: true, min: 0 })}</div>
                        <fieldset><legend>Escalation</legend><div className="row3">{F.sel('terms.escalation.type', 'Type', [['none', 'None'], ['fixed', 'Fixed percentage (included now)'], ['index', 'Linked to an index such as CPI (remeasured when it changes)']], { fin: true })}{F.num('terms.escalation.rate', 'Increase %', { fin: true })}{F.num('terms.escalation.everyM', 'Every (months)', { fin: true })}</div>
                            <div className="row3">{F.num('terms.escalation.indexBase', 'Index at commencement', { fin: true, hint: 'For index-linked leases. Payments stay at today’s level until the index changes (16.28).' })}</div></fieldset>
                        <fieldset><legend>Non-lease components and variable payments</legend><div className="row3">{F.num('terms.serviceComponent', 'Service element in each payment (maintenance, security, utilities)', { fin: true })}{F.chk('terms.combine', 'Combine with the lease (practical expedient)', { fin: true, hint: 'Election by class of asset (16.15). If not combined, the service element is expensed.' })}{F.text('terms.variableNote', 'Variable payments not in the liability', { ph: 'e.g. 1% of sales from the site', hint: 'Expensed as incurred (16.38(b)). Record them under Payments.' })}</div></fieldset>
                    </div>
                    <div {...pane('m')}>
                        <div className="row3">{F.num('terms.discountRate', 'Discount rate % a year', { fin: true, hint: 'Rate implicit in the lease if readily determinable, otherwise the incremental borrowing rate (16.26).' })}{F.sel('terms.rateBasis', 'Rate source', [['IBR', 'Incremental borrowing rate'], ['implicit', 'Rate implicit in the lease (entered)'], ['solve', 'Solve implicit rate from fair value']], { fin: true })}{F.num('terms.fairValue', 'Fair value of the asset (to solve implicit rate)', { fin: true })}</div>
                        <div className="row3">{F.num('terms.lessorIDC', 'Lessor’s initial direct costs (for implicit rate)', { fin: true })}{F.num('terms.urv', 'Unguaranteed residual value (lessor)', { fin: true })}<div></div></div>
                        <fieldset><legend>Right-of-use asset build-up (16.24)</legend><div className="row3">{F.num('terms.prepaid', 'Payments made before commencement', { fin: true })}{F.num('terms.idc', 'Initial direct costs (commission, legal, stamp duty)', { fin: true, hint: 'Incremental costs only; internal salaries are excluded.' })}{F.num('terms.incentives', 'Lease incentives received', { fin: true })}</div>
                            <div className="row3">{F.num('terms.restoration', 'Restoration / dismantling provision (present value)', { fin: true, hint: 'IAS 37 provision added to the asset (16.24(d)).' })}{F.num('terms.deposit', 'Refundable security deposit', { fin: true, hint: 'Measured at fair value under IFRS 9; the excess is prepaid rent added to the asset.' })}<div></div></div></fieldset>
                    </div>
                    <div {...pane('a')}>
                        <div className="row3">{F.sel('assetClass', 'Asset class', Object.entries(ASSET_CLASSES), { fin: true })}{F.text('location', 'Location')}<div className="row2">{F.num('area', 'Area')}{F.sel('areaUnit', 'Unit', [['sq ft', 'sq ft'], ['sq m', 'sq m'], ['sq yd', 'sq yd'], ['marla', 'marla'], ['kanal', 'kanal'], ['acre', 'acre'], ['units', 'units']])}</div></div>
                        <div className="row3">{F.num('terms.usefulLifeM', 'Useful life of the asset (months)', { fin: true, hint: 'Depreciation runs over the shorter of lease term and useful life, unless ownership transfers.' })}{F.chk('terms.ownershipTransfer', 'Ownership transfers at the end of the lease', { fin: true })}<div></div></div>
                    </div>
                    <div {...pane('r')}>
                        <p className="note" style={{ marginBottom: '12px' }}>Used when the role is lessor. A lessor classifies each lease as finance or operating (16.61-66).</p>
                        <div className="row3">{F.sel('terms.classification', 'Classification', [['auto', 'Decide from the indicators'], ['finance', 'Finance lease'], ['operating', 'Operating lease']], { fin: true })}{F.num('terms.carryingAmount', 'Carrying amount of the asset', { fin: true })}{F.num('terms.underlyingRemainingLifeM', 'Remaining life of the asset (months, operating)', { fin: true })}</div>
                        <div className="row3">{F.chk('terms.dealer', 'We are the manufacturer or dealer', { fin: true, hint: 'Selling profit recognised at commencement; costs to obtain the lease are expensed (16.71-74).' })}{F.num('terms.marketRate', 'Market rate of interest (dealer)', { fin: true })}{F.chk('terms.specialised', 'Asset is specialised to the lessee', { fin: true })}</div>
                    </div>
                    <div {...pane('x')}>
                        <div className="row3">{F.num('terms.gracePeriodDays', 'Grace period (days)', { min: 0 })}{F.sel('terms.lateType', 'Late payment charge', [['none', 'None'], ['interest', 'Interest'], ['fine', 'Fine'], ['both', 'Interest and fine']])}{F.sel('terms.partialRule', 'Partial payments applied to', [['interest-first', 'Late charges first'], ['principal-first', 'Rent first'], ['proportional', 'Proportionally']])}</div>
                        <div className="row3">{F.num('terms.lateRate', 'Late interest % a month')}{F.num('terms.fineRate', 'Fine % of overdue amount')}<div></div></div>
                        <p className="note">Late charges are not lease payments; they are expensed when incurred.</p>
                    </div>
                    <div className="form-actions">
                        <button type="button" className="btn btn-ghost" id="f-cancel" onClick={() => editing ? goBack() : go('register', {}, { reset: true })}>Cancel</button>
                        {!editing || base.status === 'draft' || base.status === 'rejected' ? <button type="button" className="btn btn-ghost" id="f-draft" {...gate('lease.edit')} onClick={() => save('draft')}>Save as draft</button> : null}
                        <button type="submit" className="btn" id="f-save" {...gate('lease.edit')}>{editing && isLive(base) ? 'Save details' : SETTINGS.requireApproval ? 'Submit for approval' : 'Save and activate'}</button>
                    </div>
                </form>
            </div>
            <aside className="measure card"><div className="section-head"><h3>Measurement</h3><span className="note" id="m-ccy">{live.currency}</span></div><div className="pad" id="m-body"><MeasurementPanel lease={live} /></div></aside>
        </div>
    );
}
