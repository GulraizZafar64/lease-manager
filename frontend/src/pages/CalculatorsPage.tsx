import { useState, type ReactNode } from 'react';
import type { ScreenProps } from './registry';
import { CURRENCIES, SETTINGS, engineSettings } from '../domain/settings';
import { annualFromMonthly, classifyLessor, initialFlows, monthlyRate, num as N, pvAt, solveMonthly } from '../domain/engine';
import { toFunctional } from '../domain/enterprise';
import { setParams } from '../domain/nav';
import { JournalPreview } from '../components/common/JournalTable';
import { fmtNum, pct, sum } from '../utils/format';
import type { TermsInput } from '../types/engine';

const CALCS: [key: string, title: string][] = [['contains', 'Does the contract contain a lease?'], ['term', 'Lease term: reasonably certain?'], ['pv', 'Present value of payments'], ['irr', 'Rate implicit in the lease'], ['alloc', 'Allocate consideration to components'], ['lessor', 'Lessor classification'], ['slb', 'Sale and leaseback'], ['lowvalue', 'Low-value check']];

/* Form values of one calculator, by input id, as the strings the inputs hold. */
type Vals = Record<string, string>;
function useVals(init: Record<string, string | number>) {
    const [vals, setVals] = useState<Vals>(() => Object.fromEntries(Object.entries(init).map(([k, v]) => [k, String(v)])));
    const set = (id: string, v: string) => setVals(o => ({ ...o, [id]: v }));
    const v = (id: string) => N(vals[id]);
    return { vals, set, v };
}
type Form = ReturnType<typeof useVals>;

function NumIn({ f, id, label, hint }: { f: Form; id: string; label: string; hint?: string }) {
    return <div className="fg"><label htmlFor={id}>{label}</label><input type="number" step="any" id={id} value={f.vals[id]} onChange={e => f.set(id, e.target.value)} />{hint ? <div className="hint">{hint}</div> : null}</div>;
}
function Sel({ f, id, children }: { f: Form; id: string; children: ReactNode }) {
    return <select id={id} value={f.vals[id]} onChange={e => f.set(id, e.target.value)}>{children}</select>;
}

/* ---- Does the contract contain a lease? ---- */
const Q: [key: string, text: string, ref: string, opts?: [string, string][]][] = [
    ['q1', 'Is there an identified asset (explicitly or implicitly specified, with no substantive substitution right for the supplier)?', 'B13-B20'],
    ['q2', 'Does the customer have the right to obtain substantially all of the economic benefits from use of the asset throughout the period of use?', 'B21-B23'],
    ['q3', 'Who has the right to direct how and for what purpose the asset is used throughout the period of use?', 'B24-B27', [['customer', 'Customer'], ['supplier', 'Supplier'], ['neither', 'Neither: how and for what purpose is predetermined']]],
    ['q4', 'Does the customer have the right to operate the asset throughout the period of use, without the supplier having the right to change those operating instructions?', 'B24(b)(i)'],
    ['q5', 'Did the customer design the asset in a way that predetermines how and for what purpose it will be used?', 'B24(b)(ii)'],
];
function Contains() {
    const [ans, setAns] = useState<Record<string, string>>({});
    // Pressed buttons are only updated for the question clicked, as in the original.
    const [pressed, setPressed] = useState<Record<string, string>>({});
    const shown = new Set(['q1']);
    let out = '';
    if (!ans.q1) out = ''; else if (ans.q1 === 'no') out = 'no'; else {
        shown.add('q2');
        if (ans.q2 === 'no') out = 'no'; else if (ans.q2 === 'yes') {
            shown.add('q3');
            if (ans.q3 === 'customer') out = 'yes'; else if (ans.q3 === 'supplier') out = 'no'; else if (ans.q3 === 'neither') {
                shown.add('q4');
                if (ans.q4 === 'yes') out = 'yes'; else if (ans.q4 === 'no') { shown.add('q5'); if (ans.q5) out = ans.q5 === 'yes' ? 'yes' : 'no'; }
            }
        }
    }
    const answer = (q: string, a: string) => {
        setPressed(o => ({ ...o, [q]: a }));
        setAns(o => { const n: Record<string, string> = { ...o, [q]: a }; Object.keys(n).forEach(k => { if (k > q) delete n[k]; }); return n; });
    };
    return (
        <>
            {Q.map(([k, t, ref, opts]) => (
                <div key={k} className="fg" data-q={k} hidden={!shown.has(k) || undefined}>
                    <label>{t} <span className="ref">{ref}</span></label>
                    <div className="seg">{(opts || [['yes', 'Yes'], ['no', 'No']]).map(([v, l]) => <button key={v} data-a={v} aria-pressed={pressed[k] === v} onClick={() => answer(k, v)}>{l}</button>)}</div>
                </div>
            ))}
            <div id="c-out">
                {out === 'yes' ? <div className="banner ok"><div><strong>The contract contains a lease.</strong><p>Separate lease and non-lease components next (16.12).</p></div></div>
                    : out === 'no' ? <div className="banner"><div><strong>The contract does not contain a lease.</strong><p>Account for it as a service contract. Keep this assessment on file.</p></div></div> : null}
            </div>
        </>
    );
}

/* ---- Lease term: reasonably certain? ---- */
const F: [string, number][] = [['Option rent is below market for the extension period', 3], ['Significant leasehold improvements would be lost on exit', 3], ['Relocation would be costly or disrupt distribution', 2], ['The asset is central to operations (e.g. main depot or head office)', 2], ['Termination penalty or loss of deposit is significant', 3], ['Past practice: similar leases have usually been extended', 1], ['Business plans need the space beyond the non-cancellable period', 2], ['Suitable alternative premises are scarce in the area', 1]];
function Term() {
    const [checked, setChecked] = useState<boolean[]>(() => F.map(() => false));
    const s = sum(F.filter((_, i) => checked[i]), x => x[1]);
    return (
        <>
            <p className="note" style={{ marginBottom: '12px' }}>Tick the factors that apply (16.B37-B40). “Reasonably certain” is a high threshold; the score only organises the evidence for your judgement.</p>
            {F.map(([t, w], i) => <label key={i} className="check" style={{ marginBottom: '8px' }}><input type="checkbox" data-w={w} data-i={i} checked={checked[i]} onChange={e => setChecked(c => c.map((x, j) => j === i ? e.target.checked : x))} />{' ' + t}</label>)}
            <div id="t-out" style={{ marginTop: '12px' }}><div className={`banner ${s >= 7 ? 'ok' : s >= 4 ? 'warn' : ''}`}><div><strong>{s >= 7 ? 'Strong economic incentive: likely reasonably certain' : s >= 4 ? 'Some incentive: judgement needed, document it' : 'Little incentive: likely not reasonably certain'}</strong><p>Score {s} of 17. Record the evidence in the lease notes and reassess on significant events within your control (16.20).</p></div></div></div>
        </>
    );
}

/* ---- Present value of payments ---- */
function Pv() {
    const f = useVals({ 'pv-p': 100000, 'pv-n': 60, 'pv-f': '1', 'pv-t': 'advance', 'pv-r': 15, 'pv-g': 0, 'pv-b': 0, 'pv-c': 'effective' });
    const { v } = f, fq = v('pv-f'), n = v('pv-n'), timing = f.vals['pv-t'];
    const T: TermsInput = { payment: v('pv-p'), freqM: fq, timing, termMonths: n * fq, escalation: v('pv-g') ? { type: 'fixed', rate: v('pv-g'), everyM: 12 } : { type: 'none' }, purchase: { price: v('pv-b'), certain: !!v('pv-b') }, extension: {}, termination: {} };
    const flows = initialFlows(T).flows;
    const im = monthlyRate(v('pv-r'), fq, f.vals['pv-c']), pv = pvAt(flows, im, 0), tot = sum(flows, x => x.amount);
    const atStart = sum(flows.filter(x => x.t === 0), x => x.amount);
    return (
        <>
            <div className="row4"><NumIn f={f} id="pv-p" label="Payment" /><NumIn f={f} id="pv-n" label="Number of payments" /><div className="fg"><label htmlFor="pv-f">Frequency</label><Sel f={f} id="pv-f"><option value="1">Monthly</option><option value="3">Quarterly</option><option value="12">Annually</option></Sel></div><div className="fg"><label htmlFor="pv-t">Timing</label><Sel f={f} id="pv-t"><option value="advance">Advance</option><option value="arrears">Arrears</option></Sel></div></div>
            <div className="row4"><NumIn f={f} id="pv-r" label="Annual rate %" /><NumIn f={f} id="pv-g" label="Escalation % a year" /><NumIn f={f} id="pv-b" label="Balloon / purchase price at end" /><div className="fg"><label htmlFor="pv-c">Convention</label><Sel f={f} id="pv-c"><option value="effective">Effective (IFRS examples)</option><option value="nominal">Nominal (r ÷ periods)</option></Sel></div></div>
            <div id="pv-out"><table className="ledger" style={{ maxWidth: '420px' }}><tbody><tr><td>Undiscounted total</td><td className="num">{fmtNum(tot)}</td></tr><tr><td>Present value</td><td className="num">{fmtNum(pv)}</td></tr><tr><td>Of which paid at commencement</td><td className="num">{fmtNum(atStart)}</td></tr><tr className="total"><td>Lease liability (excluding payment at commencement)</td><td className="num">{fmtNum(pv - atStart)}</td></tr><tr><td>Monthly rate used</td><td className="num">{(im * 100).toFixed(5)}%</td></tr></tbody></table></div>
        </>
    );
}

/* ---- Rate implicit in the lease ---- */
function Irr() {
    const f = useVals({ 'ir-fv': 500000, 'ir-idc': 3000, 'ir-p': 110000, 'ir-n': 5, 'ir-f': '12', 'ir-t': 'arrears', 'ir-u': 1000, 'ir-b': 0 });
    const { v } = f, fq = v('ir-f');
    const flows = initialFlows({ payment: v('ir-p'), freqM: fq, timing: f.vals['ir-t'], termMonths: v('ir-n') * fq, escalation: { type: 'none' }, purchase: { price: v('ir-b'), certain: !!v('ir-b') }, extension: {}, termination: {} }).flows;
    if (v('ir-u')) flows.push({ t: v('ir-n') * fq, amount: v('ir-u') });
    const im = solveMonthly(flows, v('ir-fv') + v('ir-idc'), 0);
    return (
        <>
            <div className="row4"><NumIn f={f} id="ir-fv" label="Fair value of the asset" /><NumIn f={f} id="ir-idc" label="Lessor’s initial direct costs" /><NumIn f={f} id="ir-p" label="Payment" /><NumIn f={f} id="ir-n" label="Number of payments" /></div>
            <div className="row4"><div className="fg"><label htmlFor="ir-f">Frequency</label><Sel f={f} id="ir-f"><option value="12">Annually</option><option value="3">Quarterly</option><option value="1">Monthly</option></Sel></div><div className="fg"><label htmlFor="ir-t">Timing</label><Sel f={f} id="ir-t"><option value="arrears">Arrears</option><option value="advance">Advance</option></Sel></div><NumIn f={f} id="ir-u" label="Unguaranteed residual value" /><NumIn f={f} id="ir-b" label="Purchase price / guaranteed residual" /></div>
            <div id="ir-out">{im === null ? <p className="note">No rate found: payments do not cover the fair value.</p> : <table className="ledger" style={{ maxWidth: '420px' }}><tbody><tr className="total"><td>Rate implicit in the lease (effective annual)</td><td className="num">{pct(annualFromMonthly(im, fq, 'effective'), 3)}</td></tr><tr><td>Nominal annual equivalent</td><td className="num">{pct(annualFromMonthly(im, fq, 'nominal'), 3)}</td></tr><tr><td>Monthly rate</td><td className="num">{(im * 100).toFixed(5)}%</td></tr></tbody></table>}</div>
            <p className="note">Defaults reproduce your FinanceLease Co example (3.11%).</p>
        </>
    );
}

/* ---- Allocate consideration to components ---- */
interface AllocRow { key: number; name: string; type: string; ssp: string }
const ALLOC_ROWS: [string, number, string][] = [['Bulldozer: lease', 170000, 'lease'], ['Truck: lease', 102000, 'lease'], ['Excavator: lease', 224000, 'lease'], ['Bulldozer: maintenance', 32000, 'non'], ['Truck: maintenance', 16000, 'non'], ['Excavator: maintenance', 56000, 'non']];
function Alloc() {
    const f = useVals({ 'al-tot': 600000 });
    const [rows, setRows] = useState<AllocRow[]>(() => ALLOC_ROWS.map(([name, ssp, type], i) => ({ key: i, name, type, ssp: String(ssp) })));
    const edit = (key: number, patch: Partial<AllocRow>) => setRows(rs => rs.map(r => r.key === key ? { ...r, ...patch } : r));
    const tot = f.v('al-tot'), ssp = rows.map(r => N(r.ssp)), S = sum(ssp, x => x);
    return (
        <>
            <NumIn f={f} id="al-tot" label="Total fixed consideration" />
            <div className="scroll-x">
                <table>
                    <thead><tr><th>Component</th><th>Type</th><th className="num">Stand-alone price</th><th className="num">Allocated</th></tr></thead>
                    <tbody id="al-rows">
                        {rows.map((r, i) => (
                            <tr key={r.key}>
                                <td><input value={r.name} onChange={e => edit(r.key, { name: e.target.value })} /></td>
                                <td><select value={r.type} onChange={e => edit(r.key, { type: e.target.value })}><option value="lease">Lease</option><option value="non">Non-lease</option></select></td>
                                <td><input type="number" value={r.ssp} onChange={e => edit(r.key, { ssp: e.target.value })} /></td>
                                <td className="num">{S ? fmtNum(tot * ssp[i] / S) : '—'}</td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot><tr><td colSpan={2}><button className="btn btn-ghost btn-sm" id="al-add" onClick={() => setRows(rs => rs.concat([{ key: rs.length ? rs[rs.length - 1].key + 1 : 0, name: 'New component', type: 'lease', ssp: '0' }]))}>Add component</button></td><td className="num" id="al-ssp">{fmtNum(S)}</td><td className="num" id="al-sum">{fmtNum(tot)}</td></tr></tfoot>
                </table>
            </div>
            <p className="note" style={{ marginTop: '8px' }}>Defaults reproduce IFRS 16 IE Example 12 (your “Allocation of transaction price” sheet): leases 496,000, maintenance 104,000. Lessees may elect not to separate (16.15); lessors must (16.17).</p>
        </>
    );
}

/* ---- Lessor classification ---- */
function LessorCalc() {
    const f = useVals({ 'lc-fv': 35000, 'lc-p': 9200, 'lc-n': 4, 'lc-l': 6, 'lc-r': 3 });
    const [chk, setChk] = useState({ o: false, b: false, s: false });
    const { v } = f;
    const T: TermsInput = { payment: v('lc-p'), freqM: 12, timing: 'arrears', termMonths: v('lc-n') * 12, usefulLifeM: v('lc-l') * 12, fairValue: v('lc-fv'), discountRate: v('lc-r'), escalation: { type: 'none' }, extension: {}, termination: {}, purchase: { certain: chk.b }, ownershipTransfer: chk.o, specialised: chk.s, classification: 'auto' };
    const c = classifyLessor(T, engineSettings());
    const box = (k: 'o' | 'b' | 's', label: string) => <div className="fg"><label className="check" style={{ marginTop: '24px' }}><input type="checkbox" id={'lc-' + k} checked={chk[k]} onChange={e => setChk(o => ({ ...o, [k]: e.target.checked }))} />{' ' + label}</label></div>;
    return (
        <>
            <div className="row4"><NumIn f={f} id="lc-fv" label="Fair value of the asset" /><NumIn f={f} id="lc-p" label="Annual payment" /><NumIn f={f} id="lc-n" label="Lease term (years)" /><NumIn f={f} id="lc-l" label="Economic life (years)" /></div>
            <div className="row4"><NumIn f={f} id="lc-r" label="Discount rate %" />{box('o', 'Ownership transfers')}{box('b', 'Bargain purchase option')}{box('s', 'Specialised asset')}</div>
            <div id="lc-out">
                <ul className="warn-list">{c.indicators.map((i, n) => <li key={n} className={i.met ? '' : 'info'}>{i.met ? 'Met' : 'Not met'}: {i.label} <span className="ref">{i.ref}</span></li>)}</ul>
                <div className={`banner ${c.auto === 'finance' ? 'ok' : ''}`} style={{ marginTop: '12px' }}><div><strong>Indicates {c.auto} lease</strong><p>Indicators are not bright lines (16.65). Thresholds from Settings: {SETTINGS.majorPartPct}% of economic life, {SETTINGS.substantiallyAllPct}% of fair value.</p></div></div>
            </div>
        </>
    );
}

/* ---- Sale and leaseback ---- */
function Slb() {
    const f = useVals({ 'sl-ca': 1000000, 'sl-fv': 1800000, 'sl-sp': 2000000, 'sl-p': 120000, 'sl-n': 18, 'sl-r': 4.5 });
    const { v } = f, r = v('sl-r') / 100, n = v('sl-n');
    const af = r ? (1 - Math.pow(1 + r, -n)) / r : n, pvAll = v('sl-p') * af;
    const excess = v('sl-sp') - v('sl-fv'), prepaid = Math.max(0, -excess);
    const finPV = Math.max(0, excess), leasePV = pvAll - finPV;
    const rou = v('sl-ca') / v('sl-fv') * (leasePV + prepaid);
    const gainTotal = v('sl-fv') - v('sl-ca'), gainRetained = gainTotal / v('sl-fv') * (leasePV + prepaid), gainRec = gainTotal - gainRetained;
    return (
        <>
            <div className="row4"><NumIn f={f} id="sl-ca" label="Carrying amount before sale" /><NumIn f={f} id="sl-fv" label="Fair value" /><NumIn f={f} id="sl-sp" label="Sale price" /><NumIn f={f} id="sl-p" label="Annual leaseback payment (arrears)" /></div>
            <div className="row4"><NumIn f={f} id="sl-n" label="Leaseback term (years)" /><NumIn f={f} id="sl-r" label="Discount rate %" /><div></div><div></div></div>
            <div id="sl-out">
                <div className="grid-2">
                    <table className="ledger"><tbody><tr><td>PV of all leaseback payments</td><td className="num">{fmtNum(pvAll)}</td></tr><tr><td>Additional financing (sale price above fair value)</td><td className="num">{fmtNum(finPV)}</td></tr><tr><td>Lease portion of payments (PV)</td><td className="num">{fmtNum(leasePV)}</td></tr><tr><td>Annual payment: lease / financing</td><td className="num">{`${fmtNum(v('sl-p') * leasePV / pvAll)} / ${fmtNum(v('sl-p') * finPV / pvAll)}`}</td></tr><tr className="total"><td>Right-of-use asset (16.100(a))</td><td className="num">{fmtNum(rou)}</td></tr><tr><td>Total gain on the building</td><td className="num">{fmtNum(gainTotal)}</td></tr><tr><td>Relating to rights retained (not recognised)</td><td className="num">{fmtNum(gainRetained)}</td></tr><tr className="total"><td>Gain recognised (rights transferred)</td><td className="num">{fmtNum(gainRec)}</td></tr></tbody></table>
                    <div><h4>Seller-lessee entry</h4><JournalPreview lines={[['Bank', v('sl-sp'), 0], ['Right-of-use asset', rou, 0], ['Building', 0, v('sl-ca')], ['Financial liability (lease and financing)', 0, pvAll], ['Gain on rights transferred', 0, gainRec]]} /><p className="note">{prepaid ? 'Sale price below fair value: the shortfall is a prepayment of lease payments (16.101(a)).' : ''}</p></div>
                </div>
            </div>
            <p className="note">Defaults reproduce IFRS 16 IE Example 24 (your Example 10). Applies only if the transfer is a sale under IFRS 15 (16.99).</p>
        </>
    );
}

/* ---- Low-value check ---- */
function LowValue() {
    const f = useVals({ 'lv-v': 150000, 'lv-c': CURRENCIES.includes(SETTINGS.functionalCurrency) ? SETTINGS.functionalCurrency : CURRENCIES[0] });
    const [chk, setChk] = useState({ sub: false, dep: false, car: false });
    const val = f.v('lv-v'), ccy = f.vals['lv-c'];
    const inLV = toFunctional(val, ccy) / toFunctional(1, SETTINGS.lowValueCurrency);
    const blocked = chk.sub || chk.dep || chk.car;
    const ok = !blocked && inLV <= N(SETTINGS.lowValueThreshold);
    const box = (k: 'sub' | 'dep' | 'car', label: string) => <label className="check" style={{ marginBottom: '8px' }}><input type="checkbox" id={'lv-' + k} checked={chk[k]} onChange={e => setChk(o => ({ ...o, [k]: e.target.checked }))} />{' ' + label}</label>;
    return (
        <>
            <div className="row3"><NumIn f={f} id="lv-v" label="Price of the asset when new" /><div className="fg"><label htmlFor="lv-c">Currency</label><Sel f={f} id="lv-c">{CURRENCIES.map(c => <option key={c}>{c}</option>)}</Sel></div><div></div></div>
            {box('sub', 'We sublease or expect to sublease the asset')}{box('dep', 'The asset depends on or is highly interrelated with other assets')}{box('car', 'The asset is a car, truck, building or similar')}<div id="lv-out"><div className={`banner ${ok ? 'ok' : 'warn'}`}><div><strong>{ok ? 'Qualifies as low-value' : 'Does not qualify as low-value'}</strong><p>{`About ${SETTINGS.lowValueCurrency} ${fmtNum(inLV)} when new against a policy threshold of ${SETTINGS.lowValueCurrency} ${fmtNum(SETTINGS.lowValueThreshold)} (B3-B8, BC100). ${blocked ? 'Excluded by B5-B6 regardless of value.' : ''}`}</p></div></div></div>
        </>
    );
}

const CALC_RENDER: Record<string, () => ReactNode> = { contains: Contains, term: Term, pv: Pv, irr: Irr, alloc: Alloc, lessor: LessorCalc, slb: Slb, lowvalue: LowValue };

export function CalculatorsPage({ params: p }: ScreenProps<'tools'>) {
    const calc = p.calc || 'contains';
    const Calc = CALC_RENDER[calc];
    const title = (CALCS.find(c => c[0] === calc) || ['', ''])[1];
    return (
        <div className="kb">
            <div className="card kb-list">{CALCS.map(([k, t]) => <button key={k} className={`kb-item ${calc === k ? 'active' : ''}`} data-c={k} onClick={() => setParams<'tools'>({ calc: k })}>{t}</button>)}</div>
            <div className="card"><div className="section-head"><h2>{title}</h2></div><div className="pad" id="calc">{Calc ? <Calc key={calc} /> : null}</div></div>
        </div>
    );
}
