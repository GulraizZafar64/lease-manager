import { useMemo, useState } from 'react';
import type { ChartConfiguration } from 'chart.js';
import type { ScreenProps } from './registry';
import { num } from '../domain/engine';
import { ASSET_CLASSES, SETTINGS } from '../domain/settings';
import { Store } from '../domain/store';
import { AS_OF, SCOPE } from '../domain/state';
import { getResult } from '../domain/lease';
import { can, presentationCcy } from '../domain/enterprise';
import { SCENARIOS, cashForecast, findExceptions, rateSensitivity, runScenario, runoffMatrix, type ExceptionItem } from '../domain/analytics';
import { aiErr, getSample, leaseContext } from '../domain/ai';
import { go, setParams } from '../domain/nav';
import { useAppState } from '../hooks/useAppState';
import { ChartCanvas, PALETTE, chartOpts } from '../components/common/ChartCanvas';
import { exportMenu } from '../components/common/ExportMenu';
import { CommitInput } from '../components/ops/CommitInput';
import { cap, fmtNum, sum, unitNote } from '../utils/format';
import { fmtDate } from '../utils/dates';
import { md } from '../utils/html';

type P = ScreenProps<'analytics'>['params'];
const TABS: [string, string][] = [['forecast', 'Cash-flow forecast'], ['scenario', 'Scenarios'], ['sensitivity', 'Rate sensitivity'], ['runoff', 'Liability run-off'], ['exceptions', 'Exceptions']];

function Note() {
    return <p className="note" style={{ marginBottom: '12px' }}>{`${presentationCcy()}${unitNote()}, translated at rates in Administration. ${SCOPE.entity ? 'Entity: ' + SCOPE.entity + '.' : 'All entities you can access.'}`}</p>;
}

function Forecast({ p }: { p: P }) {
    const version = useAppState();
    const months = p.months || 24;
    const b = useMemo(() => cashForecast(months),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [months, version]);
    const config = useMemo(() => {
        const keys = [...new Set(b.flatMap(x => Object.keys(x.byClass)))];
        const cfg: ChartConfiguration<'bar'> = { type: 'bar', data: { labels: b.map(x => x.label), datasets: keys.map((k, i) => ({ label: ASSET_CLASSES[k] || k, data: b.map(x => -(x.byClass[k] || 0)), backgroundColor: PALETTE[i % PALETTE.length], stack: 'o' })).concat([{ label: 'Receipts', data: b.map(x => x.inn), backgroundColor: '#4b7f2a', stack: 'o' }]) }, options: chartOpts({ stacked: true }) };
        return cfg as unknown as ChartConfiguration;
    }, [b]);
    let c = 0;
    return (
        <>
            <Note />
            <div className="btn-row" style={{ marginBottom: '10px' }}><div className="seg">{[12, 24, 60].map(m => <button key={m} data-m={m} aria-pressed={months === m} onClick={() => setParams<'analytics'>({ months: m })}>{m} months</button>)}</div><button className="btn btn-ghost btn-sm" id="fc-exp" onClick={e => exportMenu(e.currentTarget, () => [{ name: 'Cash forecast', rows: [['Month', 'Payments', 'Receipts', 'Net'], ...b.map(x => [x.label, x.out, x.inn, x.inn - x.out])] }], 'Lease_cash_forecast', 'Lease cash-flow forecast')}>Export</button></div>
            <div className="chart-box" style={{ height: '300px' }}><ChartCanvas id="fc-chart" config={config} /></div>
            <div className="scroll-x" style={{ marginTop: '14px', maxHeight: '40vh' }}><table><thead><tr><th>Month</th><th className="num">Lease payments</th><th className="num">Lease receipts</th><th className="num">Net</th><th className="num">Cumulative net</th></tr></thead><tbody>{b.map(x => { c += x.inn - x.out; return <tr key={x.start}><td>{x.label}</td><td className="num">{fmtNum(x.out)}</td><td className="num">{fmtNum(x.inn)}</td><td className="num">{fmtNum(x.inn - x.out)}</td><td className="num">{fmtNum(c)}</td></tr>; })}</tbody>
                <tfoot><tr><td>Total</td><td className="num">{fmtNum(sum(b, x => x.out))}</td><td className="num">{fmtNum(sum(b, x => x.inn))}</td><td className="num">{fmtNum(sum(b, x => x.inn - x.out))}</td><td></td></tr></tfoot></table></div>
            <p className="note" style={{ marginTop: '8px' }}>Contractual cash flows of approved leases, including exempt leases, extension periods only where reasonably certain, and purchase options reasonably certain. Variable payments are not forecast.</p>
        </>
    );
}

function Scenario({ p }: { p: P }) {
    const sc = p.sc || 'extend', S = SCENARIOS[sc], v = p.v ?? S.param[1];
    const r = runScenario(sc, num(v)), d = (k: 'L' | 'cost' | 'cash') => r.after[k] - r.before[k];
    return (
        <>
            <Note />
            <div className="row3"><div className="fg"><label htmlFor="sc-k">Scenario</label><select id="sc-k" value={sc} onChange={e => setParams<'analytics'>({ sc: e.target.value, v: SCENARIOS[e.target.value].param[1] })}>{Object.entries(SCENARIOS).map(([k, x]) => <option key={k} value={k}>{x.label}</option>)}</select><div className="hint">{S.desc}</div></div><div className="fg"><label htmlFor="sc-v">{S.param[0]}</label><CommitInput type="number" step="any" id="sc-v" key={`${sc}|${v}`} defaultValue={v} onCommit={i => setParams<'analytics'>({ v: i.value })} /></div><div></div></div>
            <table className="stmt" style={{ maxWidth: '720px' }}><thead><tr><th>{r.affected} leases affected</th><th className="num">Current</th><th className="num">Scenario</th><th className="num">Change</th></tr></thead><tbody>
                <tr><td>{`Lease liabilities at ${fmtDate(AS_OF)}${sc === 'fx' ? '' : ' (before the change takes effect)'}`}</td><td className="num">{fmtNum(r.before.L)}</td><td className="num">{fmtNum(r.after.L)}</td><td className="num">{fmtNum(d('L'))}</td></tr>
                <tr><td>Lease cost, {r.period}</td><td className="num">{fmtNum(r.before.cost)}</td><td className="num">{fmtNum(r.after.cost)}</td><td className="num">{fmtNum(d('cost'))}</td></tr>
                <tr><td>Lease cash paid, {r.period}</td><td className="num">{fmtNum(r.before.cash)}</td><td className="num">{fmtNum(r.after.cash)}</td><td className="num">{fmtNum(d('cash'))}</td></tr></tbody></table>
            <p className="note" style={{ marginTop: '8px' }}>The scenario runs on copies of your leases; nothing is saved. For balances after the change, see the cost and cash lines; the balance sheet effect appears from the effective date.</p>
        </>
    );
}

function Sensitivity() {
    const s = rateSensitivity([-300, -200, -100, -50, 0, 50, 100, 200, 300]), base = (s.find(x => x.bp === 0) || { pv: 0 }).pv;
    return (
        <>
            <Note />
            <p style={{ marginBottom: '10px' }}>Present value of remaining lessee payments at each lease’s rate shifted by the amounts below. IFRS 16 does not remeasure recognised leases for market rate changes (except floating-rate payments); use this for renewals, new leases, covenant headroom and valuation.</p>
            <table className="stmt" style={{ maxWidth: '620px' }}><thead><tr><th>Rate shift</th><th className="num">Present value</th><th className="num">Change</th><th className="num">%</th></tr></thead><tbody>{s.map(x => <tr key={x.bp} className={x.bp === 0 ? 'sub' : ''}><td>{`${x.bp > 0 ? '+' : ''}${x.bp} bps`}</td><td className="num">{fmtNum(x.pv)}</td><td className="num">{fmtNum(x.pv - base)}</td><td className="num">{base ? ((x.pv / base - 1) * 100).toFixed(2) + '%' : '—'}</td></tr>)}</tbody></table>
        </>
    );
}

function Runoff() {
    const m = runoffMatrix(), max = Math.max(1, ...Object.values(m.rows).flat());
    return (
        <>
            <Note />
            <p style={{ marginBottom: '10px' }}>Lease liability by asset class at each financial year-end. Darker cells hold more liability. Select a cell to open those leases.</p><div className="scroll-x"><table><thead><tr><th>Asset class</th>{m.years.map(y => <th key={y.end} className="num">{y.label}</th>)}</tr></thead><tbody>
                {Object.entries(m.rows).map(([k, vals]) => <tr key={k}><td>{ASSET_CLASSES[k] || k}</td>{vals.map((v, i) => <td key={i} className="num heat" data-cls={k} style={{ background: `color-mix(in srgb, var(--accent) ${Math.round(v / max * 70)}%, transparent)`, cursor: 'pointer' }} onClick={() => go('register', { preset: 'class:' + k })}>{fmtNum(v)}</td>)}</tr>)}
                <tr className="total"><td>Total</td>{m.years.map((y, i) => <td key={y.end} className="num">{fmtNum(sum(Object.values(m.rows), r => r[i]))}</td>)}</tr></tbody></table></div>
        </>
    );
}

type AiOut = { k: 'none' } | { k: 'na' } | { k: 'busy' } | { k: 'text'; html: string } | { k: 'err'; msg: string };

async function aiReviewExceptions(ex: ExceptionItem[], out: (o: AiOut) => void) {
    const sample = await getSample(); if (!sample) { out({ k: 'na' }); return; }
    out({ k: 'busy' });
    const facts = ex.slice(0, 60).map(x => Object.assign({}, x, { lease: x.leaseId ? (() => { const l = Store.get(x.leaseId); return l ? leaseContext(l, getResult(l)) : null; })() : null }));
    try {
        const r = await sample(`You are reviewing exceptions from an IFRS 16 lease system for ${SETTINGS.entity} (Pakistan, ${SETTINGS.functionalCurrency}). Today ${AS_OF}.
For the exceptions below: group related ones, rank the five that most affect the financial statements or controls, and for each say why it matters (with IFRS 16 or IAS paragraph), what evidence to collect, and who should act. Cite lease IDs. Be concise; use a table for the top five. Do not invent figures beyond those given.
EXCEPTIONS: ${JSON.stringify(facts).slice(0, 120000)}`, { modelTier: 'default', onText: ({ text }) => out({ k: 'text', html: md(text) }) });
        out({ k: 'text', html: `${md(r.text)}<p class="note">AI review. Confirm each point before acting.</p>` });
    } catch (e) { out({ k: 'err', msg: aiErr(e) }); }
}

function AiOutput({ o }: { o: AiOut }) {
    if (o.k === 'na') return <p className="note">AI is not available in this view.</p>;
    if (o.k === 'busy') return <p className="note"><span className="spinner"></span> Reviewing…</p>;
    if (o.k === 'text') return <div className="banner"><div style={{ minWidth: 0 }} dangerouslySetInnerHTML={{ __html: o.html }} /></div>;
    if (o.k === 'err') return <p className="note">{o.msg}</p>;
    return null;
}

function Exceptions() {
    const [ai, setAi] = useState<AiOut>({ k: 'none' });
    const ex = findExceptions();
    const SEV: Record<string, string> = { high: 'bad', medium: 'pending', low: 'neutral' };
    return (
        <>
            <div className="btn-row" style={{ justifyContent: 'space-between', marginBottom: '10px' }}><p>{`${ex.length} exceptions: ${ex.filter(x => x.sev === 'high').length} high, ${ex.filter(x => x.sev === 'medium').length} medium, ${ex.filter(x => x.sev === 'low').length} low.`}</p><div className="btn-row"><button className="btn btn-ghost btn-sm" id="ex-exp" onClick={e => exportMenu(e.currentTarget, () => [{ name: 'Exceptions', rows: [['Severity', 'Area', 'Lease', 'Finding', 'Action'], ...ex.map(x => [x.sev, x.cat, x.leaseId, x.text, x.fix])] }], 'Lease_exceptions', 'Lease exceptions')}>Export</button>{can('ai.use') ? <button className="btn btn-sm" id="ex-ai" onClick={() => aiReviewExceptions(ex, setAi)}>Review with AI</button> : null}</div></div><div id="ex-ai-out"><AiOutput o={ai} /></div>
            <div className="scroll-x"><table><thead><tr><th>Severity</th><th>Area</th><th>Lease</th><th>Finding</th><th>Suggested action</th></tr></thead><tbody>{ex.length ? ex.map((x, i) => <tr key={i}><td><span className={`badge badge-${SEV[x.sev]}`}>{cap(x.sev)}</span></td><td>{x.cat}</td><td>{x.leaseId ? <button className="link" data-open={x.leaseId} onClick={() => go('detail', { id: x.leaseId })}>{x.leaseId}</button> : '—'}</td><td className="wrap">{x.text}</td><td className="wrap">{x.fix}</td></tr>) : <tr><td colSpan={5} className="empty">No exceptions.</td></tr>}</tbody></table></div>
        </>
    );
}

export function AnalyticsPage({ params: p }: ScreenProps<'analytics'>) {
    useAppState();
    const tab = p.tab || 'forecast';
    return (
        <div className="card"><div className="tabs">{TABS.map(([k, v]) => <button key={k} className={`tab ${tab === k ? 'active' : ''}`} data-t={k} onClick={() => setParams<'analytics'>({ tab: k })}>{v}</button>)}</div><div className="pad" id="an-body">
            {tab === 'forecast' ? <Forecast p={p} /> : tab === 'scenario' ? <Scenario p={p} /> : tab === 'sensitivity' ? <Sensitivity /> : tab === 'runoff' ? <Runoff /> : <Exceptions />}
        </div></div>
    );
}
