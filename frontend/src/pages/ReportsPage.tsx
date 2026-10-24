import { useRef, useSyncExternalStore } from 'react';
import type { ScreenProps } from './registry';
import { SETTINGS } from '../domain/settings';
import { AS_OF, SCOPE } from '../domain/state';
import { Store } from '../domain/store';
import { addDays } from '../domain/engine';
import { isLive, leaseEnd, measurementType } from '../domain/lease';
import { REPORTS, buildReport, type ReportPart, type StmtRow } from '../domain/reporting';
import { Ent, approvalProgress, audit, can, checkApproval, guard, myRole, nameOf, presentationCcy } from '../domain/enterprise';
import { getSample, aiErr } from '../domain/ai';
import { go, setParams } from '../domain/nav';
import { useAppState } from '../hooks/useAppState';
import { exportMenu } from '../components/common/ExportMenu';
import { confirmDialog } from '../components/common/ConfirmDialog';
import { Modal, toast } from '../utils/uiStore';
import { saveFile } from '../utils/files';
import { esc, md } from '../utils/html';
import { fmtNum, fyBounds, uid, unitNote } from '../utils/format';
import { fmtDate, fmtDateTime } from '../utils/dates';
import type { DraftRecord } from '../types/enterprise';

/* ---- Statement table: rows of [label, ...values] with style 'sub' | 'total' | 'ind' ---- */
function Stmt({ head, rows }: { head: string[]; rows: StmtRow[] }) {
    return (
        <div className="scroll-x" style={{ marginBottom: '18px' }}>
            <table className="stmt">
                <thead><tr>{head.map((h, i) => <th key={i} className={i ? 'num' : ''}>{h}</th>)}</tr></thead>
                <tbody>
                    {rows.map((r, ri) => {
                        const style = r.style || '';
                        return (
                            <tr key={ri} className={style === 'sub' ? 'sub' : style === 'total' ? 'total' : ''}>
                                {r.cells.map((v, i) => <td key={i} className={i ? 'num' : style === 'ind' ? 'ind' : ''}>{i ? (typeof v === 'number' ? fmtNum(v) : (v ?? '')) : v}</td>)}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

function Part({ part }: { part: ReportPart }) {
    switch (part.kind) {
        case 'statement':
            return <>{part.intro ? <p style={{ marginBottom: '8px' }}>{part.intro}</p> : null}<h3>{part.name}</h3><Stmt head={part.head} rows={part.rows} /></>;
        case 'policy':
            return <><h3>Accounting policy</h3><p style={{ marginBottom: '8px' }}>{part.text}</p></>;
        case 'note':
            return <p className="note">{part.text}</p>;
        case 'empty':
            return <p className="empty">{part.text}</p>;
        case 'fx':
            return (
                <>
                    <p style={{ marginBottom: '8px' }}>Lease liabilities and net investments in finance leases are monetary items: retranslated at the closing rate, differences to profit or loss (IAS 21.23, 28). Right-of-use assets stay at the rate at commencement. Movements use the average rate for the period. Journals for these differences are included in ERP exports.</p>
                    <div className="scroll-x">
                        <table>
                            <thead><tr>{part.head.map((h, i) => <th key={i} className={i > 2 ? 'num' : ''}>{h}</th>)}</tr></thead>
                            <tbody>
                                {part.body.map((r, ri) => (
                                    <tr key={ri}>{r.map((v, i) => <td key={i} className={i > 2 ? 'num' : ''}>{typeof v === 'number' ? (i >= 6 && i <= 8 ? v.toFixed(4) : fmtNum(v)) : v}</td>)}</tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            );
    }
}

/* ---- AI drafting of the narrative disclosures (streams into the modal) ---- */
const ddStore = (() => {
    let html = '';
    const listeners = new Set<() => void>();
    return {
        get: () => html,
        set(next: string) { html = next; listeners.forEach(l => l()); },
        subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    };
})();

function DraftAiModal() {
    const html = useSyncExternalStore(ddStore.subscribe, ddStore.get);
    return (
        <>
            <p className="note"><span className="spinner"></span> Drafting from your figures. This takes up to a minute.</p>
            <div id="dd-out" dangerouslySetInnerHTML={{ __html: html }} />
        </>
    );
}

async function aiDraftDisclosure(from: string, to: string): Promise<void> {
    const sample = await getSample(); if (!sample) return toast('AI is not available in this view.');
    const rep = buildReport('note', from, to);
    const portfolio = Store.leases.filter(isLive).map(l => ({ id: l.id, name: l.name, role: l.role, class: l.assetClass, entity: l.entity, currency: l.currency, accounting: measurementType(l), end: leaseEnd(l), extensionOption: l.terms.extension, terminationOption: l.terms.termination, purchaseOption: l.terms.purchase, rvg: l.terms.rvg, variable: l.terms.variableNote, escalation: l.terms.escalation, events: (l.events || []).filter(e => e.status === 'approved').map(e => ({ type: e.type, effective: e.effective, reason: e.reason })) }));
    const pending = Store.leases.filter(l => l.status === 'pending').map(l => ({ id: l.id, name: l.name, commencement: l.terms.commencement }));
    ddStore.set('');
    let open = true;
    Modal.open('Draft lease disclosures with AI', <DraftAiModal />, { wide: true, onClose: () => { open = false; } });
    try {
        const r = await sample(`Draft the qualitative IFRS 16 disclosures (16.59 for lessees, 16.92 for lessors, plus the accounting policy judgements under IAS 1.122) for ${SETTINGS.entity}'s financial statements for ${from} to ${to}, presentation currency ${presentationCcy()}.
Rules: use only facts given below; every factual sentence ends with an evidence tag in square brackets naming the lease IDs or the report table it comes from, e.g. [HO-LHR-01] or [Maturity analysis]. Where a fact is missing, write [TO CONFIRM: ...]. Cover: nature of leasing activities; variable payments; extension and termination options not in the liability and their potential exposure; residual value guarantees; leases committed but not commenced; restrictions or covenants [TO CONFIRM]; sale and leaseback if any; significant judgements (lease term, discount rate). Formal annual-report style, headings, no preamble.
QUANTITATIVE NOTE (computed): ${JSON.stringify(rep.sheets).slice(0, 60000)}
PORTFOLIO: ${JSON.stringify(portfolio).slice(0, 60000)}
SIGNED BUT NOT YET APPROVED: ${JSON.stringify(pending)}`, { modelTier: 'complex', onText: ({ text }) => { if (open) ddStore.set(md(text)); } });
        const d: DraftRecord = { id: uid('dr'), title: `Lease disclosures ${from} to ${to}`, from, to, text: r.text, createdAt: new Date().toISOString(), createdBy: Store.actorId(), status: 'draft', approvals: [], source: 'AI (Claude) from computed note and portfolio' };
        await Ent.drafts.save(d); audit('ai.draft', `Disclosure draft created: ${d.title}`);
        Modal.close(); toast('Draft saved. It needs approval before it is final.'); go('reports', { report: 'drafts', draft: d.id }, { reset: true });
    } catch (e) { if (open) ddStore.set(`<p class="note">${esc(aiErr(e))}</p>`); }
}

/* ---- Narrative drafts view ---- */
const draftHtml = (text: string) => md(text)
    .replace(/\[TO CONFIRM:([^\]]*)\]/g, '<mark class="hit" style="background:var(--warn-bg)">[TO CONFIRM:$1]</mark>')
    .replace(/\[([A-Z]{2,}-[\w-]+(?:,\s*[A-Z]{2,}-[\w-]+)*|[A-Z][a-z]+(?: [a-z]+)* (?:analysis|assets|liabilities|note|cash flows))\]/g, '<span class="ref">$1</span>');

function EditDraftModal({ draft }: { draft: DraftRecord }) {
    const ref = useRef<HTMLTextAreaElement>(null);
    return (
        <>
            <textarea id="dr-t" rows={22} ref={ref} defaultValue={draft.text}></textarea>
            <div className="form-actions">
                <button className="btn btn-ghost" onClick={() => Modal.close()}>Cancel</button>
                <button className="btn" id="dr-s" onClick={async () => {
                    if (!guard('ai.use', 'edit drafts')) return;
                    draft.text = ref.current ? ref.current.value : draft.text; draft.editedBy = Store.actorId(); draft.approvals = [];
                    audit('ai.draft', `Draft edited: ${draft.title} (approvals reset)`); Modal.close(); await Ent.drafts.save(draft);
                }}>Save</button>
            </div>
        </>
    );
}

function Drafts({ draftId }: { draftId: string | null | undefined }) {
    const list = Ent.drafts.items.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)), cur = (draftId ? Ent.drafts.get(draftId) : undefined) || list[0];
    const save = async (d: DraftRecord) => { await Ent.drafts.save(d); };
    const approve = async (d: DraftRecord) => {
        if (/\[TO CONFIRM/.test(d.text)) return toast('Resolve every TO CONFIRM item before approving.');
        const chk = checkApproval('draft', d, 0, d.editedBy || d.createdBy); if (!chk.ok) return toast(chk.reason || '');
        d.approvals.push({ by: Store.actorId(), name: Store.actorName(), role: myRole(), at: new Date().toISOString() });
        if (chk.done) d.status = 'final';
        audit('ai.approve', `Draft ${d.status === 'final' ? 'approved as final' : 'approval given'}: ${d.title}`); await save(d);
    };
    return (
        <>
            <h2>Narrative drafts</h2><p className="note" style={{ margin: '4px 0 14px' }}>AI-drafted disclosures. Each claim carries an evidence tag; items marked TO CONFIRM need your input. A draft becomes final only after approval by a different person.</p>
            <div className="btn-row" style={{ marginBottom: '12px' }}>
                {list.length ? list.map(d => <button key={d.id} className="chip" data-d={d.id} style={cur && d.id === cur.id ? { borderColor: 'var(--accent)' } : undefined} onClick={() => setParams<'reports'>({ draft: d.id })}>{d.title} · {d.status === 'final' ? 'Final' : 'Draft'}</button>) : <p className="empty">No drafts yet. Use “Draft narrative with AI” on the disclosure note.</p>}
            </div>
            {cur ? (
                <div className="card">
                    <div className="section-head">
                        <div><h3>{cur.title}</h3><p className="note">Created {fmtDateTime(cur.createdAt)} by {nameOf(cur.createdBy)}. {cur.source}. {cur.status === 'final' ? 'Approved by ' + cur.approvals.map(a => a.name).join(', ') : approvalProgress(cur, 'draft', 0)}.</p></div>
                        <div className="btn-row">
                            {cur.status !== 'final' ? <><button className="btn btn-ghost" id="dr-edit" onClick={() => Modal.open('Edit draft', <EditDraftModal draft={cur} />, { wide: true })}>Edit</button><button className="btn" id="dr-ok" onClick={() => approve(cur)}>Approve</button></> : null}
                            <button className="btn btn-ghost" id="dr-dl" onClick={() => guard('report.export') && saveFile(`${cur.title.replace(/\W+/g, '_')}${cur.status === 'final' ? '' : '_DRAFT'}.md`, (cur.status === 'final' ? '' : 'DRAFT: NOT APPROVED\n\n') + cur.text)}>Download</button>
                            <button className="btn btn-danger" id="dr-del" onClick={() => confirmDialog('Delete draft', 'Delete this draft?', 'Delete', async () => { await Ent.drafts.remove(cur.id); audit('ai.draft', `Draft deleted: ${cur.title}`); setParams<'reports'>({ draft: null }); })}>Delete</button>
                        </div>
                    </div>
                    <div className="pad msg ai" id="dr-body" dangerouslySetInnerHTML={{ __html: draftHtml(cur.text) }} />
                </div>
            ) : null}
        </>
    );
}

export function ReportsPage({ params: p }: ScreenProps<'reports'>) {
    useAppState();
    const fy = fyBounds(AS_OF);
    const report = p.report || 'note', from = p.from || fy.start, to = p.to || (AS_OF < fy.end ? AS_OF : fy.end);
    const rep = buildReport(report, from, to);
    const lastFy = fyBounds(addDays(fy.start, -1));
    const drafts = report === 'drafts';
    return (
        <div className="kb">
            <div className="card kb-list">{REPORTS.map(([k, t, d]) => <button key={k} className={`kb-item ${report === k ? 'active' : ''}`} data-r={k} onClick={() => setParams<'reports'>({ report: k })}>{t}<small>{d}</small></button>)}</div>
            <div className="card">
                <div className="section-head">
                    <div className="btn-row">
                        <label style={{ margin: 0 }}>Period</label>
                        <input type="date" id="rf" value={from} style={{ width: '150px' }} onChange={e => setParams<'reports'>({ from: e.target.value })} />
                        <span className="muted">to</span>
                        <input type="date" id="rt" value={to} style={{ width: '150px' }} onChange={e => setParams<'reports'>({ to: e.target.value })} />
                        <button className="btn btn-ghost btn-sm" data-pre="fytd" onClick={() => setParams<'reports'>({ from: fy.start, to: AS_OF })}>{fy.label} to date</button>
                        <button className="btn btn-ghost btn-sm" data-pre="lastfy" onClick={() => setParams<'reports'>({ from: lastFy.start, to: lastFy.end })}>{lastFy.label}</button>
                    </div>
                    <div className="btn-row">
                        {report === 'note' && can('ai.use') ? <button className="btn btn-ghost" onClick={() => { void aiDraftDisclosure(from, to); }}>Draft narrative with AI</button> : null}
                        <button className="btn btn-ghost" id="rp-print" onClick={() => window.print()}>Print</button>
                        <button className="btn" id="rp-exp" hidden={drafts || undefined} onClick={e => exportMenu(e.currentTarget, () => rep.sheets, rep.title.replace(/\W+/g, '_'), `${rep.title}, ${fmtDate(from)} to ${fmtDate(to)}`)}>Export</button>
                    </div>
                </div>
                <div className="pad" id="rp-body">
                    {drafts ? <Drafts draftId={p.draft} /> : (
                        <>
                            <h2>{rep.title}</h2>
                            <p className="note" style={{ margin: '4px 0 14px' }}>{`${SETTINGS.entity}. ${fmtDate(from)} to ${fmtDate(to)}. ${presentationCcy()}${unitNote()}${SCOPE.entity ? '. Entity: ' + SCOPE.entity : ''}.`}</p>
                            {rep.parts.map((part, i) => <Part key={i} part={part} />)}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
