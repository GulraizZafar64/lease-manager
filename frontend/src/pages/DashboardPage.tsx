import { useMemo, useState, type ReactNode } from 'react';
import type { ActiveElement, ChartConfiguration, ChartEvent } from 'chart.js';
import { addDays, addMonths, balanceAt, EVENT_TYPES, num, periodTotals } from '../domain/engine';
import { ASSET_CLASSES, SETTINGS } from '../domain/settings';
import { Store } from '../domain/store';
import { companyKey } from '../domain/platform';
import { getResult, isLive, leaseEnd, statusOf } from '../domain/lease';
import { audit, baseRate, Ent, FX_MISSING, fxConvert, gate, myUser, presentationCcy } from '../domain/enterprise';
import { BANDS_STANDARD, conv, currentSplit, leasesFor, lesseeMovement, maturityTable } from '../domain/reporting';
import { pendingApprovals } from '../domain/approvals';
import { paymentRows } from '../domain/payments';
import { cashForecast, findExceptions, lesseePaymentsByMonth, monthEnds, positionAt, type PositionPoint } from '../domain/analytics';
import { loadSample } from '../domain/sample';
import { go, refresh } from '../domain/nav';
import { AS_OF, SCOPE } from '../domain/state';
import { useAppState } from '../hooks/useAppState';
import { BAR, ChartCanvas, baseOptions, lineSeries, pointer, vizTheme } from '../components/common/ChartCanvas';
import { BarList, Delta, Donut, MiniColumns, Sparkline, StackBar } from '../components/common/Viz';
import { openPaymentModal } from '../components/lease/PaymentModal';
import { openEventWizard } from '../components/lease/EventWizard';
import { Modal, toast } from '../utils/uiStore';
import { fmtNum, fyBounds, money, sum, unitNote } from '../utils/format';
import { fmtDate, monthLabel } from '../utils/dates';

/* ---- Icons (24×24 outline, drawn in the current text colour) ---- */
const I = {
    plus: 'M12 5v14M5 12h14',
    upload: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M12 18v-6M9 15l3-3 3 3',
    sample: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
    sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
    filter: 'M22 3H2l8 9.46V19l4 2v-8.54z',
    calendar: 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM16 2v4M8 2v4M3 10h18',
    coins: 'M12 7a8 3 0 1 0 0-.01zM4 7v5c0 1.66 3.58 3 8 3s8-1.34 8-3V7M4 12v5c0 1.66 3.58 3 8 3s8-1.34 8-3v-5',
    scale: 'M12 3v18M7 21h10M5 7h14M5 7l-3 7a3.5 3.5 0 0 0 6 0zM19 7l-3 7a3.5 3.5 0 0 0 6 0z',
    building: 'M3 21h18M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1',
    trend: 'M3 17l6-6 4 4 8-8M14 7h7v7',
    pie: 'M21.2 15.9A10 10 0 1 1 8 2.8M22 12A10 10 0 0 0 12 2v10z',
    check: 'M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14l-3-3',
    bad: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v4M12 16h.01',
    warn: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2',
    info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 16v-4M12 8h.01',
    chevron: 'M9 18l6-6-6-6',
    lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
};
const Ic = ({ d, size = 16 }: { d: string; size?: number }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

/* ---- Empty portfolio: a slim strip above the dashboard, so the overview opens straight away ---- */
const storageNote = (): string => Store.mode === 'db' ? 'Leases are saved in this page’s shared workspace, visible to anyone you share it with.'
    : Store.mode === 'api' ? 'Leases are saved on your company’s server for everyone in the company.'
    : Store.mode === 'local' ? 'Leases are saved in this browser only; export a backup from Settings to move them.'
    : 'Leases are kept for this session only.';
function GetStarted() {
    return (
        <div className="get-started" id="get-started">
            <span className="gs-ic"><Ic d={I.plus} size={18} /></span>
            <div className="gs-text"><strong>Start your lease portfolio</strong><span>Add a lease, read one from a signed contract or spreadsheet, or load a sample portfolio to explore. {storageNote()}</span></div>
            <div className="gs-actions">
                <button className="btn btn-sm" id="e-new" {...gate('lease.edit')} onClick={() => go('entry', { mode: 'new' }, { reset: true })}><Ic d={I.plus} size={15} />Add a lease</button>
                <button className="btn btn-ghost btn-sm" id="e-import" {...gate('lease.import')} onClick={() => go('import', {}, { reset: true })}><Ic d={I.upload} size={15} />Import a contract or spreadsheet</button>
                <button className="btn btn-ghost btn-sm" id="e-sample" {...gate('admin.data')} onClick={() => void loadSample()}><Ic d={I.sample} size={15} />Load sample portfolio</button>
            </div>
        </div>
    );
}

/* ---- Alerts ---- */
type AlertKind = 'overdue' | 'due' | 'approval' | 'lease';
interface DashAlert { level: 'bad' | 'warn' | 'info'; kind: AlertKind; title: string; text: string; cta: string; open: () => void }
function buildAlerts(): DashAlert[] {
    const out: DashAlert[] = [];
    const rows = paymentRows();
    rows.filter(p => p.status === 'overdue').forEach(p => out.push({ level: 'bad', kind: 'overdue', title: 'Overdue', text: `${p.leaseId} ${p.type.toLowerCase()} of ${money(p.amount, p.currency)} due ${fmtDate(p.dueDate)} (${p.daysLate} days)`, cta: 'Review', open: () => go('detail', { id: p.leaseId, tab: 'payments', highlight: p.key }) }));
    rows.filter(p => p.status === 'due' && p.dueDate <= addDays(AS_OF, 7)).forEach(p => out.push({ level: 'warn', kind: 'due', title: 'Due soon', text: `${p.leaseId} ${money(p.amount, p.currency)} on ${fmtDate(p.dueDate)}`, cta: 'Record', open: () => openPaymentModal(p.leaseId, p.key) }));
    pendingApprovals().forEach(a => out.push({ level: 'info', kind: 'approval', title: a.kind === 'lease' ? 'New lease awaiting approval' : 'Change awaiting approval', text: a.kind === 'lease' ? `${a.lease.id} ${a.lease.name}` : `${a.lease.id} ${(EVENT_TYPES[a.event.type] || {}).label || a.event.type}`, cta: 'Review', open: () => go('detail', { id: a.lease.id, focus: 'pending' }) }));
    for (const l of Store.leases) {
        if (!isLive(l) || statusOf(l, AS_OF) !== 'active') continue;
        const end = leaseEnd(l), days = (new Date(end).getTime() - new Date(AS_OF).getTime()) / 864e5;
        if (days <= 180 && num(l.terms.extension && l.terms.extension.months) && !(l.terms.extension.certain)) out.push({ level: 'warn', kind: 'lease', title: 'Option decision', text: `${l.id} ends ${fmtDate(end)} and has a ${l.terms.extension.months}-month extension option. Reassess whether it is reasonably certain (16.20).`, cta: 'Reassess', open: () => openEventWizard(l, 'reassess-term') });
        else if (days <= 90) out.push({ level: 'info', kind: 'lease', title: 'Ending', text: `${l.id} ends ${fmtDate(end)}`, cta: 'Open', open: () => go('detail', { id: l.id }) });
        if (l.role === 'lessee' && l.terms.exemption === 'none' && !num(l.terms.discountRate) && l.terms.rateBasis !== 'solve') out.push({ level: 'bad', kind: 'lease', title: 'No discount rate', text: `${l.id} has no discount rate, so its liability is undiscounted.`, cta: 'Edit', open: () => go('entry', { mode: 'edit', id: l.id }) });
    }
    return out;
}
const ALERT_FILTERS: [key: 'all' | AlertKind, label: string][] = [['all', 'All'], ['overdue', 'Overdue'], ['due', 'Due soon'], ['approval', 'Approvals'], ['lease', 'Leases']];
const ALERTS_SHOWN = 6;

/* ---- Charts ----
   Series colours, axes and tooltips come from the shared chart theme (components/common/ChartCanvas). */
const bar = BAR;

interface DashChart { config: ChartConfiguration; empty: boolean }
function dashCharts(): { cls: DashChart; mat: DashChart; profile: DashChart } {
    const t = vizTheme();
    const byClass: Record<string, number> = {};
    for (const l of leasesFor({ role: 'lessee' })) { const r = getResult(l); if (!r || r.mode !== 'lessee') continue; byClass[l.assetClass] = (byClass[l.assetClass] || 0) + conv(l, balanceAt(r, AS_OF).L); }
    const keys = Object.keys(byClass).filter(k => byClass[k] > 0.5).sort((a, b) => byClass[b] - byClass[a]);
    const cls = {
        type: 'bar', data: { labels: keys.map(k => ASSET_CLASSES[k] || k), datasets: [{ label: 'Lease liabilities', data: keys.map(k => byClass[k]), backgroundColor: t.series[0], ...bar }] },
        options: { ...baseOptions(t, { horizontal: true }), indexAxis: 'y', onClick: (_e: ChartEvent, els: ActiveElement[]) => { if (els.length) go('register', { preset: 'class:' + keys[els[0].index] }); }, onHover: pointer },
    };
    const m = maturityTable('lessee', AS_OF, BANDS_STANDARD);
    const mat = {
        type: 'bar', data: { labels: ['Within 1 year', '1 to 5 years', 'After 5 years'], datasets: [{ label: 'Undiscounted payments', data: m.rows.map(r => r.amount), backgroundColor: t.series[0], ...bar }] },
        options: { ...baseOptions(t), onClick: () => go('reports', { report: 'maturity' }, { reset: true }), onHover: (e: ChartEvent) => { const el = e.native && e.native.target as HTMLElement | null; if (el) el.style.cursor = 'pointer'; } },
    };
    // Expense profile by financial year: IFRS 16 cost is front-loaded relative to cash rent
    const fys: { start: string; end: string; label: string }[] = [], f0 = fyBounds(AS_OF);
    for (let i = -1; i < 4; i++) { const s = addMonths(f0.start, 12 * i); fys.push({ start: s, end: addDays(addMonths(s, 12), -1), label: fyBounds(s).label }); }
    const dep: number[] = [], int: number[] = [], cash: number[] = [];
    for (const y of fys) {
        let d = 0, it = 0, c = 0;
        for (const l of leasesFor({ role: 'lessee' })) {
            const r = getResult(l); if (!r) continue;
            const p = periodTotals(r, y.start, y.end);
            d += conv(l, p.dep + p.expense); it += conv(l, p.int);
            c += conv(l, r.mode === 'exempt' ? p.cash : p.payAdv + p.payArr + (y.start <= l.terms.commencement && l.terms.commencement <= y.end ? (r.mode === 'lessee' ? r.initial.paidAtCommencement : 0) || 0 : 0));
        }
        dep.push(d); int.push(it); cash.push(c);
    }
    const profile = {
        type: 'bar', data: {
            labels: fys.map(y => y.label), datasets: [
                // The 2px top edge in the card colour separates the stacked segments
                { label: 'Depreciation and exempt lease expense', data: dep, backgroundColor: t.series[0], ...bar, borderRadius: 0, borderColor: t.surface, borderWidth: { top: 2 }, borderSkipped: 'start', stack: 'cost', order: 1 },
                { label: 'Interest', data: int, backgroundColor: t.series[1], ...bar, stack: 'cost', order: 1 },
                { label: 'Cash paid', data: cash, type: 'line', borderColor: t.series[2], backgroundColor: t.series[2], borderWidth: 2, pointRadius: 4, pointHoverRadius: 5, pointBorderColor: t.surface, pointBorderWidth: 2, tension: 0.25, order: 0 }],
        },
        options: baseOptions(t, { stacked: true, legend: true }),
    };
    const zero = (xs: number[]) => xs.every(x => Math.abs(x) < 0.5);
    return {
        cls: { config: cls as unknown as ChartConfiguration, empty: !keys.length },
        mat: { config: mat as unknown as ChartConfiguration, empty: zero(m.rows.map(r => r.amount)) },
        profile: { config: profile as unknown as ChartConfiguration, empty: zero(dep) && zero(int) && zero(cash) },
    };
}

function forecastChart(fcast: ReturnType<typeof cashForecast>): DashChart {
    const t = vizTheme();
    const config = {
        type: 'bar', data: { labels: fcast.map(x => x.label.slice(0, 3)), datasets: [
            { label: 'Payments', data: fcast.map(x => -x.out), backgroundColor: t.series[0], ...bar, maxBarThickness: 16 },
            { label: 'Receipts', data: fcast.map(x => x.inn), backgroundColor: t.series[1], ...bar, maxBarThickness: 16 }] },
        options: baseOptions(t, { stacked: true, legend: true }),
    };
    return { config: config as unknown as ChartConfiguration, empty: fcast.every(x => !x.out && !x.inn) };
}

/** Balances at each month-end in the chosen history: one axis, all in the presentation currency. */
function trendChart(pts: PositionPoint[]): DashChart {
    const t = vizTheme(), last = pts.length - 1, hasNI = pts.some(p => Math.abs(p.NI) >= 0.5);
    const datasets = [
        lineSeries(t, t.series[0], 'Lease liabilities', pts.map(p => p.L), true),
        lineSeries(t, t.series[1], 'Right-of-use assets', pts.map(p => p.A)),
        ...(hasNI ? [lineSeries(t, t.series[2], 'Net investment in leases', pts.map(p => p.NI))] : []),
    ];
    const config = {
        type: 'line', data: { labels: pts.map((p, i) => i === last ? fmtDate(p.date) : monthLabel(p.date)), datasets },
        options: baseOptions(t, { legend: true }),
    };
    return { config: config as unknown as ChartConfiguration, empty: pts.every(p => Math.abs(p.L) < 0.5 && Math.abs(p.A) < 0.5 && Math.abs(p.NI) < 0.5) };
}

/** Lease cost as the P&L report totals it: depreciation, interest, exempt and variable lease expense, impairment, less gains. */
function leaseCost(from: string, to: string): number {
    const m = lesseeMovement(from, to);
    return sum(Object.values(m.pl.depByClass), x => x) + m.pl.interest + m.pl.st + m.pl.lv + m.pl.variable - m.pl.gain + m.pl.impairment;
}

/* ---- Balance history shown on the dashboard (per user, on this browser) ---- */
type Range = 12 | 36 | 60;
const RANGES: [Range, string][] = [[12, '1 year'], [36, '3 years'], [60, '5 years']];
const rangeKey = () => companyKey('dashRange.' + Store.actorId());
const savedRange = (): Range => { try { const v = Number(localStorage.getItem(rangeKey())); return v === 36 || v === 60 ? v : 12; } catch { return 12; } };

/* ---- Widgets (per-user preferences on this browser) ---- */
const WIDGETS: [key: string, label: string][] = [['position', 'Position'], ['trend', 'Balances over time'], ['charts', 'Charts'], ['attention', 'Attention and expiries'], ['forecast', 'Cash forecast, 12 months'], ['ops', 'Operations status'], ['fx', 'Currency exposure']];
type WidgetPrefs = Record<string, boolean>;
const widgetPrefs = (): WidgetPrefs => { try { return JSON.parse(localStorage.getItem(companyKey('widgets.' + Store.actorId())) || '{}') as WidgetPrefs; } catch { return {}; } };

function CustomiseDashboard({ hid }: { hid: WidgetPrefs }) {
    const [shown, setShown] = useState<Record<string, boolean>>(() => Object.fromEntries(WIDGETS.map(([k]) => [k, !hid[k]])));
    const apply = () => {
        const h: WidgetPrefs = {};
        WIDGETS.forEach(([k]) => { if (!shown[k]) h[k] = true; });
        try { localStorage.setItem(companyKey('widgets.' + Store.actorId()), JSON.stringify(h)); } catch { /* storage unavailable */ }
        Modal.close(); refresh();
    };
    return (
        <>
            <p className="note">Choose what you see. Saved for you on this browser.</p>
            {WIDGETS.map(([k, v]) => <label key={k} className="check" style={{ marginTop: '8px' }}><input type="checkbox" data-wk={k} checked={shown[k]} onChange={e => setShown(s => ({ ...s, [k]: e.target.checked }))} />{' ' + v}</label>)}
            <div className="form-actions"><button className="btn" id="w-ok" onClick={apply}>Apply</button></div>
        </>
    );
}

/* ---- Read-only access banner ---- */
async function requestAccess(): Promise<void> {
    const note = prompt('What do you need access for? (optional)') || '';
    try { await Ent.requests.save({ id: Store.actorId(), at: new Date().toISOString(), note }); void audit('access.request', note || 'Access requested'); toast('Request sent'); refresh(); } catch { /* ignored, as in the original */ }
}
function Pending0() {
    if (Store.mode !== 'db' || myUser() || Ent.isOwner) return null;
    const asked = Ent.requests.get(Store.actorId());
    return (
        <div className="banner" style={{ margin: 0 }}>
            <div><strong>You have read-only access</strong><p>{asked ? 'Your access request is with the administrators.' : 'Ask an administrator for a role to work on leases.'}</p></div>
            {asked ? null : <div className="banner-actions"><button className="btn btn-sm" onClick={() => void requestAccess()}>Request access</button></div>}
        </div>
    );
}

const plural = (n: number, one: string, many: string) => n + (n === 1 ? one : many);

/* ---- Building blocks ---- */
/** A headline figure: label and icon, the value, its recent history, then the change and a note. `hue` is the series
    colour the same measure has in the charts (the three balances), so the card and its line read as one. */
function Kpi({ k, icon, label, value, sub, tone, hue, delta, spark, onOpen, children }: { k: string; icon: string; label: string; value: string; sub: ReactNode; tone?: 'warn'; hue?: 1 | 2 | 3; delta?: ReactNode; spark?: ReactNode; onOpen: (k: string) => void; children?: ReactNode }) {
    return (
        <button className={`kpi${tone ? ' kpi-' + tone : ''}${hue ? ' kpi-hue-' + hue : ''}`} data-go={k} onClick={() => onOpen(k)}>
            <span className="kpi-head"><span className="kpi-l">{label}</span><span className="kpi-ic"><Ic d={icon} size={20} /></span></span>
            <span className="kpi-v">{value}</span>
            <span className="kpi-body">{spark}{children}</span>
            <span className="kpi-foot">{delta ? <span className="kpi-d">{delta}</span> : null}<span className="kpi-s">{sub}</span></span>
        </button>
    );
}

function Panel({ title, sub, action, className, widget, hidden, children }: { title: string; sub?: ReactNode; action?: ReactNode; className?: string; widget?: string; hidden?: boolean; children: ReactNode }) {
    return (
        <section className={`card dash-card${className ? ' ' + className : ''}`} data-widget={widget} hidden={hidden}>
            <header className="dc-head"><div className="dc-title"><h3>{title}</h3>{sub ? <p className="dc-sub">{sub}</p> : null}</div>{action}</header>
            {children}
        </section>
    );
}

function ChartBlock({ id, chart, empty, height }: { id: string; chart: DashChart; empty: string; height?: number }) {
    return (
        <div className={`chart-box dc-chart${chart.empty ? ' is-empty' : ''}`} style={height && !chart.empty ? { minHeight: height + 'px' } : undefined}>
            {chart.empty ? <div className="dc-empty"><Ic d={I.trend} size={22} /><span>{empty}</span></div> : <ChartCanvas id={id} config={chart.config} />}
        </div>
    );
}

const PanelLink = ({ id, label, onClick }: { id?: string; label: string; onClick: () => void }) => (
    <button type="button" className="dc-link" id={id} onClick={onClick}>{label}<Ic d={I.chevron} size={14} /></button>
);

/* ---- Dashboard (figures are zero until there are leases) ---- */
function Dashboard({ notice }: { notice: ReactNode }) {
    const version = useAppState();
    const [attFilter, setAttFilter] = useState<'all' | AlertKind>('all');
    const [allAlerts, setAllAlerts] = useState(false);
    const fy = fyBounds(AS_OF);
    const split = currentSplit(AS_OF);
    let rou = 0, ni = 0;
    const rouByClass: Record<string, number> = {};
    for (const l of leasesFor({})) {
        const r = getResult(l); if (!r) continue; const b = balanceAt(r, AS_OF);
        if (r.mode === 'lessee') { rou += conv(l, b.A); rouByClass[l.assetClass] = (rouByClass[l.assetClass] || 0) + conv(l, b.A); }
        if (r.mode === 'lessor-finance') ni += conv(l, b.L);
    }
    // The three largest classes, the rest together
    const rouRanked = Object.entries(rouByClass).filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1]);
    const rouRows = rouRanked.slice(0, rouRanked.length > 4 ? 3 : 4).map(([k, v]) => ({ label: ASSET_CLASSES[k] || k, value: v }))
        .concat(rouRanked.length > 4 ? [{ label: 'Other', value: sum(rouRanked.slice(3), x => x[1]) }] : []);
    const plYTD = leaseCost(fy.start, AS_OF);
    const mat = maturityTable('lessee', AS_OF, BANDS_STANDARD);
    const pend = pendingApprovals();
    const expiring = Store.leases.filter(l => isLive(l) && ['active'].includes(statusOf(l, AS_OF)) && leaseEnd(l) <= addMonths(AS_OF, 12));
    const alerts = buildAlerts();
    const charts = useMemo(dashCharts, [version]);
    const [range, setRange] = useState<Range>(savedRange);
    const pickRange = (r: Range) => { setRange(r); try { localStorage.setItem(rangeKey(), String(r)); } catch { /* storage unavailable */ } };
    // Month-end balances over the chosen history, payments by month around today, and lease cost by month this year
    const hist = useMemo(() => monthEnds(AS_OF, range).map(positionAt), [version, range]); // eslint-disable-line react-hooks/exhaustive-deps
    const trend = useMemo(() => trendChart(hist), [hist]);
    const pays = useMemo(() => ({ next: lesseePaymentsByMonth(AS_OF, 12), prev: lesseePaymentsByMonth(AS_OF, -12) }), [version]); // eslint-disable-line react-hooks/exhaustive-deps
    const cost = useMemo(() => {
        const months: number[] = [];
        for (let s = fy.start; s <= AS_OF; s = addMonths(s, 1)) { const e = addDays(addMonths(s, 1), -1); months.push(leaseCost(s, e < AS_OF ? e : AS_OF)); }
        // This year's cost by kind, as leaseCost totals it
        const pl = lesseeMovement(fy.start, AS_OF).pl;
        const parts = { dep: sum(Object.values(pl.depByClass), x => x), interest: pl.interest, other: pl.st + pl.lv + pl.variable + pl.impairment - pl.gain };
        return { months, parts, lastYear: leaseCost(addMonths(fy.start, -12), addMonths(AS_OF, -12)) };
    }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
    const h0 = hist[0], since = fmtDate(h0.date);
    const sparkLabel = (what: string, xs: number[], when: string) => `${what} ${when}: from ${fmtNum(xs[0])} to ${fmtNum(xs[xs.length - 1])}`;

    // Enterprise additions
    const P = presentationCcy(), ex = findExceptions(), fcast = cashForecast(12);
    const unrec = sum(Ent.bank.items, s => s.lines.filter(x => x.status === 'unmatched' && !x.duplicate).length);
    const exposure: Record<string, number> = {};
    Store.leases.filter(l => isLive(l) && l.role === 'lessee').forEach(l => { const r = getResult(l); if (r && r.mode === 'lessee') exposure[l.currency] = (exposure[l.currency] || 0) + balanceAt(r, AS_OF).L; });
    const hid = widgetPrefs();
    const fcChart = useMemo(() => forecastChart(fcast), [version]); // eslint-disable-line react-hooks/exhaustive-deps
    const fxTotal = sum(Object.entries(exposure), ([c, v]) => baseRate(c) ? fxConvert(v, c) : 0);
    const fxNote = FX_MISSING.size ? `Rates missing for ${[...FX_MISSING].join(', ')}: those amounts are excluded from totals.` : `Translated to ${P} at rates in Administration.`;

    const goPos = (k: string) => {
        if (k === 'approvals') return go('approvals', {}, { reset: true });
        if (k === 'maturity') return go('reports', { report: 'maturity' }, { reset: true });
        if (k === 'pl') return go('reports', { report: 'pl' }, { reset: true });
        go('register', { preset: k });
    };
    const counts = Object.fromEntries(ALERT_FILTERS.map(([k]) => [k, k === 'all' ? alerts.length : alerts.filter(a => a.kind === k).length]));
    const filtered = alerts.map((a, i) => ({ a, i })).filter(x => attFilter === 'all' || x.a.kind === attFilter);
    const shownAlerts = allAlerts ? filtered : filtered.slice(0, ALERTS_SHOWN);
    const currentShare = split.total ? Math.max(0, Math.min(1, split.current / split.total)) : 0;
    const daysTo = (d: string) => Math.round((new Date(d).getTime() - new Date(AS_OF).getTime()) / 864e5);
    const ops: [key: string, label: string, count: number | string, open: (() => void) | null, attention: boolean][] = [
        ['analytics:exceptions', 'Exceptions (high)', `${ex.length} (${ex.filter(x => x.sev === 'high').length})`, () => go('analytics', { tab: 'exceptions' }, { reset: true }), ex.some(x => x.sev === 'high')],
        ['bank', 'Unreconciled bank lines', unrec, () => go('bank', {}, { reset: true }), unrec > 0],
        ['batches', 'Payment batches awaiting approval', Ent.batches.items.filter(b => b.status === 'pending').length, () => go('batches', {}, { reset: true }), Ent.batches.items.some(b => b.status === 'pending')],
        ['erp', 'ERP files not confirmed posted', Ent.exports.items.filter(x => x.status === 'generated').length, () => go('erp', {}, { reset: true }), Ent.exports.items.some(x => x.status === 'generated')],
        ['reports:drafts', 'AI drafts awaiting approval', Ent.drafts.items.filter(x => x.status !== 'final').length, () => go('reports', { report: 'drafts' }, { reset: true }), Ent.drafts.items.some(x => x.status !== 'final')],
    ];

    return (
        <div className="dash">
            <div className="dash-pending"><Pending0 /></div>
            <div className="dash-bar">
                <div className="dash-context" title={`Balances converted at the rates in Administration. ${fy.label} runs ${fmtDate(fy.start)} to ${fmtDate(fy.end)}.`}>
                    <span className="ctx-chip"><Ic d={I.calendar} size={14} />Balances at <b>{fmtDate(AS_OF)}</b></span>
                    <span className="ctx-chip"><Ic d={I.coins} size={14} /><b>{P}</b>{unitNote()}</span>
                    <span className="ctx-chip"><b>{fy.label}</b>{fmtDate(fy.start)} to {fmtDate(fy.end)}</span>
                    <span className="ctx-range" role="group" aria-label="Balance history shown"><span>History</span><span className="seg seg-sm">{RANGES.map(([r, label]) => <button key={r} type="button" data-range={r} aria-pressed={range === r} onClick={() => pickRange(r)}>{label}</button>)}</span></span>
                    <span className="ctx-hint">Select a figure to see the leases behind it.</span>
                </div>
                <div className="dash-actions">
                    <button className="btn btn-ghost btn-sm" id="w-cust" onClick={() => Modal.open('Customise dashboard', <CustomiseDashboard hid={hid} />)}><Ic d={I.sliders} size={15} />Customise</button>
                    {notice ? null : <>
                        <button className="btn btn-ghost btn-sm" id="d-import" {...gate('lease.import')} onClick={() => go('import', { fresh: true }, { reset: true })}><Ic d={I.upload} size={15} />Import</button>
                        <button className="btn btn-sm" id="d-new" {...gate('lease.edit')} onClick={() => go('entry', { mode: 'new' }, { reset: true })}><Ic d={I.plus} size={15} />Add a lease</button>
                    </>}
                </div>
            </div>
            {notice}

            <div className="dash-kpis" data-widget="position" hidden={!!hid.position}>
                <Kpi k="liability" hue={1} icon={I.scale} label="Lease liabilities" value={fmtNum(split.total)} onOpen={goPos}
                    delta={<Delta now={split.total} then={h0.L} vs={since} />} sub="Current is due within 12 months"
                    spark={<Donut label={`Lease liabilities: current ${fmtNum(split.current)} (${Math.round(currentShare * 100)}%), non-current ${fmtNum(split.nonCurrent)}`}
                        parts={[{ label: 'Current', value: split.current, color: 'var(--viz-1)' }, { label: 'Non-current', value: split.nonCurrent, color: 'color-mix(in srgb, var(--viz-1) 35%, var(--surface-3))' }]} />} />
                <Kpi k="rou" hue={2} icon={I.building} label="Right-of-use assets" value={fmtNum(rou)} sub="Net of depreciation, by asset class" onOpen={goPos}
                    delta={<Delta now={rou} then={h0.A} vs={since} />} spark={<BarList rows={rouRows} label={`Right-of-use assets by asset class: ${rouRows.map(r => `${r.label} ${fmtNum(r.value)}`).join(', ')}`} />} />
                <Kpi k="ni" hue={3} icon={I.trend} label="Net investment in leases" value={fmtNum(ni)} sub="Lessor finance leases" onOpen={goPos}
                    delta={<Delta now={ni} then={h0.NI} vs={since} />} spark={<Sparkline values={hist.map(p => p.NI)} label={sparkLabel('Net investment', hist.map(p => p.NI), 'at month-ends since ' + since)} />} />
                <Kpi k="maturity" icon={I.calendar} label="Payments, next 12 months" value={fmtNum(mat.rows[0].amount)} sub="Undiscounted, recognised leases" onOpen={goPos}
                    delta={<Delta now={sum(pays.next, x => x.amount)} then={sum(pays.prev, x => x.amount)} vs="past year" title="in the 12 months before today" />} spark={<MiniColumns values={pays.next.map(x => x.amount)} labels={pays.next.map(x => monthLabel(x.to))} label={sparkLabel('Payments due', pays.next.map(x => x.amount), 'by month over the next 12 months')} />} />
                <Kpi k="pl" icon={I.pie} label={`Lease cost, ${fy.label} to date`} value={fmtNum(plYTD)} sub="Other: short-term, low-value and variable expense, impairment, less gains" onOpen={goPos}
                    delta={<Delta now={plYTD} then={cost.lastYear} vs="last year" title="in the same period last year" />}
                    spark={<StackBar label={`Lease cost this year: depreciation ${fmtNum(cost.parts.dep)}, interest ${fmtNum(cost.parts.interest)}, other ${fmtNum(cost.parts.other)}`}
                        parts={[{ label: 'Depreciation', value: cost.parts.dep, color: 'var(--viz-1)' }, { label: 'Interest', value: cost.parts.interest, color: 'var(--viz-2)' }, { label: 'Other', value: cost.parts.other, color: 'var(--viz-3)' }]} />} />
                <Kpi k="approvals" icon={I.check} label="Awaiting approval" value={String(pend.length)} tone={pend.length ? 'warn' : undefined} onOpen={goPos}
                    sub={`${plural(pend.filter(p => p.kind === 'event').length, ' change', ' changes')}, ${plural(pend.filter(p => p.kind === 'lease').length, ' new lease', ' new leases')}`} />
            </div>

            <div className="dash-trend" data-widget="trend" hidden={!!hid.trend}>
                <Panel title="Balances over time" sub={`Month-end balances since ${since}, ${P}${unitNote()}. From the leases as recorded today.`} className="dc-wide"
                    action={<PanelLink label="Run-off" onClick={() => go('analytics', { tab: 'runoff' }, { reset: true })} />}>
                    <ChartBlock id="c-trend" chart={trend} empty="No balances in this period" height={260} />
                </Panel>
            </div>

            <div className="dash-charts" data-widget="charts" hidden={!!hid.charts}>
                <Panel title="Liabilities by asset class" sub={`${P}${unitNote()}, at ${fmtDate(AS_OF)}`} action={<PanelLink label="Register" onClick={() => go('register', {}, { reset: true })} />}>
                    <ChartBlock id="c-class" chart={charts.cls} empty="No lessee liabilities yet" />
                </Panel>
                <Panel title="Maturity of lease payments" sub="Undiscounted, by when they fall due" action={<PanelLink label="Report" onClick={() => go('reports', { report: 'maturity' }, { reset: true })} />}>
                    <ChartBlock id="c-mat" chart={charts.mat} empty="No future lease payments" />
                </Panel>
                <Panel title="Lease cost against cash, by year" sub="IFRS 16 cost is front-loaded relative to cash rent" className="dc-wide">
                    <ChartBlock id="c-profile" chart={charts.profile} empty="No lease cost or payments to show" />
                </Panel>
            </div>

            <div className="dash-attn" data-widget="attention" hidden={!!hid.attention}>
                <Panel title="Needs attention" sub={`${alerts.length} item${alerts.length === 1 ? '' : 's'}`} className="dc-attention"
                    action={alerts.length ? <div className="att-filters" role="group" aria-label="Show">{ALERT_FILTERS.filter(([k]) => k === 'all' || counts[k]).map(([k, label]) => (
                        <button key={k} type="button" className="att-filter" aria-pressed={attFilter === k} onClick={() => { setAttFilter(k); setAllAlerts(false); }}>{label}<span>{counts[k]}</span></button>
                    ))}</div> : null}>
                    {shownAlerts.length ? <div className="att-list">{shownAlerts.map(({ a, i }) => (
                        <button key={i} className={`att att-${a.level}`} data-alert={i} title={`${a.title}: ${a.text}`} onClick={() => a.open()}>
                            <span className="att-ic"><Ic d={I[a.level]} size={16} /></span>
                            <span className="att-body"><span className="att-t">{a.title}</span><span className="att-x">{a.text}</span></span>
                            <span className="att-cta">{a.cta}<Ic d={I.chevron} size={14} /></span>
                        </button>
                    ))}</div> : <div className="dc-empty dc-empty-sm"><Ic d={I.check} size={22} /><span>Nothing needs attention.</span></div>}
                    {filtered.length > ALERTS_SHOWN ? <button type="button" className="att-more" id="att-more" onClick={() => setAllAlerts(v => !v)}>{allAlerts ? 'Show fewer' : `Show all ${filtered.length}`}</button> : null}
                </Panel>
                <Panel title="Ending in the next 12 months" sub={`${expiring.length} lease${expiring.length === 1 ? '' : 's'}`} action={<PanelLink id="d-reg" label="Register" onClick={() => go('register', {}, { reset: true })} />}>
                    {expiring.length ? <div className="exp-list">{expiring.sort((a, b) => leaseEnd(a).localeCompare(leaseEnd(b))).map(l => {
                        const r = getResult(l), end = leaseEnd(l), days = daysTo(end), ext = num(l.terms.extension && l.terms.extension.months);
                        return (
                            <button key={l.id} className="exp-row" data-open={l.id} onClick={() => go('detail', { id: l.id })}>
                                <span className={`exp-days${days <= 90 ? ' soon' : ''}`}><b>{days}</b>days</span>
                                <span className="exp-main"><b>{l.id}</b><span>{l.name}</span></span>
                                <span className="exp-meta"><span>{fmtDate(end)}</span>{ext ? <span className="badge badge-info">Extension {l.terms.extension.months} months</span> : null}</span>
                                <span className="exp-amt">{r && r.mode !== 'exempt' ? fmtNum(balanceAt(r, AS_OF).L) : '—'}</span>
                            </button>
                        );
                    })}</div> : <div className="dc-empty dc-empty-sm"><Ic d={I.calendar} size={22} /><span>No leases end in the next 12 months.</span></div>}
                </Panel>
            </div>

            <div className="dash-bottom" data-widget-row="">
                <Panel title="Cash flows, next 12 months" sub={`Lease payments and receipts, ${P}${unitNote()}`} widget="forecast" hidden={!!hid.forecast}
                    action={<PanelLink id="w-fc" label="Forecast" onClick={() => go('analytics', { tab: 'forecast' }, { reset: true })} />}>
                    {hid.forecast ? <div className="chart-box dc-chart"><canvas id="c-fc" /></div> : <ChartBlock id="c-fc" chart={fcChart} empty="No lease cash flows in the next 12 months" height={220} />}
                </Panel>
                <Panel title="Operations" sub="Open items across the team" widget="ops" hidden={!!hid.ops}>
                    <div className="op-list">
                        {ops.map(([key, label, count, open, attention]) => (
                            <button key={key} type="button" className="op-row" data-go2={key} onClick={() => open && open()}>
                                <span>{label}</span><span className={`op-count${attention ? ' on' : ''}`}>{count}</span><Ic d={I.chevron} size={14} />
                            </button>
                        ))}
                        <div className="op-row op-static"><span><Ic d={I.lock} size={14} />Period locked to</span><span className={`badge ${SETTINGS.lockedThrough ? 'badge-neutral' : 'badge-ok'}`}>{SETTINGS.lockedThrough ? fmtDate(SETTINGS.lockedThrough) : 'Open'}</span></div>
                    </div>
                </Panel>
                <Panel title="Liabilities by currency" sub={fxNote} widget="fx" hidden={!!hid.fx}>
                    <div className="fx-list">
                        {Object.keys(exposure).length ? Object.entries(exposure).map(([c, v]) => {
                            const share = baseRate(c) && fxTotal ? fxConvert(v, c) / fxTotal : 0;
                            return (
                                <div key={c} className="fx-row">
                                    <span className="fx-ccy">{c}</span>
                                    <span className="fx-amt"><b>{fmtNum(v)}</b>{baseRate(c) ? <span>{`${P} ${fmtNum(fxConvert(v, c))}`}</span> : <span className="badge badge-bad">No rate</span>}</span>
                                    <span className="fx-share">{baseRate(c) ? `${Math.round(share * 100)}%` : ''}</span>
                                    <span className="fx-bar"><span style={{ width: `${share * 100}%` }} /></span>
                                </div>
                            );
                        }) : <div className="dc-empty dc-empty-sm"><Ic d={I.coins} size={22} /><span>No lessee liabilities</span></div>}
                    </div>
                </Panel>
            </div>
        </div>
    );
}

export function DashboardPage() {
    useAppState();
    const notice = Store.leases.length ? null : Store.all.length
        ? <div className="get-started gs-quiet"><span className="gs-ic"><Ic d={I.filter} size={18} /></span><div className="gs-text"><strong>No leases in this view</strong><span>{SCOPE.entity ? `The entity filter (${SCOPE.entity}) has no leases.` : 'Your entity access does not include any leases.'}</span></div></div>
        : <GetStarted />;
    return <Dashboard notice={notice} />;
}
