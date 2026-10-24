import { initialFlows, num as N, run } from '../../domain/engine';
import { engineSettings } from '../../domain/settings';
import { JournalPreview } from '../common/JournalTable';
import { errMessage, fmtNum, pct, sum } from '../../utils/format';
import type { EngineResult } from '../../types/engine';
import type { Lease } from '../../types/lease';

/** Live measurement of a lease as entered (lease form side panel, approvals). */
export function MeasurementPanel({ lease: l }: { lease: Lease }) {
    const T = l.terms, warn: [string, string][] = [];
    if (!T.commencement || !N(T.termMonths) || !N(T.payment)) return <p className="note">Enter the commencement date, term and payment to see the measurement as you type.</p>;
    let res: EngineResult;
    try { res = run(l, engineSettings()); } catch (e) { return <p className="note">{errMessage(e)}</p>; }
    const term = res.termMonths;
    const undiscounted = sum(initialFlows(T).flows, f => f.amount);
    // judgement prompts
    if (l.role === 'lessee' && T.exemption === 'none' && term <= 12 && !N(T.purchase.price)) warn.push(['info', 'The lease term is 12 months or less with no purchase option. You may elect the short-term exemption for this class of asset (16.5-8).']);
    if (T.exemption === 'low-value' && ['vehicle', 'building', 'warehouse', 'land', 'retail'].includes(l.assetClass)) warn.push(['', 'Low-value applies to the asset’s value when new (for example tablets, phones, small furniture). Vehicles and property generally do not qualify (16.B6-B8).']);
    if (N(T.extension.months) && !T.extension.certain) warn.push(['info', `The ${T.extension.months}-month extension is excluded. Reassess at each significant event within the lessee’s control (16.20).`]);
    if (T.escalation.type === 'index') warn.push(['info', 'Index-linked payments are measured at today’s index. When the index changes and payments reset, add a “change in an index” remeasurement at the unchanged rate (16.42(b)).']);
    if (N(T.serviceComponent) && T.combine) warn.push(['info', 'The service element is included in the liability because you chose to combine components (16.15).']);
    if (l.role === 'lessee' && N(T.discountRate) && (N(T.discountRate) > 40 || N(T.discountRate) < 1)) warn.push(['', `A rate of ${T.discountRate}% looks unusual. Check it reflects the term, currency and security of the lease (Appendix A, IBR).`]);
    if (N(T.usefulLifeM) && N(T.usefulLifeM) < term && !T.ownershipTransfer && !T.purchase.certain) warn.push(['info', 'Useful life is shorter than the lease term, so depreciation runs over the useful life.']);
    if (N(T.rvg) && l.role === 'lessee') warn.push(['info', 'Only the amount expected to be payable under the guarantee is included (16.27(c)). Update it if expectations change.']);
    let body;
    if (res.mode === 'lessee') {
        const I = res.initial, first = res.rows.slice(0, 12);
        body = <>
            <table className="ledger"><tbody>
                <tr><td>Lease term</td><td className="num">{term} months</td></tr>
                <tr><td>Undiscounted lease payments</td><td className="num">{fmtNum(undiscounted)}</td></tr>
                <tr><td>Lease liability (present value)</td><td className="num">{fmtNum(I.liability)}</td></tr>
                <tr><td>Paid at or before commencement</td><td className="num">{fmtNum(I.paidAtCommencement)}</td></tr>
                <tr><td>Initial direct costs</td><td className="num">{fmtNum(I.idc)}</td></tr>
                <tr><td>Incentives received</td><td className="num">{fmtNum(-I.incentives)}</td></tr>
                {I.restoration ? <tr><td>Restoration provision</td><td className="num">{fmtNum(I.restoration)}</td></tr> : null}
                {I.deposit ? <tr><td>Deposit excess over fair value</td><td className="num">{fmtNum(I.depositAdj)}</td></tr> : null}
                <tr className="total"><td>Right-of-use asset</td><td className="num">{fmtNum(I.rou)}</td></tr></tbody></table>
            <table className="ledger" style={{ marginTop: '12px' }}><tbody>
                <tr><td>Depreciation per month ({res.depEnd} months)</td><td className="num">{fmtNum(res.depEnd ? I.rou / res.depEnd : 0)}</td></tr>
                <tr><td>Interest, first 12 months</td><td className="num">{fmtNum(sum(first, r => r.int))}</td></tr>
                <tr><td>Lease cost, first 12 months</td><td className="num">{fmtNum(sum(first, r => r.int + r.dep))}</td></tr>
                <tr><td>Cash paid, first 12 months</td><td className="num">{fmtNum(I.paidAtCommencement + sum(first, r => r.payAdv + r.payArr))}</td></tr>
                {I.implicitSolved ? <tr><td>Implicit rate solved</td><td className="num">{pct(I.annualRate, 3)}</td></tr> : null}</tbody></table>
            <h4 style={{ marginTop: '14px' }}>Entry at commencement</h4>
            <JournalPreview lines={[['Right-of-use asset', I.rou, 0], ['Bank: incentives received', I.incentives, 0], ['Security deposit (fair value)', I.depositFV, 0], ['Lease liability', 0, I.liability], ['Bank', 0, I.paidAtCommencement + I.idc + I.deposit], ['Restoration provision', 0, I.restoration]]} />
        </>;
    } else if (res.mode === 'exempt') {
        body = <><table className="ledger"><tbody><tr><td>Lease term</td><td className="num">{term} months</td></tr><tr><td>Total payments</td><td className="num">{fmtNum(res.initial.total)}</td></tr><tr className="total"><td>Expense per month (straight-line)</td><td className="num">{fmtNum(res.initial.monthlyExpense)}</td></tr></tbody></table><p className="note" style={{ marginTop: '8px' }}>No asset or liability is recognised (16.6). The expense and the commitment are disclosed (16.53(c)-(d), 16.55).</p></>;
    } else if (res.mode === 'lessor-finance') {
        const I = res.initial;
        body = <>
            <p><span className="badge badge-info">Finance lease</span></p><ul className="warn-list">{res.classification.indicators.filter(i => i.met).map(i => <li key={i.key} className="info">{i.label}{' '}<span className="ref">{i.ref}</span></li>)}</ul>
            <table className="ledger" style={{ marginTop: '10px' }}><tbody><tr><td>Net investment</td><td className="num">{fmtNum(I.netInvestment)}</td></tr><tr><td>Implicit rate</td><td className="num">{pct(I.annualRate, 3)}</td></tr>
                {l.terms.dealer
                    ? <><tr><td>Revenue</td><td className="num">{fmtNum(I.revenue)}</td></tr><tr><td>Cost of sales</td><td className="num">{fmtNum(-I.cogs)}</td></tr><tr className="total"><td>Selling profit after costs</td><td className="num">{fmtNum(I.sellingProfit)}</td></tr></>
                    : <tr className="total"><td>Gain on derecognition</td><td className="num">{fmtNum(I.gainOnDerecognition)}</td></tr>}
                <tr><td>Finance income, first 12 months</td><td className="num">{fmtNum(sum(res.rows.slice(0, 12), r => r.int))}</td></tr></tbody></table>
        </>;
    } else {
        body = <>
            <p><span className="badge badge-neutral">Operating lease</span></p><p className="note" style={{ margin: '6px 0' }}>None of the finance lease indicators is met{l.terms.classification === 'operating' ? ' (or classification set manually)' : ''}.</p>
            <table className="ledger"><tbody><tr><td>Total lease payments</td><td className="num">{fmtNum(res.initial.total)}</td></tr><tr className="total"><td>Lease income per month</td><td className="num">{fmtNum(res.initial.monthlyIncome)}</td></tr><tr><td>Asset depreciation per month</td><td className="num">{fmtNum(res.initial.assetDepMonthly)}</td></tr></tbody></table>
        </>;
    }
    return <>{body}{warn.length ? <ul className="warn-list" style={{ marginTop: '14px' }}>{warn.map(([c, t], i) => <li key={i} className={c}>{t}</li>)}</ul> : null}</>;
}
