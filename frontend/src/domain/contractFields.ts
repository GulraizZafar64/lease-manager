/* Contract terms found in documents: labels, highlight colours, display format,
   and the highlighted document view (escaped HTML for dangerouslySetInnerHTML). */
import { ASSET_CLASSES, FREQ } from './settings';
import { esc } from '../utils/html';
import { fmtNum } from '../utils/format';
import { fmtDate } from '../utils/dates';
import type { DocumentHit } from '../types/lease';

export const FIELD_COLORS: Record<string, string> = {
    counterpartyLessor: '#c9e7df', counterpartyLessee: '#c9e7df', commencement: '#cfe0f7', endDate: '#cfe0f7', termMonths: '#cfe0f7', lockIn: '#cfe0f7',
    payment: '#fde2b8', freqM: '#fde2b8', timing: '#fde2b8', currency: '#fde2b8', escalation: '#f8d0c8', deposit: '#e6d9f5', area: '#d9eecb', areaUnit: '#d9eecb',
    discountRate: '#f9e79f', kibor: '#f9e79f', usefulLifeM: '#d6e4f0', extension: '#f3d1e4', notice: '#f3d1e4', penalty: '#f3d1e4', purchase: '#f3d1e4', rvg: '#f3d1e4',
    rentFreeMonths: '#fde2b8', serviceComponent: '#e0e0e0', idc: '#e6d9f5', assetClass: '#d9eecb',
};
export const FIELD_LABELS: Record<string, string> = {
    counterpartyLessor: 'Lessor', counterpartyLessee: 'Lessee', commencement: 'Commencement', endDate: 'End date', termMonths: 'Term (months)', lockIn: 'Lock-in (months)',
    payment: 'Payment', freqM: 'Frequency', timing: 'Timing', currency: 'Currency', escalation: 'Escalation', deposit: 'Security deposit', area: 'Area', areaUnit: 'Area unit',
    discountRate: 'Rate %', kibor: 'Floating rate', usefulLifeM: 'Useful life (months)', extension: 'Extension option', notice: 'Notice period', penalty: 'Termination penalty',
    purchase: 'Purchase option', rvg: 'Residual value guarantee', rentFreeMonths: 'Rent-free months', serviceComponent: 'Service charge', idc: 'Initial direct costs', assetClass: 'Asset class',
};

type Obj = Record<string, unknown>;
export function fmtField(k: string, v: unknown): string {
    if (v === null || v === undefined) return '—';
    const o = v as Obj;
    if (k === 'commencement' || k === 'endDate') return fmtDate(String(v));
    if (k === 'freqM') return FREQ[Number(v)] || String(v);
    if (k === 'escalation') return `${o.rate}% every ${o.everyM} months`;
    if (k === 'extension') return `${o.months} months`;
    if (k === 'purchase') return o.price ? fmtNum(o.price) : 'Option present, no price found';
    if (k === 'notice') return `${o.days} days`;
    if (k === 'kibor') return `${o.benchmark} + ${o.spread}%`;
    if (k === 'assetClass') return ASSET_CLASSES[String(v)] || String(v);
    if (typeof v === 'number') return fmtNum(v, v % 1 ? 2 : 0);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

/** The document text with each found term wrapped in a coloured <mark class="hit" data-field>. */
export function highlightText(text: string, hits: DocumentHit[]): string {
    const hs = (hits || []).filter(h => h.start >= 0 && h.end > h.start).sort((a, b) => a.start - b.start);
    let out = '', pos = 0;
    for (const h of hs) {
        if (h.start < pos) continue;
        out += esc(text.slice(pos, h.start));
        out += `<mark class="hit" data-field="${esc(h.field)}" style="background:${FIELD_COLORS[h.field] || '#eee'}" title="${esc(FIELD_LABELS[h.field] || h.field)}">${esc(text.slice(h.start, h.end))}</mark>`;
        pos = h.end;
    }
    return out + esc(text.slice(pos));
}
