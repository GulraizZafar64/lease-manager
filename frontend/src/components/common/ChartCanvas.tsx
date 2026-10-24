import { useEffect, useRef } from 'react';
import Chart from 'chart.js/auto';
import type { ActiveElement, ChartConfiguration, ChartEvent, LegendItem, Plugin, TooltipItem } from 'chart.js';
import { fmtNum } from '../../utils/format';

/* Series colours come from the theme (--viz-1..6): checked as a set for colour-blind separation of neighbours
   and contrast on the card surface, in light and dark. Assign them in order and never cycle: past six series,
   fold the smallest into "Other". Status colours (--ok, --bad, --warn) are kept for states, never for series. */
export const MAX_SERIES = 6;

/** Chart colours and font follow the theme tokens, read when a chart is drawn. */
function applyThemeDefaults(): void {
    const css = getComputedStyle(document.documentElement);
    Chart.defaults.color = css.getPropertyValue('--muted').trim();
    Chart.defaults.borderColor = css.getPropertyValue('--grid').trim();
    Chart.defaults.font.family = css.getPropertyValue('--font').trim();
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    Chart.defaults.animation = still ? false : { duration: 450, easing: 'easeOutQuart' };
}

export function vizTheme() {
    const css = getComputedStyle(document.documentElement), v = (n: string) => css.getPropertyValue(n).trim();
    return { series: [1, 2, 3, 4, 5, 6].map(i => v('--viz-' + i)), surface: v('--surface'), ink: v('--strong'), muted: v('--muted'), grid: v('--grid'), line: v('--line-2') };
}
export type Viz = ReturnType<typeof vizTheme>;

export const compactTick = (v: number | string): string => { const n = Number(v), a = Math.abs(n); return a >= 1e9 ? (n / 1e9).toFixed(1) + 'bn' : a >= 1e6 ? (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'm' : a >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(v); };
/** As the original: parsed.x, else parsed.y, else the parsed value itself. */
const parsedValue = (p: unknown): unknown => { const o = (p && typeof p === 'object' ? p : {}) as { x?: number | null; y?: number | null }; return o.x ?? o.y ?? p; };
export const pointer = (e: ChartEvent, els: ActiveElement[]) => { const t = e.native && e.native.target as HTMLElement | null; if (t) t.style.cursor = els.length ? 'pointer' : 'default'; };

/** Legend keys mirror the mark: a short line for line series, a rounded square for bars and areas. */
function legendLabels(chart: Chart): LegendItem[] {
    const items = Chart.defaults.plugins.legend.labels.generateLabels(chart);
    return items.map(it => {
        const ds = chart.data.datasets[it.datasetIndex ?? 0] as { type?: string; fill?: unknown; borderColor?: unknown };
        const isLine = (ds.type || (chart.config as { type?: string }).type) === 'line' && !ds.fill;
        // For lines Chart.js takes the key colour from the point marker (its surface-coloured ring), so use the line's own colour
        return isLine ? { ...it, pointStyle: 'line', lineWidth: 2, strokeStyle: ds.borderColor as string, fillStyle: ds.borderColor as string } : { ...it, pointStyle: 'rectRounded', lineWidth: 0 };
    });
}

/** Thin bars with a rounded data end, hairline grid, compact ticks, one tooltip listing every series. */
export function baseOptions(t: Viz, o: { horizontal?: boolean; stacked?: boolean; legend?: boolean; abs?: boolean } = {}) {
    const font = { size: 11.5 };
    const valueAxis = { stacked: !!o.stacked, beginAtZero: true, border: { display: false }, grid: { color: t.grid }, ticks: { callback: compactTick, maxTicksLimit: 5, font, padding: 6 } };
    const categoryAxis = { stacked: !!o.stacked, border: { display: false }, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: !o.horizontal, autoSkipPadding: 12, font, padding: 6 } };
    return {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false, axis: o.horizontal ? 'y' : 'x' },
        plugins: {
            legend: o.legend ? { position: 'top', align: 'start', labels: { generateLabels: legendLabels, sort: (a: { datasetIndex?: number }, b: { datasetIndex?: number }) => (a.datasetIndex || 0) - (b.datasetIndex || 0), usePointStyle: true, boxWidth: 10, boxHeight: 8, padding: 14, font: { size: 12 } } } : { display: false },
            tooltip: {
                backgroundColor: t.ink, titleColor: t.surface, bodyColor: t.surface, padding: 10, cornerRadius: 8, boxPadding: 4, usePointStyle: true,
                callbacks: { label: (c: TooltipItem<'bar'>) => { const v = Number(parsedValue(c.parsed)); return ` ${c.dataset.label ? c.dataset.label + ': ' : ''}${fmtNum(o.abs ? Math.abs(v) : v)}`; } },
            },
        },
        scales: o.horizontal ? { x: valueAxis, y: categoryAxis } : { x: categoryAxis, y: valueAxis },
    };
}
/** Bar marks: at most 24px thick, 4px rounded data end. */
export const BAR = { borderRadius: 4, maxBarThickness: 24, categoryPercentage: 0.7, barPercentage: 0.9 };
/** A 2px line with ringed markers that appear on hover; the area under it is a faint wash when `fill` is set. */
export function lineSeries(t: Viz, color: string, label: string, data: number[], fill = false) {
    return { type: 'line', label, data, borderColor: color, backgroundColor: fill ? color + '1a' : color, fill, borderWidth: 2, tension: 0.25, pointRadius: 0, pointHoverRadius: 5, pointHitRadius: 12, pointBackgroundColor: color, pointBorderColor: t.surface, pointBorderWidth: 2, borderCapStyle: 'round', borderJoinStyle: 'round' };
}

/** A hairline marking one category on the x axis (for example the period containing today), with a small label. */
export function markerLine(index: number, label: string): Plugin {
    return {
        id: 'markerLine',
        afterDatasetsDraw(chart) {
            if (index < 0) return;
            const x = chart.scales.x, area = chart.chartArea; if (!x || !area) return;
            const px = x.getPixelForValue(index), ctx = chart.ctx, t = vizTheme();
            ctx.save();
            ctx.strokeStyle = t.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px, area.top); ctx.lineTo(px, area.bottom); ctx.stroke();
            ctx.fillStyle = t.muted; ctx.font = `600 11px ${Chart.defaults.font.family}`; ctx.textBaseline = 'top';
            const w = ctx.measureText(label).width; ctx.fillText(label, Math.min(px + 5, area.right - w), area.top + 2);
            ctx.restore();
        },
    };
}

/** Fold everything past the first `keep` keys (by size) into one "Other" entry, so series never run out of colours. */
export function foldOther<K extends string>(totals: Record<K, number>, keep = MAX_SERIES - 1): { keys: K[]; other: K[] } {
    const sorted = (Object.keys(totals) as K[]).sort((a, b) => Math.abs(totals[b]) - Math.abs(totals[a]));
    if (sorted.length <= keep + 1) return { keys: sorted, other: [] };
    return { keys: sorted.slice(0, keep), other: sorted.slice(keep) };
}

/** A Chart.js chart on a canvas. Memoise `config`: the chart is rebuilt whenever it changes. */
export function ChartCanvas({ config, id, label }: { config: ChartConfiguration; id?: string; label?: string }) {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        if (!ref.current) return;
        applyThemeDefaults();
        const chart = new Chart(ref.current, config);
        return () => chart.destroy();
    }, [config]);
    return <canvas ref={ref} id={id} role="img" aria-label={label} />;
}
