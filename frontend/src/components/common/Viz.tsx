import { useState, type ReactNode } from 'react';
import type { ChartConfiguration } from 'chart.js';
import { ChartCanvas } from './ChartCanvas';
import { fmtNum } from '../../utils/format';

/** A small trend line for a stat tile: the history in a quiet ink, the latest point marked in the accent. */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
    if (values.length < 2 || values.every(v => Math.abs(v) < 0.5)) return null;
    const W = 120, H = 30, pad = 3, min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
    const pts = values.map((v, i) => [i / (values.length - 1) * W, pad + (1 - (v - min) / span) * (H - pad * 2)] as const);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
    const [ex, ey] = pts[pts.length - 1];
    return (
        <span className="spark" role="img" aria-label={label}>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                <path className="spark-area" d={`${line} L${W} ${H} L0 ${H} Z`} />
                <path className="spark-line" d={line} vectorEffect="non-scaling-stroke" />
            </svg>
            <i className="spark-end" style={{ left: `${ex / W * 100}%`, top: `${ey / H * 100}%` }} />
        </span>
    );
}

export interface Part { label: string; value: number; color: string }
const pct = (v: number, total: number) => total ? Math.round(v / total * 100) : 0;

/** Parts of one figure, each named with its amount beside the mark. */
function PartsKey({ parts }: { parts: Part[] }) {
    return <span className="mc-key">{parts.map(p => <span key={p.label} title={`${p.label}: ${fmtNum(p.value)}`}><i style={{ background: p.color }} /><span className="mc-key-l">{p.label}</span><b>{fmtNum(p.value)}</b></span>)}</span>;
}

/** Part-to-whole of one figure in two or three parts: a ring (the first part's share in the middle) and a key. */
export function Donut({ parts, label }: { parts: Part[]; label: string }) {
    const shown = parts.filter(p => p.value > 0), total = shown.reduce((s, p) => s + p.value, 0);
    if (!total) return null;
    const gap = shown.length > 1 ? 1.5 : 0; // a surface gap between segments, in hundredths of the ring
    let at = 25; // start at twelve o'clock
    return (
        <span className="mc mc-donut">
            <svg viewBox="0 0 42 42" role="img" aria-label={label}>
                <circle cx="21" cy="21" r="15.915" className="mc-track" />
                {shown.map(p => {
                    const len = p.value / total * 100, el = (
                        <circle key={p.label} cx="21" cy="21" r="15.915" style={{ stroke: p.color }} strokeDasharray={`${Math.max(len - gap, 0.5)} ${100 - Math.max(len - gap, 0.5)}`} strokeDashoffset={at}>
                            <title>{`${p.label}: ${fmtNum(p.value)} (${pct(p.value, total)}%)`}</title>
                        </circle>);
                    at -= len; return el;
                })}
                <text x="21" y="21" className="mc-donut-c">{pct(shown[0].value, total)}%</text>
            </svg>
            <PartsKey parts={parts} />
        </span>
    );
}

/** One bar split into its parts (shares of the whole), with a key giving each amount. */
export function StackBar({ parts, label }: { parts: Part[]; label: string }) {
    const shown = parts.filter(p => p.value > 0), total = shown.reduce((s, p) => s + p.value, 0);
    if (!total) return null;
    return (
        <span className="mc mc-stack">
            <span className="mc-stack-bar" role="img" aria-label={label}>
                {shown.map(p => <span key={p.label} style={{ flexGrow: p.value / total, background: p.color }} title={`${p.label}: ${fmtNum(p.value)} (${pct(p.value, total)}%)`} />)}
            </span>
            <PartsKey parts={parts} />
        </span>
    );
}

/** A column per period (one series), each giving its amount on hover. */
export function MiniColumns({ values, labels, label }: { values: number[]; labels: string[]; label: string }) {
    const max = Math.max(...values, 0);
    if (!max) return null;
    const W = 120, H = 36, gap = 2, w = (W - gap * (values.length - 1)) / values.length;
    return (
        <span className="mc mc-cols">
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
                {values.map((v, i) => {
                    const h = v > 0 ? Math.max(v / max * H, 1.5) : 1, x = i * (w + gap);
                    return <rect key={i} x={x} y={H - h} width={w} height={h} rx={Math.min(1.5, w / 2)} className={v > 0 ? 'mc-col' : 'mc-col mc-col-0'}><title>{`${labels[i]}: ${fmtNum(v)}`}</title></rect>;
                })}
            </svg>
            <span className="mc-cols-axis" aria-hidden="true"><span>{labels[0]}</span><span>{labels[labels.length - 1]}</span></span>
        </span>
    );
}

/** The largest few items as ranked bars of one colour, each named with its amount. */
export function BarList({ rows, label }: { rows: { label: string; value: number }[]; label: string }) {
    const max = Math.max(...rows.map(r => r.value), 0);
    if (!max) return null;
    return (
        <span className="mc mc-bars" role="img" aria-label={label}>
            {rows.map(r => (
                <span key={r.label} className="mc-bar" title={`${r.label}: ${fmtNum(r.value)}`}>
                    <span className="mc-bar-l">{r.label}</span><b>{fmtNum(r.value)}</b>
                    <span className="mc-bar-t"><span style={{ width: `${r.value / max * 100}%` }} /></span>
                </span>
            ))}
        </span>
    );
}

const ARROW = { up: 'M12 19V5M5 12l7-7 7 7', down: 'M12 5v14M19 12l-7 7-7-7', flat: 'M5 12h14' };

/** Change against a named earlier point. Neutral ink: for balances, up is neither good nor bad. */
export function Delta({ now, then, vs, title }: { now: number; then: number; vs: string; title?: string }) {
    if (Math.abs(then) < 0.5 && Math.abs(now) < 0.5) return null;
    const ch = then ? (now - then) / Math.abs(then) : null;
    const dir = ch === null ? 'up' : Math.abs(ch) < 0.0005 ? 'flat' : ch > 0 ? 'up' : 'down';
    const text = ch === null ? 'New' : `${ch > 0 ? '+' : ''}${(ch * 100).toFixed(Math.abs(ch) < 0.1 ? 1 : 0)}%`;
    return (
        <span className="delta" title={`${fmtNum(then)} ${title || 'at ' + vs}`}>
            <span className="delta-pill"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ARROW[dir]} /></svg>
            <b>{text}</b></span><span>{ch === null ? 'since' : 'vs'} {vs}</span>
        </span>
    );
}

export type TableCell = string | number;

/** A chart in a card, with a table of the same figures one click away (the accessible equivalent). */
export function VizCard({ id, title, sub, action, config, columns, rows, empty, height = 260, className, label, fill }: {
    id: string; title: string; sub?: ReactNode; action?: ReactNode; config: ChartConfiguration | null; columns: string[]; rows: TableCell[][];
    empty?: string; height?: number; className?: string; label?: string; /** grow with the card (at least `height`) */ fill?: boolean;
}) {
    const [table, setTable] = useState(false);
    const isEmpty = !config || !rows.length;
    return (
        <section className={`card viz-card${fill ? ' viz-fill' : ''}${className ? ' ' + className : ''}`}>
            <header className="dc-head">
                <div className="dc-title"><h3>{title}</h3>{sub ? <p className="dc-sub">{sub}</p> : null}</div>
                <div className="viz-actions">
                    {action}
                    {isEmpty ? null : <div className="seg seg-sm" role="group" aria-label="Show as">
                        <button type="button" aria-pressed={!table} data-view="chart" onClick={() => setTable(false)}>Chart</button>
                        <button type="button" aria-pressed={table} data-view="table" onClick={() => setTable(true)}>Table</button>
                    </div>}
                </div>
            </header>
            {isEmpty || !config ? <div className="dc-empty"><span>{empty || 'Nothing to show yet'}</span></div>
                : table ? <div className="viz-table scroll-x" style={{ maxHeight: height + 40 + 'px' }}><table><thead><tr>{columns.map((c, i) => <th key={i} className={i ? 'num' : ''}>{c}</th>)}</tr></thead>
                    <tbody>{rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={j ? 'num' : ''}>{typeof v === 'number' ? fmtNum(v) : v}</td>)}</tr>)}</tbody></table></div>
                : <div className="chart-box viz-chart" style={fill ? { minHeight: height + 'px' } : { height: height + 'px' }}><ChartCanvas id={id} config={config} label={label || title} /></div>}
        </section>
    );
}

/** A figure with its label: a button when it leads somewhere, otherwise plain. */
export function StatTile({ label, value, sub, tone, onClick, children }: { label: string; value: string; sub?: ReactNode; tone?: 'bad'; onClick?: () => void; children?: ReactNode }) {
    const body = <><span className="st-l">{label}</span><span className="st-v">{value}</span>{sub ? <span className="st-s">{sub}</span> : null}{children}</>;
    const cls = `stat-tile${tone ? ' st-' + tone : ''}`;
    return onClick ? <button type="button" className={cls} onClick={onClick}>{body}</button> : <div className={cls + ' st-static'}>{body}</div>;
}

/** Key for a waterfall: balances, increases, decreases. */
export function WaterfallKey() {
    return <span className="wf-key" aria-hidden="true"><span><i className="wf-total" />Balance</span><span><i className="wf-up" />Increase</span><span><i className="wf-down" />Decrease</span></span>;
}
