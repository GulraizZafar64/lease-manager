import { periodTotals, run } from '../../domain/engine';
import { getResult } from '../../domain/lease';
import { engineSettings } from '../../domain/settings';
import { journalsFor } from '../../domain/journals';
import { JournalPreview } from '../common/JournalTable';
import { deepClone, errMessage, fmtNum, fyBounds } from '../../utils/format';
import { fmtDate } from '../../utils/dates';
import type { EngineResult, FinanceEventResult, LesseeEventResult, OperatingEventResult } from '../../types/engine';
import type { Lease, LeaseEvent } from '../../types/lease';

type ImpactLine = [label: string, value: unknown, shown?: string];

/** Before/after impact of a change, with its journal entry (computed by running the engine with it approved). */
export function EventImpact({ lease, event: ev }: { lease: Lease; event: LeaseEvent }) {
    const before = getResult(lease);
    const trial = deepClone(lease);
    trial.events = (trial.events || []).filter(e => e.id !== ev.id).concat([Object.assign({}, ev, { status: 'approved' as const })]);
    let after: EngineResult;
    try { after = run(trial, engineSettings()); } catch (e) { return <p className="note">{errMessage(e)}</p>; }
    const e = (after.events as { id: string }[]).find(x => x.id === ev.id);
    if (!e) return <p className="note">The change falls outside the lease term, so it has no effect.</p>;
    const ccy = lease.currency;
    const fy = fyBounds(ev.effective);
    const tb = periodTotals(before || after, fy.start, fy.end), ta = periodTotals(after, fy.start, fy.end);
    let lines: ImpactLine[] = [];
    const le = e as LesseeEventResult;
    if (after.mode === 'lessee') {
        if (ev.type === 'impair') lines = [['Impairment loss', -le.before.A + le.after.A]];
        else if (ev.type === 'terminate') lines = [['Liability derecognised', le.before.L], ['Right-of-use asset derecognised', le.before.A], ['Penalty', ev.penalty || 0], ['Gain / (loss)', le.before.L - le.before.A - (ev.penalty || 0)]];
        else {
            if (le.partial) lines.push(['Proportion of right of use retained', null, (le.partial.fraction * 100).toFixed(1) + '%'], ['Decrease in liability', -le.partial.dL], ['Decrease in right-of-use asset', -le.partial.dA], ['Gain / (loss) in profit or loss', le.partial.gain]);
            lines.push(['Remeasured liability', le.remeasured], ['Adjustment to liability and right-of-use asset', le.adjustment]);
        }
    } else if (after.mode === 'lessor-finance') lines = [['Change in net investment (gain / loss, IFRS 9)', (e as FinanceEventResult).adjustment || 0]];
    else { const oe = e as OperatingEventResult; lines = oe.newMonthlyIncome != null ? [['New straight-line income per month', oe.newMonthlyIncome]] : []; }
    const jl = journalsFor(Object.assign(trial, { status: 'active' as const }), ev.effective, ev.effective).filter(j => j.kind !== 'Monthly' && j.kind !== 'Initial recognition');
    return (
        <div className="card" style={{ marginTop: '6px' }}><div className="section-head"><h3>Impact at {fmtDate((e as LesseeEventResult).date)}</h3><span className="note">{ccy}</span></div><div className="pad grid-2">
            <div><table className="ledger"><tbody>
                {after.mode === 'lessee' ? <><tr><td>Liability before</td><td className="num">{fmtNum(le.before.L)}</td></tr><tr><td>Right-of-use asset before</td><td className="num">{fmtNum(le.before.A)}</td></tr></> : null}
                {lines.map(([k, v, s], i) => <tr key={i}><td>{k}</td><td className="num">{s ?? fmtNum(v)}</td></tr>)}
                {after.mode === 'lessee' ? <><tr className="total"><td>Liability after</td><td className="num">{fmtNum(le.after.L)}</td></tr><tr><td>Right-of-use asset after</td><td className="num">{fmtNum(le.after.A)}</td></tr></> : null}
            </tbody></table>
                <table className="ledger" style={{ marginTop: '12px' }}><tbody><tr><td><strong>{fy.label} profit or loss</strong></td><td className="num">Before</td><td className="num">After</td></tr>
                    {after.mode === 'lessee'
                        ? <><tr><td>Depreciation</td><td className="num">{fmtNum(tb.dep)}</td><td className="num">{fmtNum(ta.dep)}</td></tr><tr><td>Interest</td><td className="num">{fmtNum(tb.int)}</td><td className="num">{fmtNum(ta.int)}</td></tr><tr><td>Gain / (loss)</td><td className="num">{fmtNum(tb.gain)}</td><td className="num">{fmtNum(ta.gain)}</td></tr></>
                        : after.mode === 'lessor-finance'
                            ? <tr><td>Finance income</td><td className="num">{fmtNum(tb.int)}</td><td className="num">{fmtNum(ta.int)}</td></tr>
                            : <tr><td>Lease income</td><td className="num">{fmtNum(tb.income)}</td><td className="num">{fmtNum(ta.income)}</td></tr>}
                </tbody></table></div>
            <div><h4>Journal entry</h4>{jl.length ? jl.map((j, i) => <JournalPreview key={i} lines={j.lines.map(x => [x.account, x.dr, x.cr])} />) : <p className="note">No entry at the effective date.</p>}</div>
        </div></div>
    );
}
