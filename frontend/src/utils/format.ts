import { addDays, addMonths, num } from '../domain/engine';
import { SETTINGS } from '../domain/settings';

export const cap = (s: string | null | undefined): string => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
export const uid = (p = ''): string => p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
export const deepClone = <T>(o: T): T => JSON.parse(JSON.stringify(o));
export const sum = <T>(arr: readonly T[], f: (x: T) => unknown): number => arr.reduce((t, x) => t + (Number(f(x)) || 0), 0);

export function fmtNum(n: unknown, dp = 0): string {
    if (n === null || n === undefined || n === '' || isNaN(n as number)) return '—';
    const v = Number(n) / (dp === 0 ? (SETTINGS.displayUnit || 1) : 1);
    const neg = v < 0, a = Math.abs(v);
    const s = SETTINGS.numberGrouping === 'south-asian'
        ? a.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })
        : a.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    if (s === '0' || /^0\.0+$/.test(s)) return '0';
    return neg ? `(${s})` : s;
}
export const money = (n: number | null | undefined, ccy?: string): string => n === null || n === undefined ? '—' : (ccy ? ccy + ' ' : '') + fmtNum(n);
export const pct = (n: unknown, dp = 2): string => (n === null || n === undefined || isNaN(n as number)) ? '—' : Number(n).toFixed(dp) + '%';
export const unitNote = (): string => SETTINGS.displayUnit === 1000 ? ' in thousands' : SETTINGS.displayUnit === 1e6 ? ' in millions' : '';

/** Financial year containing a date (FY named by the calendar year it ends in). */
export function fyBounds(date: string): { start: string; end: string; label: string } {
    const m = num(SETTINGS.fyEndMonth) || 12, d = new Date(date + 'T00:00:00Z');
    let endYear = d.getUTCFullYear();
    if (d.getUTCMonth() + 1 > m) endYear += 1;
    const end = new Date(Date.UTC(endYear, m, 0)).toISOString().slice(0, 10);
    const start = addDays(addMonths(addDays(end, 1), -12), 0);
    return { start, end, label: m === 12 ? String(endYear) : `FY${endYear}` };
}

/** Compact axis labels for charts (12k, 3m, 1.2bn). */
export const compact = (v: number | string): string => {
    const n = Number(v), a = Math.abs(n);
    return a >= 1e9 ? (n / 1e9).toFixed(1) + 'bn' : a >= 1e6 ? (n / 1e6).toFixed(0) + 'm' : a >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(v);
};

export const getPath = (o: unknown, p: string): unknown => p.split('.').reduce<unknown>((a, k) => a == null ? a : (a as Record<string, unknown>)[k], o);
export const setPath = (o: object, p: string, v: unknown): void => {
    const ks = p.split('.');
    let a = o as Record<string, unknown>;
    ks.slice(0, -1).forEach(k => { if (a[k] == null || typeof a[k] !== 'object') a[k] = {}; a = a[k] as Record<string, unknown>; });
    a[ks[ks.length - 1]] = v;
};

/** The `code` property of a thrown runtime error, if any. */
export const errCode = (e: unknown): string | undefined => (e && typeof e === 'object' && 'code' in e) ? String((e as { code: unknown }).code) : undefined;
export const errMessage = (e: unknown): string => e instanceof Error ? e.message : String(e);
