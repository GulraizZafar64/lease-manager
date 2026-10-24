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

const ARROW = { up: 'M12 19V5M5 12l7-7 7 7', down: 'M12 5v14M19 12l-7 7-7-7', flat: 'M5 12h14' };

/** Change against a named earlier point. Neutral ink: for balances, up is neither good nor bad. */
export function Delta({ now, then, vs, title }: { now: number; then: number; vs: string; title?: string }) {
    if (Math.abs(then) < 0.5 && Math.abs(now) < 0.5) return null;
    const ch = then ? (now - then) / Math.abs(then) : null;
    const dir = ch === null ? 'up' : Math.abs(ch) < 0.0005 ? 'flat' : ch > 0 ? 'up' : 'down';
    const text = ch === null ? 'New' : `${ch > 0 ? '+' : ''}${(ch * 100).toFixed(Math.abs(ch) < 0.1 ? 1 : 0)}%`;
    return (
        <span className="delta" title={`${fmtNum(then)} ${title || 'at ' + vs}`}>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ARROW[dir]} /></svg>
            <b>{text}</b><span>{ch === null ? 'since' : 'vs'} {vs}</span>
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
