import { useMemo } from 'react';
import type { ScreenProps } from './registry';
import { addDays, addMonths } from '../domain/engine';
import { Store } from '../domain/store';
import { presentationCcy, toFunctional } from '../domain/enterprise';
import { journalsFor, journalRows, fxJournals } from '../domain/journals';
import { setParams } from '../domain/nav';
import { AS_OF } from '../domain/state';
import { useAppState } from '../hooks/useAppState';
import { exportMenu } from '../components/common/ExportMenu';
import { JournalTable } from '../components/common/JournalTable';
import { fmtNum, fyBounds, sum } from '../utils/format';
import { fmtDate } from '../utils/dates';

type View = 'summary' | 'detail';

export function JournalsPage({ params: p }: ScreenProps<'journals'>) {
    const version = useAppState();
    const fy = fyBounds(AS_OF);
    // Defaults as the original assigned them into the params (the "to" default follows the "from" in force).
    const from = p.from || AS_OF.slice(0, 8) + '01';
    const to = p.to || addDays(addMonths(from, 1), -1);
    const view: View = p.view || 'summary';
    const set = (patch: { from?: string; to?: string; view?: View }) => setParams<'journals'>({ from, to, view, ...patch });

    const { all, accRows, tdr, tcr } = useMemo(() => {
        const all = Store.leases.flatMap(l => journalsFor(l, from, to)).concat(fxJournals(from, to)).sort((a, b) => a.date.localeCompare(b.date) || a.leaseId.localeCompare(b.leaseId));
        const byAcc: Record<string, { dr: number; cr: number }> = {};
        all.forEach(j => j.lines.forEach(x => { const a = byAcc[x.account] = byAcc[x.account] || { dr: 0, cr: 0 }; a.dr += toFunctional(x.dr, j.currency); a.cr += toFunctional(x.cr, j.currency); }));
        const accRows = Object.entries(byAcc).sort((a, b) => a[0].localeCompare(b[0]));
        return { all, accRows, tdr: sum(accRows, r => r[1].dr), tcr: sum(accRows, r => r[1].cr) };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [from, to, version]);

    return (
        <div className="card">
            <div className="section-head">
                <div className="btn-row">
                    <label style={{ margin: 0 }}>From</label><input type="date" id="jf" value={from} style={{ width: '150px' }} onChange={e => set({ from: e.target.value })} /><label style={{ margin: 0 }}>To</label><input type="date" id="jt" value={to} style={{ width: '150px' }} onChange={e => set({ to: e.target.value })} />
                    <button className="btn btn-ghost btn-sm" data-pre="month" onClick={() => { const f = AS_OF.slice(0, 8) + '01'; set({ from: f, to: addDays(addMonths(f, 1), -1) }); }}>This month</button><button className="btn btn-ghost btn-sm" data-pre="fy" onClick={() => set({ from: fy.start, to: AS_OF })}>{fy.label} to date</button>
                </div>
                <div className="btn-row">
                    <div className="seg"><button data-v="summary" aria-pressed={view === 'summary'} onClick={() => set({ view: 'summary' })}>By account</button><button data-v="detail" aria-pressed={view === 'detail'} onClick={() => set({ view: 'detail' })}>Entries</button></div>
                    <button className="btn" id="j-exp" onClick={e => exportMenu(e.currentTarget, () => [{ name: 'Entries', rows: journalRows(all) }, { name: 'By account', rows: [['Account', 'Debit', 'Credit', 'Net'] as (string | number)[]].concat(accRows.map(([a, v]) => [a, v.dr, v.cr, v.dr - v.cr])) }], `Lease_journals_${from}_${to}`, `Lease journal entries ${fmtDate(from)} to ${fmtDate(to)}`)}>Export for posting</button>
                </div>
            </div>
            <div id="j-body">
                {view === 'summary'
                    ? <div className="scroll-x"><table><thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Net</th></tr></thead><tbody>{accRows.length ? accRows.map(([a, v]) => <tr key={a}><td>{a}</td><td className="num">{fmtNum(v.dr)}</td><td className="num">{fmtNum(v.cr)}</td><td className="num">{fmtNum(v.dr - v.cr)}</td></tr>) : <tr><td colSpan={4} className="empty">No entries in this period.</td></tr>}</tbody>
                        <tfoot><tr><td>Total ({all.length} entries)</td><td className="num">{fmtNum(tdr)}</td><td className="num">{fmtNum(tcr)}</td><td className="num">{Math.abs(tdr - tcr) < 1 ? 'Balanced' : fmtNum(tdr - tcr)}</td></tr></tfoot></table></div>
                    : <JournalTable list={all} showLease={true} />}
            </div>
            <div className="table-note">Amounts in each lease’s currency; the account summary converts to {presentationCcy()} at the rates in Settings. Approved changes only; drafts and pending items are excluded. Account names come from Settings.</div>
        </div>
    );
}
