/* A visual summary above each report, from the same figures as its statements and for the same period.
   The statements below stay the formal record: they are what is exported and printed. */
import { useMemo, type ReactNode } from 'react';
import type { ChartConfiguration } from 'chart.js';
import { addDays } from '../../domain/engine';
import { ASSET_CLASSES } from '../../domain/settings';
import { BANDS_DETAILED, BANDS_LESSOR, BANDS_STANDARD, DISCLOSURE_CHECKLIST, currentSplit, lesseeMovement, lessorSummary, maturityTable, type Report } from '../../domain/reporting';
import { go } from '../../domain/nav';
import { useAppState } from '../../hooks/useAppState';
import { BAR, ChartCanvas, baseOptions, waterfallConfig, vizTheme, type WaterStep } from '../common/ChartCanvas';
import { StatTile, WaterfallKey } from '../common/Viz';
import { fmtNum, sum } from '../../utils/format';
import { fmtDate } from '../../utils/dates';

function Fig({ title, sub, keyEl, config, label, height = 240 }: { title: string; sub?: string; keyEl?: ReactNode; config: ChartConfiguration; label: string; height?: number }) {
    return (
        <figure className="an-fig">
            <figcaption>{title}{sub ? <span>{sub}</span> : null}{keyEl}</figcaption>
            <div className="chart-box" style={{ height: height + 'px' }}><ChartCanvas config={config} label={label} /></div>
        </figure>
    );
}

/** Bars for one series of labelled amounts (bands, cost lines). */
function barsConfig(rows: { label: string; amount: number }[], horizontal = false): ChartConfiguration {
    const t = vizTheme();
    const o = baseOptions(t, { horizontal });
    // A handful of named bands: show every label rather than skipping some
    if (!horizontal) (o.scales as { x: { ticks: { autoSkip: boolean } } }).x.ticks.autoSkip = false;
    return { type: 'bar', data: { labels: rows.map(r => r.label), datasets: [{ label: 'Amount', data: rows.map(r => r.amount), backgroundColor: t.series[0], ...BAR, maxBarThickness: horizontal ? 18 : 32 }] }, options: horizontal ? { ...o, indexAxis: 'y' } : o } as unknown as ChartConfiguration;
}

const nonZero = (steps: WaterStep[]) => steps.filter(s => s.total || Math.abs(s.value) >= 0.5);

/** Totals of a report's statements, by statement name: the value in its last row. */
const lastRowTotal = (rep: Report, name: string): number => {
    const part = rep.parts.find(p => p.kind === 'statement' && p.name === name);
    if (!part || part.kind !== 'statement') return 0;
    const v = part.rows[part.rows.length - 1]?.cells[1];
    return typeof v === 'number' ? v : 0;
};

export function ReportVisuals({ kind, from, to, rep }: { kind: string; from: string; to: string; rep: Report }) {
    const version = useAppState();
    const v = useMemo(() => {
        const mv = lesseeMovement(from, to), cls = Object.values(mv.cls), L = mv.liab, P = mv.pl;
        const opening = `At ${fmtDate(addDays(from, -1))}`, closing = `At ${fmtDate(to)}`;
        const rouSteps = nonZero([
            { label: opening, value: sum(cls, c => c.opening), total: true },
            { label: 'Additions', value: sum(cls, c => c.additions) },
            { label: 'Remeasurements', value: sum(cls, c => c.remeasure) },
            { label: 'Depreciation', value: -sum(cls, c => c.depreciation) },
            { label: 'Impairment', value: -sum(cls, c => c.impairment) },
            { label: 'Derecognised', value: -sum(cls, c => c.derecognised) },
            { label: closing, value: sum(cls, c => c.closing), total: true },
        ]);
        const liabSteps = nonZero([
            { label: opening, value: L.opening, total: true },
            { label: 'Additions', value: L.additions },
            { label: 'Remeasurements', value: L.remeasure },
            { label: 'Interest', value: L.interest },
            { label: 'Payments', value: -L.payments },
            { label: 'Derecognised', value: -L.derecognised },
            { label: closing, value: L.closing, total: true },
        ]);
        const dep = sum(Object.values(P.depByClass), x => x);
        const costRows = [
            { label: 'Depreciation', amount: dep }, { label: 'Interest', amount: P.interest }, { label: 'Short-term leases', amount: P.st },
            { label: 'Low-value leases', amount: P.lv }, { label: 'Variable payments', amount: P.variable }, { label: 'Impairment', amount: P.impairment },
        ].filter(r => Math.abs(r.amount) >= 0.5);
        const plTotal = dep + P.interest + P.st + P.lv + P.variable + P.impairment - P.gain + P.provInterest - P.depositIncome;
        const matStd = maturityTable('lessee', to, BANDS_STANDARD), matDet = maturityTable('lessee', to, BANDS_DETAILED);
        const lf = maturityTable('lessor', to, BANDS_LESSOR, 'lessor-finance'), lo = maturityTable('lessor', to, BANDS_LESSOR, 'lessor-operating');
        const t = vizTheme();
        const lessorMat = lf.total > 0 || lo.total > 0 ? {
            type: 'bar', data: { labels: BANDS_LESSOR.map(b => b.label.replace('Later than five years', 'After 5 years')), datasets: [
                ...(lf.total > 0 ? [{ label: 'Finance leases', data: lf.rows.map(r => r.amount), backgroundColor: t.series[0], ...BAR }] : []),
                ...(lo.total > 0 ? [{ label: 'Operating leases', data: lo.rows.map(r => r.amount), backgroundColor: t.series[1], ...BAR }] : [])] },
            options: baseOptions(t, { legend: true }),
        } as unknown as ChartConfiguration : null;
        return {
            mv, plTotal, costRows, split: currentSplit(to), matStd, matDet, lessor: lessorSummary(from, to), lessorMat,
            rou: rouSteps.length > 2 || Math.abs(rouSteps[0]?.value || 0) >= 0.5 ? waterfallConfig(t, rouSteps) : null,
            liab: liabSteps.length > 2 || Math.abs(liabSteps[0]?.value || 0) >= 0.5 ? waterfallConfig(t, liabSteps) : null,
            cost: costRows.length ? barsConfig(costRows, true) : null,
            rouByClass: Object.keys(mv.cls).length ? barsConfig(Object.entries(mv.cls).map(([k, c]) => ({ label: ASSET_CLASSES[k] || k, amount: c.closing })).sort((a, b) => b.amount - a.amount), true) : null,
            matStdCfg: matStd.total ? barsConfig(matStd.rows.map(r => ({ label: r.label.replace('Not later than one year', 'Within 1 year').replace('Later than one year and not later than five years', '1 to 5 years').replace('Later than five years', 'After 5 years'), amount: r.amount }))) : null,
            matDetCfg: matDet.total ? barsConfig(matDet.rows.map(r => ({ label: r.label.replace('Not later than one month', 'Within 1 month').replace('One to three months', '1 to 3 months').replace('Three months to one year', '3 to 12 months').replace('One to five years', '1 to 5 years').replace('Later than five years', 'After 5 years'), amount: r.amount }))) : null,
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [from, to, version]);

    const L = v.mv.liab, cur = v.split.total ? v.split.current / v.split.total : 0;
    const rouClosing = sum(Object.values(v.mv.cls), c => c.closing);
    const period = `${fmtDate(from)} to ${fmtDate(to)}`;
    const liabFig = v.liab ? <Fig title="Lease liabilities: movement" sub={period} keyEl={<WaterfallKey />} config={v.liab} label="Movement in lease liabilities over the period" /> : null;
    const rouFig = v.rou ? <Fig title="Right-of-use assets: movement" sub={period} keyEl={<WaterfallKey />} config={v.rou} label="Movement in right-of-use assets over the period" /> : null;
    const splitTile = <StatTile label={`Lease liabilities at ${fmtDate(to)}`} value={fmtNum(v.split.total)} sub={`Current ${fmtNum(v.split.current)} · non-current ${fmtNum(v.split.nonCurrent)}`}>
        <span className="st-meter st-meter-2" role="img" aria-label={`Current ${Math.round(cur * 100)}%, non-current ${Math.round((1 - cur) * 100)}%`}><span style={{ width: `${cur * 100}%` }} /></span></StatTile>;

    let tiles: ReactNode = null, figs: ReactNode[] = [];
    switch (kind) {
        case 'note':
            tiles = <>{splitTile}<StatTile label={`Right-of-use assets at ${fmtDate(to)}`} value={fmtNum(rouClosing)} /><StatTile label="Lease cost in the period" value={fmtNum(v.plTotal)} sub="Recognised in profit or loss" /><StatTile label="Lease payments in the period" value={fmtNum(L.payments)} sub="Principal and interest" /></>;
            figs = [liabFig, v.matStdCfg ? <Fig key="m" title="Maturity of lease liabilities" sub={`Undiscounted, at ${fmtDate(to)}`} config={v.matStdCfg} label="Undiscounted lease payments by when they fall due" /> : null];
            break;
        case 'rou':
            tiles = <><StatTile label={`At ${fmtDate(addDays(from, -1))}`} value={fmtNum(sum(Object.values(v.mv.cls), c => c.opening))} /><StatTile label="Additions" value={fmtNum(sum(Object.values(v.mv.cls), c => c.additions))} /><StatTile label="Depreciation" value={fmtNum(sum(Object.values(v.mv.cls), c => c.depreciation))} /><StatTile label={`At ${fmtDate(to)}`} value={fmtNum(rouClosing)} /></>;
            figs = [rouFig, v.rouByClass ? <Fig key="c" title="Closing balance by asset class" sub={`At ${fmtDate(to)}`} config={v.rouByClass} label="Right-of-use assets by asset class" /> : null];
            break;
        case 'liability':
            tiles = <>{splitTile}<StatTile label="Interest in the period" value={fmtNum(L.interest)} /><StatTile label="Payments in the period" value={fmtNum(L.payments)} /><StatTile label="Additions in the period" value={fmtNum(L.additions)} /></>;
            figs = [liabFig];
            break;
        case 'maturity':
            tiles = <><StatTile label="Undiscounted payments" value={fmtNum(v.matStd.total)} sub={`After ${fmtDate(to)}`} /><StatTile label="Future finance charges" value={fmtNum(v.matStd.finance)} sub="Interest still to accrue" /><StatTile label="Lease liabilities" value={fmtNum(v.matStd.carrying)} sub="Carrying amount" onClick={() => go('register', { preset: 'liability' })} /></>;
            figs = [v.matDetCfg ? <Fig key="d" title="Undiscounted payments by time band" sub={`At ${fmtDate(to)}`} config={v.matDetCfg} label="Undiscounted lease payments by time band" /> : null, v.lessorMat ? <Fig key="l" title="Lease payments receivable by year" sub="Lessor, undiscounted" config={v.lessorMat} label="Lease payments receivable by year" /> : null];
            break;
        case 'pl': {
            const principal = L.payments - L.interest;
            tiles = <><StatTile label="Recognised in profit or loss" value={fmtNum(v.plTotal)} sub={period} /><StatTile label="Principal repaid" value={fmtNum(principal)} sub="Financing activities" /><StatTile label="Interest paid" value={fmtNum(L.interest)} /><StatTile label="Additions to right-of-use assets" value={fmtNum(v.mv.additionsROU)} /></>;
            figs = [v.cost ? <Fig key="c" title="What makes up lease cost" sub={period} config={v.cost} label="Lease cost by component" height={Math.max(160, v.costRows.length * 36 + 40)} /> : null];
            break;
        }
        case 'lessor': {
            const s = v.lessor;
            tiles = <><StatTile label="Finance income" value={fmtNum(s.fin.financeIncome)} sub="Finance leases" /><StatTile label="Selling profit" value={fmtNum(s.fin.sellingProfit)} sub="Leases commencing in the period" /><StatTile label="Operating lease income" value={fmtNum(s.op.income)} /><StatTile label={`Net investment at ${fmtDate(to)}`} value={fmtNum(s.fin.closingNI)} /></>;
            figs = [v.lessorMat ? <Fig key="l" title="Lease payments receivable by year" sub={`Undiscounted, at ${fmtDate(to)}`} config={v.lessorMat} label="Lease payments receivable by year" /> : null];
            break;
        }
        case 'commitments':
            tiles = <><StatTile label="Short-term lease commitments" value={fmtNum(lastRowTotal(rep, 'Short-term lease commitments'))} sub={`After ${fmtDate(to)}`} /><StatTile label="Leases not yet commenced" value={fmtNum(lastRowTotal(rep, 'Leases committed but not yet commenced'))} sub="Undiscounted payments" /></>;
            break;
        case 'checklist': {
            const total = DISCLOSURE_CHECKLIST.length, generated = DISCLOSURE_CHECKLIST.filter(c => c.auto).length;
            tiles = <StatTile label="Disclosures prepared by the system" value={`${generated} of ${total}`} sub={`${total - generated} need your judgement or narrative`}>
                <span className="st-meter" role="img" aria-label={`${generated} of ${total} prepared`}><span style={{ width: `${generated / total * 100}%` }} /></span></StatTile>;
            break;
        }
        default: return null;
    }
    figs = figs.filter(Boolean);
    return (
        <div className="rp-viz" aria-label="Summary">
            <div className="stat-tiles">{tiles}</div>
            {figs.length ? <div className={`rp-figs${figs.length === 1 ? ' one' : ''}`}>{figs}</div> : null}
        </div>
    );
}
