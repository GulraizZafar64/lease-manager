import { useEffect, useRef } from 'react';
import Chart from 'chart.js/auto';
import type { ChartConfiguration } from 'chart.js';
import { fmtNum, compact } from '../../utils/format';

export const PALETTE = ['#0e7c6b', '#2f5f98', '#b8741a', '#6b4fa0', '#b3261e', '#4b7f2a', '#5d6b7a', '#0b6e9c', '#a23d73', '#7a6a12'];

/** Chart colours and font follow the theme tokens, read when a chart is drawn. */
function applyThemeDefaults(): void {
    const css = getComputedStyle(document.documentElement);
    Chart.defaults.color = css.getPropertyValue('--muted').trim();
    Chart.defaults.borderColor = css.getPropertyValue('--grid').trim();
    Chart.defaults.font.family = css.getPropertyValue('--font').trim();
}

/** Shared options for the analytics and dashboard bar charts. */
export function chartOpts(o: { stacked?: boolean } = {}): ChartConfiguration<'bar'>['options'] {
    return {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } }, tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${fmtNum(c.parsed.y ?? c.parsed)}` } } },
        scales: { x: { stacked: !!o.stacked, ticks: { maxRotation: 0, autoSkip: true } }, y: { stacked: !!o.stacked, ticks: { callback: v => compact(v) } } },
    };
}

/** A Chart.js chart on a canvas. Memoise `config`: the chart is rebuilt whenever it changes. */
export function ChartCanvas({ config, id }: { config: ChartConfiguration; id?: string }) {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        if (!ref.current) return;
        applyThemeDefaults();
        const chart = new Chart(ref.current, config);
        return () => chart.destroy();
    }, [config]);
    return <canvas ref={ref} id={id} />;
}
