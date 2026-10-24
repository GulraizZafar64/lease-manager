/* ======================================================================
   File export: Excel, CSV, PDF (through the viewer's download prompt)
   and the lazy loader for the heavier libraries.
   ====================================================================== */
import { SETTINGS } from '../domain/settings';
import { audit, guard, presentationCcy } from '../domain/enterprise';
import { toast } from './uiStore';
import { errCode, errMessage, fmtNum, unitNote } from './format';
import { fmtDate, todayISO } from './dates';

export type SheetValue = string | number | null | undefined;
export interface Sheet { name: string; rows: SheetValue[][] }
export type ExportFormat = 'csv' | 'xlsx' | 'pdf';

export const LIBS = {
    xlsx: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
    pdfjs: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
    pdfjsWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
    jspdf: 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
    autotable: 'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js',
    mammoth: 'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js',
};
type LibName = Exclude<keyof typeof LIBS, 'pdfjsWorker'>;
const loaded: Partial<Record<LibName, Promise<void>>> = {};
export function loadLib(name: LibName): Promise<void> {
    const hit = loaded[name];
    if (hit) return hit;
    const p = new Promise<void>((res, rej) => {
        const s = document.createElement('script');
        s.src = LIBS[name]; s.onload = () => res(); s.onerror = () => { delete loaded[name]; rej(new Error('Could not load ' + name)); };
        document.head.appendChild(s);
    });
    loaded[name] = p;
    return p;
}

let downloadsCap: DownloadsCapability | null | undefined;
export async function saveFile(filename: string, data: string | Blob): Promise<boolean> {
    if (downloadsCap === undefined) downloadsCap = window.claude && window.claude.use ? await window.claude.use('downloads').catch(() => null) : null;
    if (downloadsCap) {
        try { await downloadsCap.save({ filename, data }); return true; }
        catch (e) {
            const c = errCode(e);
            if (c === 'declined') return false;
            if (c === 'rate_limited') { toast('A download prompt is already open.'); return false; }
            if (c !== 'unavailable' && c !== 'not_granted') { toast('This file type cannot be downloaded here.'); return false; }
        }
    }
    try { // outside the Claude viewer
        const blob = data instanceof Blob ? data : new Blob([data]);
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000); return true;
    } catch { toast('Downloads are not available in this view.'); return false; }
}
const csvCell = (v: SheetValue): string => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const toCSV = (rows: SheetValue[][]): string => rows.map(r => r.map(csvCell).join(',')).join('\r\n');

/** Write sheets to a file without the permission check (ERP export uses it for multi-sheet layouts). */
export async function exportFileUnchecked(format: ExportFormat, baseName: string, sheets: Sheet[], title?: string): Promise<boolean | undefined> {
    const stamp = todayISO();
    try {
        if (format === 'csv') {
            const rows = sheets.length === 1 ? sheets[0].rows : sheets.flatMap(s => [[s.name], ...s.rows, []]);
            return saveFile(`${baseName}_${stamp}.csv`, '﻿' + toCSV(rows));
        }
        if (format === 'xlsx') {
            await loadLib('xlsx');
            const XLSX = window.XLSX as XlsxStatic;
            const wb = XLSX.utils.book_new();
            sheets.forEach(s => {
                const ws = XLSX.utils.aoa_to_sheet(s.rows);
                ws['!cols'] = (s.rows[0] || []).map((_, i) => ({ wch: Math.min(48, Math.max(10, ...s.rows.slice(0, 200).map(r => String(r[i] ?? '').length + 2))) }));
                XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
            });
            const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
            return saveFile(`${baseName}_${stamp}.xlsx`, new Blob([buf]));
        }
        if (format === 'pdf') {
            await loadLib('jspdf'); await loadLib('autotable');
            const { jsPDF } = window.jspdf as JsPdfStatic;
            const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
            let y = 40;
            doc.setFontSize(14); doc.text(title || baseName, 40, y); y += 16;
            doc.setFontSize(9); doc.setTextColor(100); doc.text(`${SETTINGS.entity}  |  Generated ${fmtDate(stamp)}  |  Amounts in ${presentationCcy()}${unitNote()} unless stated`, 40, y); y += 12;
            sheets.forEach((s, i) => {
                if (i > 0) y = doc.lastAutoTable ? doc.lastAutoTable.finalY + 24 : y;
                if (y > 500) { doc.addPage(); y = 40; }
                doc.setFontSize(11); doc.setTextColor(20); doc.text(s.name, 40, y + 4);
                const [head, ...body] = s.rows;
                doc.autoTable({
                    startY: y + 10, head: [head.map(String)], body: body.map(r => r.map(v => typeof v === 'number' ? fmtNum(v, Math.abs(v) < 100 && v % 1 ? 2 : 0) : String(v ?? ''))), styles: { fontSize: 7.5, cellPadding: 3 }, headStyles: { fillColor: [19, 35, 58] }, margin: { left: 40, right: 40 },
                    didParseCell: d => { if (d.section === 'body' && typeof body[d.row.index]?.[d.column.index] === 'number') d.cell.styles.halign = 'right'; },
                });
                y = (doc.lastAutoTable ? doc.lastAutoTable.finalY : y) + 24;
            });
            return saveFile(`${baseName}_${stamp}.pdf`, doc.output('blob'));
        }
    } catch (e) { console.error(e); toast('Export failed: ' + errMessage(e)); }
    return undefined;
}

/** Export sheets as a file; needs the report.export permission and is recorded in the audit log. */
export function exportFile(format: ExportFormat, baseName: string, sheets: Sheet[], title?: string): Promise<boolean | undefined> | undefined {
    if (!guard('report.export', 'export files')) return undefined;
    audit('export', `${baseName} as ${format}`);
    return exportFileUnchecked(format, baseName, sheets, title);
}
