import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { ScreenProps } from './registry';
import { go } from '../domain/nav';
import { SETTINGS, engineSettings } from '../domain/settings';
import { AS_OF } from '../domain/state';
import { Store } from '../domain/store';
import { blankLease, blankTerms, getResult, leaseEnd, measurementType, statusOf } from '../domain/lease';
import { EVENT_TYPES, addDays, balanceAt, monthlyRate, monthsBetween, pvAt, run } from '../domain/engine';
import { journalsFor } from '../domain/journals';
import { BANDS_STANDARD, currentSplit, maturityTable } from '../domain/reporting';
import { kbSearch } from '../domain/guidance';
import { aiErr, getSample, leaseContext } from '../domain/ai';
import { openEventWizard, type EventPrefill } from '../components/lease/EventWizard';
import { nextLeaseId } from '../domain/lease';
import { toast } from '../utils/uiStore';
import { deepClone, errMessage } from '../utils/format';
import { fmtDate } from '../utils/dates';
import { esc, md } from '../utils/html';
import type { EventTypeInfo } from '../types/engine';
import type { Lease, LeaseEvent, LeaseTerms } from '../types/lease';

/* ======================================================================
   AI advisor (chat with tools that call the engine). The conversation is
   kept in module state for the current context (lease, contract or portfolio).
   ====================================================================== */
interface Turn { role: 'user' | 'assistant'; content: string; display?: string }
interface Stream { html: string | null; trace: string }
const Advisor = {
    turns: [] as Turn[], busy: false, ctl: null as AbortController | null, key: undefined as string | undefined,
    /** The answer being streamed, shown below the turns; null when nothing is streaming. */
    stream: null as Stream | null,
    /** Counts redraws of the log (the original's draw()), which scroll it to the bottom. */
    drawn: 0,
};
const listeners = new Set<() => void>();
const changed = () => listeners.forEach(f => f());
const draw = () => { Advisor.drawn++; changed(); };

const ADVISOR_RULES = () => `You are the IFRS 16 advisor inside a lease accounting system used by ${SETTINGS.entity}, reporting in ${SETTINGS.functionalCurrency}, financial year ending month ${SETTINGS.fyEndMonth}. Today is ${AS_OF}.
How to answer:
- Give the accounting treatment under IFRS 16 (and IAS 37, IAS 36, IFRS 9, IAS 12, IAS 21 where relevant), citing paragraph numbers. Where IFRS 16 needs judgement, say what judgement and which facts would change the answer.
- Use the tools to get numbers. Never invent balances: call get_lease, preview_change or present_value. Show journal entries as a table with Account, Debit, Credit.
- Users are finance professionals in Pakistan (ICAP, SECP, KIBOR-based borrowing rates, Income Tax Ordinance 2001). Mention local practice only when it matters, e.g. deferred tax because tax deducts rentals as paid.
- Be concise and structured with short headings. No preamble.
- If the user should record a change to a lease, end with one fenced block labelled action containing JSON:
\`\`\`action
{"action":"create_event","leaseId":"...","event":{"type":"...","effective":"YYYY-MM-DD","newRate":...,"newPayment":...,"newEndDate":"YYYY-MM-DD","extPayment":...,"areaRetainedPct":...,"penalty":...,"amount":...,"reason":"..."}}
\`\`\`
or for a new lease {"action":"new_lease","lease":{"name":"...","role":"lessee|lessor","counterparty":"...","assetClass":"...","currency":"...","terms":{"commencement":"YYYY-MM-DD","termMonths":n,"payment":n,"freqM":1,"timing":"advance|arrears","discountRate":n,"escalation":{"type":"fixed","rate":n,"everyM":12}}}}.
Only propose an action when the user's facts are enough to measure it.`;

interface PreviewEvent { id: string; date: string; before?: object; after?: object; remeasured?: number; adjustment?: number; partial?: object }
type ToolDef = Omit<SampleTool, 'execute'> & { execute: (input: Record<string, unknown>) => unknown };

function advisorTools(): ToolDef[] {
    const brief = (l: Lease) => { const r = getResult(l), b = r ? balanceAt(r, AS_OF) : { L: 0, A: 0 }; return { id: l.id, name: l.name, role: l.role, class: l.assetClass, currency: l.currency, accounting: measurementType(l), status: statusOf(l, AS_OF), commencement: l.terms.commencement, end: leaseEnd(l), payment: l.terms.payment, frequencyMonths: l.terms.freqM, rate: l.terms.discountRate, liability: r && r.mode !== 'exempt' ? Math.round(b.L || 0) : null, rou: r && r.mode === 'lessee' ? Math.round(b.A || 0) : null }; };
    return [
        { name: 'list_leases', description: 'List all leases in the portfolio with balances at today.', inputSchema: { type: 'object', properties: {} }, execute: () => Store.leases.map(brief) },
        { name: 'get_lease', description: 'Full terms, events, initial measurement, balances today and the next 12 scheduled payments of one lease.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
            execute: ({ id }) => { const l = Store.get(String(id)); if (!l) throw new Error('No lease ' + id); const r = getResult(l); return Object.assign(leaseContext(l, r), { nextPayments: r ? r.cashflows.filter(f => f.date >= AS_OF).slice(0, 12).map(f => ({ date: f.date, amount: Math.round(f.amount), type: f.type })) : [] }); } },
        { name: 'preview_change', description: 'Measure a proposed remeasurement, modification, termination or impairment on a lease without saving it. Returns before/after liability and ROU asset, gain or loss, and the journal entry.',
            inputSchema: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string', enum: Object.keys(EVENT_TYPES) }, effective: { type: 'string' }, newRate: { type: 'number' }, newPayment: { type: 'number' }, escPct: { type: 'number' }, newEndDate: { type: 'string' }, extPayment: { type: 'number' }, areaRetainedPct: { type: 'number' }, penalty: { type: 'number' }, amount: { type: 'number' } }, required: ['id', 'type', 'effective'] },
            execute: (a) => {
                const l = Store.get(String(a.id)); if (!l) throw new Error('No lease ' + a.id);
                const ev: Record<string, unknown> = Object.assign({ id: 'preview', status: 'approved' }, a); delete ev.id; ev.id = 'preview';
                if (a.newEndDate) ev.newEndMonth = monthsBetween(l.terms.commencement, addDays(String(a.newEndDate), 1));
                const t = deepClone(l); t.status = 'active'; t.events = (t.events || []).concat([ev as unknown as LeaseEvent]);
                const r = run(t, engineSettings()); const e = (r.events as PreviewEvent[]).find(x => x.id === 'preview');
                if (!e) return { note: 'Effective date is outside the lease term or before commencement.' };
                const round = (o: object | undefined) => o && Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v) : v]));
                const j = journalsFor(t, e.date, e.date).filter(x => x.kind !== 'Monthly').map(x => ({ memo: x.memo, lines: x.lines.map(y => ({ account: y.account, debit: Math.round(y.dr), credit: Math.round(y.cr) })) }));
                return { currency: l.currency, effectiveMonthStart: e.date, before: round(e.before), after: round(e.after), remeasuredLiability: e.remeasured != null ? Math.round(e.remeasured) : null, adjustment: e.adjustment != null ? Math.round(e.adjustment) : null, partialDerecognition: round(e.partial), journal: j };
            } },
        { name: 'present_value', description: 'Present value of payments at an annual rate. payments: [{month: months from today (0 = now), amount}]. Uses the rate convention in settings.', inputSchema: { type: 'object', properties: { annualRate: { type: 'number' }, payments: { type: 'array', items: { type: 'object', properties: { month: { type: 'number' }, amount: { type: 'number' } } } } }, required: ['annualRate', 'payments'] },
            execute: ({ annualRate, payments }) => { const im = monthlyRate(annualRate as number, 1, 'effective'); return { presentValue: Math.round(pvAt((payments as { month: number; amount: number }[]).map(p => ({ t: p.month, amount: p.amount })), im, 0) * 100) / 100, convention: 'effective annual rate, monthly discounting' }; } },
        { name: 'portfolio_position', description: 'Totals at today: lease liabilities (current and non-current), ROU assets, maturity analysis, in functional currency.', inputSchema: { type: 'object', properties: {} },
            execute: () => { const s = currentSplit(AS_OF), m = maturityTable('lessee', AS_OF, BANDS_STANDARD); return { currency: SETTINGS.functionalCurrency, liabilities: Math.round(s.total), current: Math.round(s.current), nonCurrent: Math.round(s.nonCurrent), maturityUndiscounted: m.rows.map(r => ({ band: r.label, amount: Math.round(r.amount) })) }; } },
        { name: 'search_guidance', description: 'Search the built-in IFRS 16 guidance library. Returns the best matching topics with paragraph references.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
            execute: ({ query }) => kbSearch(String(query)).slice(0, 3).map(t => ({ title: t.title, refs: t.refs, text: t.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 2500) })) },
    ];
}

interface AiAction {
    action?: string; leaseId?: string;
    event?: EventPrefill & { type?: string };
    lease?: Partial<Omit<Lease, 'terms'>> & { terms?: Partial<LeaseTerms> };
}
const eventLabelOf = (type: string | undefined) => ((EVENT_TYPES as Record<string, EventTypeInfo | undefined>)[type as string] || { label: '' }).label || '';

function renderAnswer(text: string): string {
    const m = String(text).match(/```action\s*([\s\S]*?)```/);
    let html = md(String(text).replace(/```action[\s\S]*?(```|$)/, ''));
    if (m) {
        try {
            const a = JSON.parse(m[1]) as AiAction;
            const label = a.action === 'create_event' ? `Open this change for ${esc(a.leaseId)} in the wizard` : a.action === 'new_lease' ? 'Open this lease in the form' : '';
            if (label) html += `<div class="banner ok"><div><strong>Suggested next step</strong><p>${a.action === 'create_event' ? esc(eventLabelOf(a.event && a.event.type)) + (a.event && a.event.effective ? ', effective ' + fmtDate(a.event.effective) : '') : esc((a.lease && a.lease.name) || '')}. You review the figures before anything is saved.</p></div><div class="banner-actions"><button class="btn btn-sm" data-ai-action='${esc(JSON.stringify(a))}'>${label}</button></div></div>`;
        } catch { /* incomplete while streaming */ }
    }
    return html;
}
function runAction(a: AiAction) {
    if (a.action === 'create_event') {
        const l = Store.get(String(a.leaseId)); if (!l) return toast('Lease ' + a.leaseId + ' not found.');
        const e = a.event || {};
        openEventWizard(l, e.type, e);
    } else if (a.action === 'new_lease') {
        const l = blankLease(); Object.assign(l, a.lease, { terms: Object.assign(blankTerms(), (a.lease || {}).terms || {}) });
        l.terms.escalation = Object.assign({ type: 'none' as const, rate: '' as const, everyM: 12 }, l.terms.escalation || {});
        l.id = nextLeaseId(l.role); l._source = 'the AI advisor';
        go('entry', { mode: 'new', prefill: l }, { reset: true });
    }
}

export function AiAdvisorPage({ params: p }: ScreenProps<'ai'>) {
    const [, setTick] = useState(0);
    useEffect(() => { const f = () => setTick(t => t + 1); listeners.add(f); return () => { listeners.delete(f); }; }, []);
    const logRef = useRef<HTMLDivElement>(null);
    const inRef = useRef<HTMLTextAreaElement>(null);
    const bubbleRef = useRef<HTMLDivElement>(null);

    const lease = p.leaseId ? Store.get(p.leaseId) : null;
    const chips = lease ? [
        `Explain how ${lease.id} is measured and check the inputs for anything unusual.`,
        `The landlord of ${lease.id} offers 15% lower rent from next month if we extend by 3 years. How do we account for it?`,
        `We plan to hand back half of the space in ${lease.id}. What is the gain or loss?`,
        `Draft the IFRS 16.59 qualitative disclosure for ${lease.id}.`,
    ] : p.contract ? [
        'Summarise the IFRS 16 judgements in this contract.', 'Is there a lease under IFRS 16.B9? Walk through the tests.', 'What is the lease term, considering the lock-in, renewal and termination clauses?', 'Which payments go into the lease liability and which are expensed?',
    ] : [
        'Our 5-year warehouse lease rent is linked to KIBOR. How do we measure it and what happens when KIBOR changes?',
        'We sold our head office for PKR 900m and leased it back for 10 years. Walk through the accounting.',
        'A distributor gives retailers chillers for free if they buy our products. Is that a lease?',
        'Draft the qualitative lease disclosures for our annual report from the portfolio.',
        'How does deferred tax work on leases under the Income Tax Ordinance, given the 2021 IAS 12 amendment?',
        'Which leases end in the next 12 months and what decisions are needed?',
    ];
    const ctxKey = lease ? 'lease:' + lease.id : p.contract ? 'doc:' + p.contract.name : 'portfolio';
    if (Advisor.key !== ctxKey) { Advisor.turns = []; Advisor.key = ctxKey; }

    const send = async () => {
        const inEl = inRef.current;
        const q = (inEl ? inEl.value : '').trim(); if (!q || Advisor.busy) return;
        const sample = await getSample();
        if (!sample) { toast('AI is not available in this view.'); return; }
        if (inEl) inEl.value = '';
        let content = q;
        if (!Advisor.turns.length && lease) content = `Context: lease ${lease.id}.\n${JSON.stringify(leaseContext(lease, getResult(lease)))}\n\nQuestion: ${q}`;
        if (!Advisor.turns.length && p.contract) content = `Contract "${p.contract.name}":\n"""\n${p.contract.text}\n"""\n\nQuestion: ${q}`;
        Advisor.turns.push({ role: 'user', content, display: q });
        const st: Stream = { html: null, trace: '' };
        Advisor.stream = st;
        Advisor.busy = true; Advisor.ctl = new AbortController();
        draw();
        const tools: SampleTool[] = advisorTools().map(t => Object.assign({}, t, { execute: async (input: Record<string, unknown>) => { st.trace = `Using ${t.name.replace(/_/g, ' ')}…`; changed(); try { return await t.execute(input || {}); } catch (e) { return { error: errMessage(e) }; } } }));
        try {
            const msgs: SampleMessage[] = ([{ role: 'user', content: ADVISOR_RULES() }] as SampleMessage[]).concat(Advisor.turns.slice(-12).map(t => ({ role: t.role, content: t.content })));
            const r = await sample(msgs, { tools, cache: false, signal: Advisor.ctl.signal, modelTier: 'complex', onText: ({ text }) => { st.html = renderAnswer(text); st.trace = ''; changed(); } });
            Advisor.turns.push({ role: 'assistant', content: r.text });
        } catch (e) {
            const partial = e && typeof e === 'object' && 'text' in e ? (e as { text?: string }).text : undefined;
            if (partial) Advisor.turns.push({ role: 'assistant', content: partial + `\n\n_${aiErr(e)}_` });
            else Advisor.turns.push({ role: 'assistant', content: `_${aiErr(e)}_` });
        } finally {
            Advisor.busy = false; if (Advisor.stream === st) Advisor.stream = null; draw();
        }
    };
    const sendRef = useRef(send);
    sendRef.current = send;

    // The "Explain this calculation" link opens the advisor with a question that is sent once.
    useEffect(() => {
        if (p.ask && !Advisor.busy) { const a = p.ask; p.ask = null; if (inRef.current) inRef.current.value = a; setTimeout(() => sendRef.current(), 50); }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const drawn = Advisor.drawn, streamHtml = Advisor.stream ? Advisor.stream.html : null;
    useLayoutEffect(() => { const log = logRef.current; if (log) log.scrollTop = log.scrollHeight; }, [drawn, streamHtml]);

    const onLogClick = (e: MouseEvent<HTMLDivElement>) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ai-action]');
        if (!b || (bubbleRef.current && bubbleRef.current.contains(b))) return; // not wired while streaming, as in the original
        runAction(JSON.parse(b.dataset.aiAction || '{}') as AiAction);
    };
    const stream = Advisor.stream;

    return (
        <div className="card chat">
            <div className="section-head"><div><h3>{lease ? `Advisor: ${lease.id} ${lease.name}` : p.contract ? `Advisor: ${p.contract.name}` : 'Advisor'}</h3><p className="note">Answers use your live portfolio through the calculation engine. Suggested changes open in the change wizard and go through approval; nothing is posted by the AI. Every AI request is recorded in the audit log.</p></div><button className="btn btn-ghost btn-sm" id="ai-clear" onClick={() => { Advisor.turns = []; Advisor.stream = null; draw(); }}>New conversation</button></div>
            <div className="chat-log" id="ai-log" ref={logRef} onClick={onLogClick}>
                {Advisor.turns.length ? Advisor.turns.map((t, i) => t.role === 'user'
                    ? <div className="msg user" key={i}>{t.display || t.content}</div>
                    : <div className="msg ai" key={i} dangerouslySetInnerHTML={{ __html: renderAnswer(t.content) }} />)
                    : <div className="msg ai"><p>Ask about any lease situation. For example:</p><div className="suggest" style={{ marginTop: '8px' }}>{chips.map(c => <button className="chip" data-chip="" key={c} onClick={() => { if (inRef.current) inRef.current.value = c; send(); }}>{c}</button>)}</div></div>}
                {stream && <>
                    <div className="msg ai" ref={bubbleRef} dangerouslySetInnerHTML={{ __html: stream.html ?? '<span class="spinner"></span> Thinking…' }} />
                    <div className="tool-trace">{stream.trace}</div>
                </>}
            </div>
            <div className="chat-input"><textarea id="ai-in" rows={2} placeholder="Describe a situation or ask a question" ref={inRef} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }}></textarea><div className="btn-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}><button className="btn" id="ai-send" disabled={Advisor.busy} onClick={send}>Ask</button><button className="btn btn-ghost" id="ai-stop" hidden={!Advisor.busy} onClick={() => Advisor.ctl && Advisor.ctl.abort()}>Stop</button></div></div>
        </div>
    );
}
