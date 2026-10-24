import { useMemo, useState, type ReactNode } from 'react';
import { EVENT_TYPES, addDays, addMonths, leaseTerm, monthsBetween, num as N } from '../../domain/engine';
import { getResult } from '../../domain/lease';
import { SETTINGS } from '../../domain/settings';
import { Store } from '../../domain/store';
import { AS_OF } from '../../domain/state';
import { gate, guard, lockGuard, logHistory } from '../../domain/enterprise';
import { aiErr, getSample, leaseContext } from '../../domain/ai';
import { getTrail, go } from '../../domain/nav';
import { useAppState } from '../../hooks/useAppState';
import { Modal, toast } from '../../utils/uiStore';
import { deepClone, pct, uid } from '../../utils/format';
import { fmtDate } from '../../utils/dates';
import { EventImpact } from './EventImpact';
import { nextLeaseId } from '../../domain/lease';
import type { EngineResult } from '../../types/engine';
import type { EventType, Lease, LeaseEvent } from '../../types/lease';

/** Values the AI can suggest for a change; they prefill the wizard. */
export interface EventPrefill {
    effective?: string | null;
    newRate?: number | null;
    newPayment?: number | null;
    escPct?: number | null;
    newEndDate?: string | null;
    extPayment?: number | null;
    areaRetainedPct?: number | null;
    penalty?: number | null;
    amount?: number | null;
    reason?: string | null;
}

const EVENT_HELP: Record<EventType, string> = {
    'reassess-index': 'Payments reset because an index or rate (such as CPI) changed. Remeasure the remaining payments at the unchanged discount rate and adjust the right-of-use asset.',
    'reassess-floating': 'Payments vary with a floating interest rate (for example KIBOR-linked rent). Remeasure at a revised rate reflecting the change.',
    'reassess-rvg': 'The amount you expect to pay under a residual value guarantee has changed. Remeasure at the unchanged rate.',
    'reassess-term': 'A significant event within your control changed whether an extension or termination option is reasonably certain. Remeasure at a revised rate at the reassessment date.',
    'reassess-purchase': 'Your assessment of a purchase option changed. Remeasure at a revised rate; if now reasonably certain, depreciate over useful life.',
    'mod-change': 'The contract was changed: new rent, longer term, or extra scope not priced at stand-alone price. Remeasure at a revised rate at the effective date and adjust the asset.',
    'mod-decrease': 'The contract was changed to reduce scope: less space or a shorter term. Derecognise part of the asset and liability with a gain or loss, then remeasure the rest at a revised rate.',
    'mod-separate': 'Extra right of use priced at its stand-alone price. Account for it as a new lease from its commencement; the original lease is unchanged.',
    'terminate': 'The lease ends early. Derecognise the asset and liability; the difference and any penalty go to profit or loss.',
    'impair': 'The right-of-use asset is impaired under IAS 36 (for example a site closed or sublet at a loss). Depreciation is recalculated on the reduced amount.',
};

/** The wizard's inputs by id (the original read them from the DOM). */
type FieldId = 'ev-eff' | 'ev-rate' | 'ev-pay' | 'ev-esc' | 'ev-every' | 'ev-end' | 'ev-ext' | 'ev-area' | 'ev-pen' | 'ev-asset' | 'ev-amt' | 'ev-pp' | 'ev-rvg' | 'ev-reason';
type Values = Partial<Record<FieldId, string>>;

/** What the AI returns when asked to classify a change. */
interface AiEvent extends EventPrefill { type?: string; why?: string; missing?: string[] }

function ExemptNotice({ exemption }: { exemption: string }) {
    return <><p>This lease uses the {exemption} exemption, so there is no asset or liability to remeasure. Edit the payments directly, or if a modification makes the term longer than 12 months, treat it as a new lease from the modification date (16.7).</p><div className="form-actions"><button className="btn" onClick={() => Modal.close()}>Close</button></div></>;
}

function EventWizardForm({ lease, res, types, presetType, prefill }: { lease: Lease; res: EngineResult | null; types: EventType[]; presetType?: string; prefill?: EventPrefill }) {
    const version = useAppState();
    const lr = lease.role === 'lessor';
    const T = lease.terms, curEnd = res ? res.termMonths : leaseTerm(T);
    const curRate = res && 'annualRate' in res.initial && res.initial.annualRate != null ? res.initial.annualRate : N(T.discountRate);
    const nextMonth = addMonths(AS_OF.slice(0, 8) + T.commencement.slice(8), AS_OF.slice(8) > T.commencement.slice(8) ? 1 : 0);
    const day = Number(T.commencement.slice(8));

    /** Inputs shown for a type (the original drew only these into #ev-fields). */
    const present = (t: EventType): Set<FieldId> => {
        const s = new Set<FieldId>(['ev-eff', 'ev-reason']);
        if (t === 'mod-separate') return s;
        if (t === 'terminate') { s.add('ev-pen'); if (lr && res && res.mode === 'lessor-finance') s.add('ev-asset'); return s; }
        if (t === 'impair') { s.add('ev-amt'); return s; }
        (['ev-rate', 'ev-pay', 'ev-esc', 'ev-every'] as FieldId[]).forEach(x => s.add(x));
        if (!['reassess-index', 'reassess-floating', 'reassess-rvg'].includes(t)) { s.add('ev-end'); s.add('ev-ext'); if (t === 'mod-decrease') s.add('ev-area'); }
        if (t === 'reassess-purchase') s.add('ev-pp');
        if (t === 'reassess-rvg') s.add('ev-rvg');
        return s;
    };
    /** Initial values of a freshly drawn set of fields. */
    const defaults = (t: EventType): Values => ({
        'ev-eff': nextMonth, 'ev-rate': EVENT_TYPES[t].rate === 'revised' ? '' : String(curRate), 'ev-pay': '', 'ev-esc': '', 'ev-every': '12',
        'ev-end': addDays(addMonths(T.commencement, curEnd), -1), 'ev-ext': '', 'ev-area': '100', 'ev-pen': '', 'ev-asset': '', 'ev-amt': '',
        'ev-pp': String(N(T.purchase.price) || ''), 'ev-rvg': String(N(T.rvg) || ''), 'ev-reason': '',
    });
    /** Set suggested values on the inputs that are shown (the original's set(id, v)). */
    const applyValues = (t: EventType, vals: Values, ev: AiEvent | EventPrefill): Values => {
        const out = { ...vals }, shown = present(t);
        const set = (id: FieldId, v: string | number | null | undefined) => { if (shown.has(id) && v !== undefined && v !== null) out[id] = String(v); };
        set('ev-eff', ev.effective); set('ev-rate', ev.newRate); set('ev-pay', ev.newPayment); set('ev-esc', ev.escPct); set('ev-ext', ev.extPayment); set('ev-area', ev.areaRetainedPct); set('ev-pen', ev.penalty); set('ev-amt', ev.amount); set('ev-reason', ev.reason);
        if (ev.newEndDate) set('ev-end', ev.newEndDate);
        return out;
    };

    const [type, setType] = useState<EventType>(() => (presetType && (types as string[]).includes(presetType) ? presetType as EventType : types[0]));
    const [vals, setVals] = useState<Values>(() => prefill ? applyValues(type, defaults(type), prefill) : defaults(type));
    const [pc, setPc] = useState(!T.purchase.certain);
    const [aiText, setAiText] = useState('');
    const [aiOut, setAiOut] = useState<ReactNode>(null);
    const info = EVENT_TYPES[type];
    const shown = present(type);

    const readEvent = (): LeaseEvent => {
        const v = (id: FieldId) => shown.has(id) ? (vals[id] ?? '') : undefined;
        const ev: LeaseEvent = { id: uid('ev'), type, effective: v('ev-eff') || '', status: 'pending', reason: (v('ev-reason') || '').trim() };
        const opt = (k: 'newRate' | 'newPayment' | 'escPct' | 'escEveryM' | 'extPayment' | 'areaRetainedPct' | 'penalty' | 'assetValue' | 'amount' | 'purchasePrice' | 'rvg', id: FieldId) => { const x = v(id); if (x !== undefined && x !== '') ev[k] = Number(x); };
        opt('newRate', 'ev-rate'); opt('newPayment', 'ev-pay'); opt('escPct', 'ev-esc'); opt('escEveryM', 'ev-every'); opt('extPayment', 'ev-ext'); opt('areaRetainedPct', 'ev-area');
        opt('penalty', 'ev-pen'); opt('assetValue', 'ev-asset'); opt('amount', 'ev-amt'); opt('purchasePrice', 'ev-pp'); opt('rvg', 'ev-rvg');
        if (type === 'reassess-purchase') ev.purchaseCertain = pc;
        if (EVENT_TYPES[type].rate === 'unchanged') delete ev.newRate;
        const end = v('ev-end');
        if (end) ev.newEndMonth = monthsBetween(T.commencement, addDays(end, 1));
        return ev;
    };

    const preview = useMemo(() => {
        const ev = readEvent();
        if (ev.type === 'mod-separate') return null;
        if (!ev.effective || ev.effective <= T.commencement) return <p className="note">Choose an effective date after commencement.</p>;
        if (EVENT_TYPES[ev.type].rate === 'revised' && ev.newRate == null) return <p className="note">Enter the revised discount rate to see the impact.</p>;
        return <EventImpact lease={lease} event={ev} />;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [type, vals, pc, version]);

    const changeType = (t: EventType) => { setType(t); setVals(defaults(t)); setPc(!T.purchase.certain); };
    const field = (id: FieldId) => ({ id, value: vals[id] ?? '', onChange: (e: { target: { value: string } }) => setVals(s => ({ ...s, [id]: e.target.value })) });

    const ask = async () => {
        if (!aiText.trim()) { setAiOut('Describe what changed first.'); return; }
        const sample = await getSample();
        if (!sample) { setAiOut('AI is not available in this view.'); return; }
        setAiOut(<><span className="spinner"></span> Working out the treatment…</>);
        const ctx = leaseContext(lease, res);
        const prompt = `You are an IFRS 16 technical accountant. Classify a change to an existing lease and give the parameters to measure it.
Event types: ${Object.entries(EVENT_TYPES).map(([k, v]) => `${k} = ${v.label} (IFRS ${v.ref}; discount rate ${v.rate})`).join('; ')}.
Rules: a change in scope or consideration not in the original terms is a modification (16.44-46). It is a separate lease only if it adds a right to use an additional asset AND the price increase is commensurate with its stand-alone price. A decrease in scope (less space or shorter term) is mod-decrease. A change within the original contract (option reassessment, index reset, RVG change) is a reassessment, not a modification. Lessee-controlled significant events trigger option reassessment (16.20).
Today is ${AS_OF}. The lease:
${JSON.stringify(ctx)}
The change: "${aiText}"
Reply with only JSON: {"type": one of the event types, "effective": "YYYY-MM-DD", "newRate": number or null (needed when the rate is revised; if unknown, propose the lease's current rate and say so in why), "newPayment": number or null, "escPct": number or null, "newEndDate": "YYYY-MM-DD" or null, "extPayment": number or null, "areaRetainedPct": number or null, "penalty": number or null, "amount": number or null, "reason": "one sentence for the audit trail", "why": "two or three sentences explaining the classification with IFRS 16 paragraph references", "missing": ["facts you need to confirm"]}`;
        try {
            const ev = (await sample.json(prompt, { modelTier: 'default' })) as AiEvent;
            const known = ev.type !== undefined && (EVENT_TYPES as Record<string, { label: string }>)[ev.type];
            setAiOut(<div className="banner" style={{ margin: '6px 0 0' }}><div><strong>{(known && known.label) || ev.type}</strong><p>{ev.why || ''}</p>{ev.missing && ev.missing.length ? <p className="note">Confirm: {ev.missing.join('; ')}</p> : null}</div></div>);
            // A known type redraws the fields (fresh defaults), then the suggested values are set on them.
            if (ev.type && (types as string[]).includes(ev.type)) {
                const t = ev.type as EventType;
                setType(t); setPc(!T.purchase.certain); setVals(applyValues(t, defaults(t), ev));
            } else setVals(applyValues(type, vals, ev));
        } catch (e) { setAiOut(aiErr(e)); }
    };

    const submit = async () => {
        const ev = readEvent();
        if (!ev.effective) return toast('Enter the effective date.');
        if (ev.type !== 'mod-separate' && ev.effective <= T.commencement) return toast('The effective date must be after commencement.');
        if (EVENT_TYPES[ev.type].rate === 'revised' && ev.newRate == null) return toast('Enter the revised discount rate.');
        if (!ev.reason) { document.getElementById('ev-reason')?.focus(); return toast('Record the reason and evidence for the audit trail.'); }
        if (!lockGuard(ev.effective, 'Lease change')) return;
        if (ev.type === 'mod-separate') {
            Modal.close();
            const nl = deepClone(lease); nl.id = nextLeaseId(lease.role); nl.name = lease.name + ' (additional)'; nl.status = 'draft'; nl.events = []; nl.payments = []; nl.history = []; nl.documents = [];
            nl.terms.commencement = ev.effective; nl.parentId = lease.id; nl._source = `a separate-lease modification of ${lease.id}`;
            const l2 = deepClone(lease); l2.events.push(Object.assign(ev, { status: 'approved' as const, submittedBy: Store.actorId(), submittedByName: Store.actorName(), submittedOn: AS_OF })); logHistory(l2, `Separate lease ${nl.id} opened for additional right of use: ${ev.reason}`); if (!await Store.save(l2)) return;
            return go('entry', { mode: 'new', prefill: nl }, { reset: true });
        }
        const l2 = deepClone(lease);
        Object.assign(ev, { submittedBy: Store.actorId(), submittedByName: Store.actorName(), submittedOn: AS_OF, status: SETTINGS.requireApproval ? 'pending' : 'approved' });
        l2.events.push(ev);
        logHistory(l2, `${EVENT_TYPES[ev.type].label} ${SETTINGS.requireApproval ? 'submitted for approval' : 'applied'}, effective ${fmtDate(ev.effective)}: ${ev.reason}`);
        if (!await Store.save(l2)) return;
        Modal.close(); toast(SETTINGS.requireApproval ? 'Submitted for approval' : 'Change applied');
        const trail = getTrail();
        go('detail', { id: lease.id, tab: 'events' }, { replace: !!(trail.length && trail[trail.length - 1].screen === 'detail') });
    };

    const revised = info.rate === 'revised';
    let rest: ReactNode;
    if (type === 'mod-separate') rest = <><div className="fg" style={{ gridColumn: 'span 2' }}><p className="note">A new lease record will be opened, prefilled from this one, for the additional asset. The original lease stays as it is (16.44).</p></div></>;
    else if (type === 'terminate') rest = <><div className="fg"><label htmlFor="ev-pen">{lr ? 'Termination fee received' : 'Termination penalty paid'}</label><input type="number" step="any" {...field('ev-pen')} /></div>{lr && res && res.mode === 'lessor-finance' ? <div className="fg"><label htmlFor="ev-asset">Value of asset returned</label><input type="number" step="any" {...field('ev-asset')} /></div> : <div></div>}</>;
    else if (type === 'impair') rest = <><div className="fg"><label htmlFor="ev-amt">Impairment loss</label><input type="number" step="any" {...field('ev-amt')} /></div><div></div></>;
    else rest = <><div className="fg"><label htmlFor="ev-rate">Discount rate % {revised ? <>(revised) <span className="req">*</span></> : '(unchanged)'}</label><input type="number" step="any" {...field('ev-rate')} readOnly={!revised} placeholder={`Current ${pct(curRate)}`} /><div className="hint">{revised ? 'Rate at the effective date for the remaining term.' : 'IFRS 16 keeps the original rate for this change.'}</div></div><div></div></>;
    const standard = !['mod-separate', 'terminate', 'impair'].includes(type);

    return (
        <>
            <div className="fg"><label htmlFor="ev-type">What changed?</label><select id="ev-type" value={type} onChange={e => changeType(e.target.value as EventType)}>{types.map(k => <option key={k} value={k}>{EVENT_TYPES[k].label}</option>)}</select><div className="hint" id="ev-help">{EVENT_HELP[type]}{' '}<span className="ref">{`IFRS ${info.ref}`}</span></div></div>
            <div className="fg"><label htmlFor="ev-ai">Not sure which applies? Describe the change</label><div className="btn-row"><input id="ev-ai" placeholder="e.g. Landlord agreed to cut rent by 10% from next month if we stay 2 more years" style={{ flex: 1 }} value={aiText} onChange={e => setAiText(e.target.value)} /><button className="btn btn-ghost" id="ev-ask" {...gate('ai.use')} onClick={ask}>Suggest treatment</button></div><div id="ev-ai-out" className="note" style={{ marginTop: '6px' }}>{aiOut}</div></div>
            <div id="ev-fields">
                <div className="row3"><div className="fg"><label htmlFor="ev-eff">Effective date <span className="req">*</span></label><input type="date" {...field('ev-eff')} /><div className="hint">{`Changes take effect on a lease month boundary (the ${day}${['st', 'nd', 'rd'][day - 1] || 'th'} of the month).`}</div></div>{rest}</div>
                {standard && <div className="row3"><div className="fg"><label htmlFor="ev-pay">New payment from effective date</label><input type="number" step="any" placeholder="Unchanged" {...field('ev-pay')} /></div><div className="fg"><label htmlFor="ev-esc">New escalation %</label><input type="number" step="any" placeholder="None" {...field('ev-esc')} /></div><div className="fg"><label htmlFor="ev-every">Every (months)</label><input type="number" {...field('ev-every')} /></div></div>}
                {standard && shown.has('ev-end') && <div className="row3"><div className="fg"><label htmlFor="ev-end">New end date of the lease term</label><input type="date" {...field('ev-end')} /><div className="hint">Currently {curEnd} months from commencement.</div></div><div className="fg"><label htmlFor="ev-ext">Payment for any added period</label><input type="number" step="any" placeholder="Same as new payment" {...field('ev-ext')} /></div>{type === 'mod-decrease' ? <div className="fg"><label htmlFor="ev-area">Space or units retained %</label><input type="number" step="any" {...field('ev-area')} /><div className="hint">50 if half the floor is handed back.</div></div> : <div></div>}</div>}
                {type === 'reassess-purchase' && <div className="row3"><div className="fg"><label htmlFor="ev-pp">Purchase price</label><input type="number" step="any" {...field('ev-pp')} /></div><div className="fg"><label className="check" style={{ marginTop: '24px' }}><input type="checkbox" id="ev-pc" checked={pc} onChange={e => setPc(e.target.checked)} /> Now reasonably certain to purchase</label></div><div></div></div>}
                {type === 'reassess-rvg' && <div className="row3"><div className="fg"><label htmlFor="ev-rvg">Amount now expected to be payable</label><input type="number" step="any" {...field('ev-rvg')} /></div><div></div><div></div></div>}
                <div className="fg"><label htmlFor="ev-reason">Reason and evidence <span className="req">*</span></label><textarea rows={2} placeholder="e.g. Addendum signed 12 Oct; board approved relocation" {...field('ev-reason')} /></div>
            </div>
            <div id="ev-preview">{preview}</div>
            <div className="form-actions"><button className="btn btn-ghost" id="ev-cancel" onClick={() => Modal.close()}>Cancel</button><button className="btn" id="ev-submit" onClick={submit}>{SETTINGS.requireApproval ? 'Submit for approval' : 'Apply change'}</button></div>
        </>
    );
}

/** Open the remeasurement / modification wizard for a lease (needs lease.change). */
export function openEventWizard(lease: Lease | undefined, presetType?: EventType | string, prefill?: EventPrefill): void {
    if (!guard('lease.change')) return;
    if (!lease) return;
    const lr = lease.role === 'lessor', res = getResult(lease);
    if (res && res.mode === 'exempt') {
        Modal.open('Change an exempt lease', <ExemptNotice exemption={res.exemption} />);
        return;
    }
    const types: EventType[] = lr ? ['mod-change', 'mod-separate', 'terminate'] : Object.keys(EVENT_TYPES) as EventType[];
    Modal.open(`Remeasure or modify ${lease.id}`, <EventWizardForm lease={lease} res={res} types={types} presetType={presetType} prefill={prefill} />, { wide: true });
}
