import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { ScreenProps } from './registry';
import type { ScreenParamMap } from '../domain/nav';
import { go } from '../domain/nav';
import { ASSET_CLASSES, CURRENCIES, FREQ, SETTINGS, engineSettings } from '../domain/settings';
import { blankLease, contractEnd } from '../domain/lease';
import { Store } from '../domain/store';
import { gate, logHistory } from '../domain/enterprise';
import { addDays, monthsBetween, num as N, run } from '../domain/engine';
import { Extractor, type ExtractHit } from '../domain/extractor';
import { FIELD_COLORS, FIELD_LABELS, highlightText } from '../domain/contractFields';
import { aiErr, getSample } from '../domain/ai';
import { nextLeaseId } from '../domain/lease';
import { toast } from '../utils/uiStore';
import { LIBS, exportFile, loadLib, saveFile, type SheetValue } from '../utils/files';
import { FORMAT_LABELS, SAMPLE_CONTRACTS, sampleFile, sampleName, type SampleContract, type SampleFormat } from '../domain/sampleContracts';
import { deepClone, errMessage, fmtNum } from '../utils/format';
import { fmtDate } from '../utils/dates';
import type { DocumentHit, Lease, LeaseDocument } from '../types/lease';

type ImportParams = ScreenParamMap['import'];

const I = {
    upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
    doc: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
    sheet: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18',
    download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
    paste: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6v4H9z',
    sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
    lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
    check: 'M20 6 9 17l-5-5',
    chevron: 'M9 18l6-6-6-6',
    back: 'M15 18l-6-6 6-6',
    close: 'M18 6 6 18M6 6l12 12',
    image: 'M3 3h18v18H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
};
const Ic = ({ d, size = 16 }: { d: string; size?: number }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

/* ======================================================================
   Contract import. The document stays in module state, so it is still
   there when the user leaves the screen and comes back.
   ====================================================================== */
/** A term and where it came from: read by the rules or AI, changed or added by the person reviewing, or a default from Settings. */
interface ImportField { value: unknown; start: number; end: number; snippet: string; derived?: boolean; source: 'rules' | 'ai' | 'edited' | 'user' | 'settings' }
interface SheetData { name: string; rows: SheetCell[][] }
interface ImportStateT {
    text: string; name: string; kind: string; fields: Record<string, ImportField>; notes: string[]; hits: DocumentHit[];
    pages: PdfPage[]; sheet: SheetData[] | null; ai: boolean; file?: File; pdf?: PdfDocument; image?: File; allHits?: ExtractHit[];
    /** The terms have been read from this text (so review edits survive leaving the screen); which side we are. */
    extracted: boolean; role: 'lessee' | 'lessor';
}
const ImportState: ImportStateT = { text: '', name: '', kind: '', fields: {}, notes: [], hits: [], pages: [], sheet: null, ai: false, extracted: false, role: 'lessee' };

const TEMPLATE_HEAD = ['Lease ID', 'Description', 'Role', 'Counterparty', 'Asset class', 'Location', 'Currency', 'Commencement date', 'Term (months)', 'Payment', 'Frequency (months)', 'Timing', 'Escalation %', 'Escalation every (months)', 'Discount rate %', 'Initial direct costs', 'Incentives', 'Security deposit', 'Extension (months)', 'Extension reasonably certain', 'Purchase option price', 'Purchase reasonably certain', 'Useful life (months)', 'Exemption', 'Area', 'Area unit'];
const TEMPLATE_ROWS: SheetValue[][] = [TEMPLATE_HEAD, ['WH-001', 'Warehouse, Port Qasim', 'lessee', 'Indus Logistics Parks', 'warehouse', 'Karachi', 'PKR', '2026-07-01', 60, 2400000, 1, 'advance', 10, 12, 16, 1200000, 0, 7200000, 36, 'no', '', 'no', '', 'none', 45000, 'sq ft']];

/* ---- What the screen shows (the original set these parts of the DOM one by one) ---- */
interface Tape { sheet: string; head: string[]; map: Record<string, number>; rows: SheetCell[][] }
interface TapeView { tape: Tape; leases: Lease[]; issues: string[][]; liab: string[] }
type FieldsView =
    | { k: 'intro' } | { k: 'reading' } | { k: 'error'; msg: string } | { k: 'nothing' }
    | { k: 'list'; fields: Record<string, ImportField>; notes: string[] }
    | { k: 'tape'; ready: number; total: number }
    | { k: 'aiBusy'; ctl: AbortController };
type Legend = { k: 'none' } | { k: 'chips'; used: string[] } | { k: 'tape'; cols: [column: string, key: string][] };
type DocView = { k: 'none' } | { k: 'empty' } | { k: 'html'; html: string } | { k: 'tape'; tape: TapeView };
type Actions = { k: 'hidden' } | { k: 'next'; seq: number } | { k: 'tape'; tape: TapeView };
interface View {
    docShown: boolean; docName: string; docMeta: string; legend: Legend; doc: DocView; wsNormal: boolean;
    fields: FieldsView; aiNotes: number; aiDisabled: boolean; actions: Actions;
}
type SetView = (f: (v: View) => View) => void;

const initialView = (): View => ({ docShown: false, docName: '', docMeta: '', legend: { k: 'none' }, doc: { k: 'none' }, wsNormal: false, fields: { k: 'intro' }, aiNotes: 0, aiDisabled: true, actions: { k: 'hidden' } });

async function handleFile(f: File, set: SetView) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    Object.assign(ImportState, { name: f.name, kind: ext, text: '', pages: [], sheet: null, ai: false, extracted: false, file: f, image: undefined, pdf: undefined, role: 'lessee' });
    set(v => ({ ...v, fields: { k: 'reading' }, aiNotes: 0 }));
    try {
        if (ext === 'pdf') {
            await loadLib('pdfjs');
            const pdfjsLib = window.pdfjsLib as PdfJsStatic;
            pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfjsWorker;
            const doc = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;
            const out: string[] = [];
            for (let i = 1; i <= doc.numPages; i++) {
                const pg = await doc.getPage(i), tc = await pg.getTextContent();
                let line = '', lastY: number | null = null, txt = '';
                for (const it of tc.items) { const y = Math.round(it.transform[5]); if (lastY !== null && Math.abs(y - lastY) > 3) { txt += line.trimEnd() + '\n'; line = ''; } line += it.str + (it.hasEOL ? '\n' : ' '); lastY = y; }
                txt += line;
                out.push(txt);
                ImportState.pages.push(pg);
            }
            // A PDF breaks lines mid-sentence ("expiring on" / "30 June 2031"); rejoin a line that plainly continues
            // (it starts in lower case, with a figure or a bracket, and the line before does not end a sentence), so terms
            // split across lines are still found. Paragraph breaks and numbered headings stay.
            ImportState.text = out.join('\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
                .replace(/([^.:;!?\n])\n(?!\n)(?=[a-z0-9(])(?!\d+[.)]\s)/g, '$1 ');
            ImportState.pdf = doc;
        } else if (ext === 'docx') {
            await loadLib('mammoth');
            const r = await (window.mammoth as MammothStatic).extractRawText({ arrayBuffer: await f.arrayBuffer() });
            ImportState.text = r.value;
        } else if (['xlsx', 'xls', 'csv'].includes(ext)) {
            await loadLib('xlsx');
            const XLSX = window.XLSX as XlsxStatic;
            const wb = XLSX.read(ext === 'csv' ? await f.text() : await f.arrayBuffer(), { type: ext === 'csv' ? 'string' : 'array', cellDates: true });
            const sheets = wb.SheetNames.map(n => ({ name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }) }));
            ImportState.sheet = sheets;
            ImportState.text = sheets.map(s => `## ${s.name}\n` + s.rows.map(r => r.map(c => c instanceof Date ? c.toISOString().slice(0, 10) : c).join(' | ')).join('\n')).join('\n\n');
        } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
            ImportState.text = ''; ImportState.image = f;
        } else {
            ImportState.text = await f.text();
        }
    } catch (e) { console.error(e); set(v => ({ ...v, fields: { k: 'error', msg: `This file could not be read (${errMessage(e)}). Paste the text instead.` }, aiNotes: 0 })); return; }
    set(v => analyse(v));
}

function analyse(v: View): View {
    const S = ImportState;
    v = { ...v, docShown: true, docName: S.name };
    const tape = S.sheet ? detectTape(S.sheet) : null;
    if (tape) return renderTape(v, tape);
    if (!S.text.trim()) {
        return { ...v, docMeta: S.kind === 'pdf' ? 'No text layer: this looks like a scanned PDF.' : 'This is an image.', doc: { k: 'empty' }, legend: { k: 'none' }, fields: { k: 'nothing' }, aiNotes: 0, aiDisabled: false };
    }
    if (!S.ai && !S.extracted) {
        const found = Extractor.run(S.text);
        const r = Extractor.toLease(found, S.text);
        S.fields = {}; Object.entries(r.fields).forEach(([k, f]) => S.fields[k] = { value: f.value, start: f.hit.start, end: f.hit.end, snippet: f.hit.snippet, derived: f.derived, source: 'rules' });
        S.notes = r.notes;
        S.allHits = found;
        S.extracted = true;
    }
    // Terms a contract often leaves out, filled from Settings (shown as such, and editable)
    const fromSettings = (value: unknown): ImportField => ({ value, start: -1, end: -1, snippet: '', source: 'settings' });
    if (!S.fields.currency) S.fields.currency = fromSettings(SETTINGS.functionalCurrency);
    if (!S.fields.discountRate && !S.fields.kibor && SETTINGS.defaultRate !== '' && Number(SETTINGS.defaultRate) > 0) S.fields.discountRate = fromSettings(Number(SETTINGS.defaultRate));
    v = { ...v, docMeta: `${S.text.length.toLocaleString()} characters. ${Object.keys(S.fields).length} terms found${S.ai ? ' by AI' : ''}.` };
    v = drawFields(drawDoc(v));
    return { ...v, aiDisabled: false };
}
function drawDoc(v: View): View {
    const S = ImportState;
    const hits = Object.entries(S.fields).filter(([, f]) => f.start != null && f.start >= 0).map(([k, f]) => ({ field: k, start: f.start, end: f.end }));
    const used = [...new Set(hits.map(h => h.field))];
    return { ...v, doc: { k: 'html', html: highlightText(S.text, hits) }, legend: { k: 'chips', used } };
}
let drawSeq = 0;
function drawFields(v: View): View {
    const S = ImportState;
    return { ...v, fields: { k: 'list', fields: { ...S.fields }, notes: S.notes.slice() }, aiNotes: 0, actions: { k: 'next', seq: ++drawSeq } };
}
function docRecord(): LeaseDocument {
    const S = ImportState;
    const text = S.text.slice(0, 60000);
    return { name: S.name, addedAt: new Date().toISOString(), text, hits: Object.entries(S.fields).filter(([, v]) => v.start >= 0 && v.end <= text.length).map(([k, v]) => ({ field: k, start: v.start, end: v.end })), fields: Object.fromEntries(Object.entries(S.fields).map(([k, v]) => [k, v.value])) };
}
function leaseFromImport(role: string, rate: string): Lease {
    const S = ImportState, f = (k: string): unknown => S.fields[k] ? S.fields[k].value : undefined;
    const s = (k: string) => f(k) as string, n = (k: string) => f(k) as number;
    const o = <T,>(k: string) => f(k) as T;
    const l = blankLease(); const T = l.terms;
    l.role = role as Lease['role']; l.id = nextLeaseId(role);
    l.counterparty = (role === 'lessee' ? s('counterpartyLessor') : s('counterpartyLessee')) || '';
    l.assetClass = s('assetClass') || 'building';
    l.name = `${ASSET_CLASSES[l.assetClass] ? ASSET_CLASSES[l.assetClass].replace(/s and.*|s$/, '') : 'Lease'}${l.counterparty ? ' from ' + l.counterparty : ''}`.slice(0, 80);
    if (f('currency')) l.currency = s('currency');
    if (f('area')) { l.area = n('area'); l.areaUnit = s('areaUnit') || 'sq ft'; }
    if (f('commencement')) T.commencement = s('commencement');
    if (f('termMonths')) T.termMonths = n('termMonths');
    if (f('payment')) T.payment = n('payment');
    if (f('freqM')) T.freqM = Number(f('freqM'));
    if (f('timing')) T.timing = o<Lease['terms']['timing']>('timing');
    if (f('escalation')) T.escalation = Object.assign({ type: 'fixed' as const }, o<object>('escalation'));
    if (f('deposit')) T.deposit = n('deposit');
    if (f('discountRate')) T.discountRate = n('discountRate'); else if (rate) T.discountRate = Number(rate);
    if (f('usefulLifeM')) T.usefulLifeM = n('usefulLifeM');
    if (f('extension')) { const x = o<{ months: number; payment?: number | null }>('extension'); T.extension = { months: x.months, payment: x.payment || '', certain: false }; }
    if (f('purchase')) T.purchase = { price: o<{ price?: number | null }>('purchase').price || '', certain: false };
    if (f('rvg')) T.rvg = n('rvg');
    if (f('rentFreeMonths')) T.rentFreeMonths = n('rentFreeMonths');
    if (f('serviceComponent')) { T.serviceComponent = n('serviceComponent'); T.combine = false; }
    if (f('idc')) T.idc = n('idc');
    if (f('penalty') && f('lockIn')) T.termination = { month: n('lockIn'), penalty: '', certain: false };
    if (f('contractNumber')) l.contractNumber = s('contractNumber');
    if (f('name')) l.name = s('name');
    if (f('location')) l.location = s('location');
    const notes = S.notes.slice();
    if (f('notice')) notes.push(`Notice period: ${o<{ days: number }>('notice').days} days.`);
    if (f('penalty')) notes.push(`Termination penalty in the contract: ${fmtNum(typeof f('penalty') === 'object' ? 0 : f('penalty'))}.`);
    if (f('kibor')) { const x = o<{ benchmark: string; spread: number }>('kibor'); notes.push(`Floating rate: ${x.benchmark} + ${x.spread}%.`); }
    l.notes = notes.join(' ');
    l.documents = [docRecord()];
    l._source = S.name;
    return l;
}

/* ---- Review: every term can be changed; the essentials must be there before the lease form opens ---- */
type TermKind = 'text' | 'date' | 'number' | 'select' | 'escalation' | 'extension' | 'purchase' | 'notice' | 'kibor';
interface TermDef { kind: TermKind; label?: string; hint?: string; options?: [string, string][] }
const TERMS: Record<string, TermDef> = {
    counterpartyLessor: { kind: 'text', label: 'Lessor (landlord)' },
    counterpartyLessee: { kind: 'text', label: 'Lessee (customer)' },
    commencement: { kind: 'date', label: 'Start date', hint: 'When you can first use the asset' },
    termMonths: { kind: 'number', label: 'Term (months)' },
    payment: { kind: 'number', label: 'Rent per payment', hint: 'Without separately charged services and taxes' },
    freqM: { kind: 'select', label: 'Paid', options: Object.entries(FREQ).map(([k, v]) => [k, v]) },
    timing: { kind: 'select', label: 'Paid in', options: [['advance', 'Advance (start of each period)'], ['arrears', 'Arrears (end of each period)']] },
    currency: { kind: 'select', options: CURRENCIES.map(c => [c, c]) },
    discountRate: { kind: 'number', label: 'Discount rate %', hint: 'Not in the contract: enter your incremental borrowing rate for this lease (a default can be set in Settings)' },
    name: { kind: 'text', label: 'Asset', hint: 'For example Warehouse No. 4, Port Qasim' },
    assetClass: { kind: 'select', options: Object.entries(ASSET_CLASSES) },
    location: { kind: 'text', label: 'Location' },
    contractNumber: { kind: 'text', label: 'Contract number' },
    area: { kind: 'number' },
    areaUnit: { kind: 'select', options: ['sq ft', 'sq m', 'sq yd', 'marla', 'kanal', 'acre', 'units'].map(u => [u, u]) },
    endDate: { kind: 'date', hint: 'Changing it sets the term' },
    lockIn: { kind: 'number' }, deposit: { kind: 'number' }, penalty: { kind: 'number' }, rvg: { kind: 'number' }, rentFreeMonths: { kind: 'number' },
    serviceComponent: { kind: 'number', hint: 'Per payment; kept out of the lease liability' }, idc: { kind: 'number' }, usefulLifeM: { kind: 'number' },
    escalation: { kind: 'escalation', label: 'Rent increase' }, extension: { kind: 'extension' }, purchase: { kind: 'purchase' }, notice: { kind: 'notice' }, kibor: { kind: 'kibor' },
};
const termLabel = (k: string) => TERMS[k]?.label || FIELD_LABELS[k] || k;
/** What a lease needs to be measured, for our side of it. */
const essentials = (role: string) => [role === 'lessor' ? 'counterpartyLessee' : 'counterpartyLessor', 'commencement', 'termMonths', 'payment', 'freqM', 'timing', 'currency', 'discountRate'];
const ASSET_TERMS = ['name', 'assetClass', 'location', 'contractNumber', 'area', 'areaUnit'];
const OTHER_TERMS = ['escalation', 'deposit', 'rentFreeMonths', 'extension', 'lockIn', 'notice', 'penalty', 'purchase', 'rvg', 'serviceComponent', 'idc', 'usefulLifeM', 'endDate', 'kibor', 'counterpartyLessor', 'counterpartyLessee'];
/** Whether a term has a usable value. */
function filled(k: string): boolean {
    const f = ImportState.fields[k], v = f ? f.value : undefined, kind = TERMS[k]?.kind;
    if (v === undefined || v === null || v === '') return false;
    if (kind === 'number') return Number(v) > 0;
    if (kind === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(String(v));
    if (kind === 'text' || kind === 'select') return String(v).trim() !== '';
    return typeof v === 'object';
}
/** Changes a term as the person reviewing sets it. An end date sets the term from the start date. */
function setTerm(k: string, value: unknown) {
    const S = ImportState, old = S.fields[k];
    S.fields[k] = old ? { ...old, value, derived: false, source: old.source === 'user' ? 'user' : 'edited' } : { value, start: -1, end: -1, snippet: '', source: 'user' };
    const com = S.fields.commencement?.value, end = S.fields.endDate?.value;
    if ((k === 'endDate' || k === 'commencement') && filled('commencement') && filled('endDate') && String(end) > String(com)) {
        const m = monthsBetween(String(com), addDays(String(end), 1)), t = S.fields.termMonths;
        S.fields.termMonths = t ? { ...t, value: m, derived: true, source: 'edited' } : { value: m, start: -1, end: -1, snippet: '', derived: true, source: 'user' };
    }
}
function removeTerm(k: string) { delete ImportState.fields[k]; }

/** The lease as reviewed, measured, for the preview. */
function measured(): { lease: Lease; res: ReturnType<typeof run> | null } {
    const lease = leaseFromImport(ImportState.role, '');
    try { return { lease, res: run(lease, engineSettings()) }; } catch { return { lease, res: null }; }
}

/* Spreadsheet of many leases ("lease tape") */
const TAPE_MAP: Record<string, RegExp> = {
    id: /lease\s*id|^id$|lease\s*no|reference/i, name: /description|asset\s*name|^name$|property/i, role: /^role$|lessee\/lessor/i, counterparty: /counterparty|lessor|landlord|vendor/i,
    assetClass: /asset\s*(class|type|category)/i, location: /location|city|site/i, currency: /currency|ccy/i, commencement: /commenc|start/i, termMonths: /term.*month|months|tenure/i,
    payment: /^payment$|rent|instal|amount/i, freqM: /frequency/i, timing: /timing|advance|arrears/i, escRate: /escalation\s*%|increase\s*%|escalation$/i, escEvery: /escalation\s*every|every/i,
    discountRate: /discount|ibr|rate/i, idc: /initial\s*direct|idc/i, incentives: /incentive/i, deposit: /deposit/i, extMonths: /extension\s*\(|extension\s*months|renewal/i, extCertain: /extension.*certain/i,
    purchasePrice: /purchase.*price/i, purchaseCertain: /purchase.*certain/i, usefulLifeM: /useful\s*life/i, exemption: /exemption/i, area: /^area$/i, areaUnit: /area\s*unit|unit/i,
};
function detectTape(sheets: SheetData[]): Tape | null {
    for (const s of sheets) {
        for (let h = 0; h < Math.min(10, s.rows.length); h++) {
            const head = s.rows[h].map(c => String(c || '').trim());
            const map: Record<string, number> = {};
            Object.entries(TAPE_MAP).forEach(([k, re]) => { const i = head.findIndex((c, idx) => c && re.test(c) && !Object.values(map).includes(idx)); if (i >= 0) map[k] = i; });
            if (map.commencement != null && map.payment != null && (map.termMonths != null) && Object.keys(map).length >= 4) {
                const rows = s.rows.slice(h + 1).filter(r => r.some(c => c !== '' && c != null));
                return { sheet: s.name, head, map, rows };
            }
        }
    }
    return null;
}
function tapeToLease(r: SheetCell[], map: Record<string, number>): Lease {
    const g = (k: string): SheetCell => map[k] != null ? r[map[k]] : '';
    const yes = (v: SheetCell) => /^(y|yes|true|1)$/i.test(String(v).trim());
    const d = (v: SheetCell) => v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'number' ? new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10) : (Extractor.parseDate(String(v)) || String(v));
    const l = blankLease(), T = l.terms;
    l.role = /lessor/i.test(String(g('role'))) ? 'lessor' : 'lessee';
    l.id = String(g('id') || nextLeaseId(l.role)).trim(); l.name = String(g('name') || l.id); l.counterparty = String(g('counterparty') || '');
    const ac = String(g('assetClass') || '').toLowerCase(); l.assetClass = Object.keys(ASSET_CLASSES).find(k => ac.includes(k)) || (ac ? Extractor.run(ac).find(x => x.field === 'assetClass')?.value as string | undefined : null) || 'other';
    l.location = String(g('location') || ''); if (g('currency')) l.currency = String(g('currency')).toUpperCase();
    T.commencement = d(g('commencement')); T.termMonths = N(g('termMonths')); T.payment = N(g('payment')); T.freqM = N(g('freqM')) || 1;
    if (![1, 3, 6, 12].includes(T.freqM)) T.freqM = /quarter/i.test(String(g('freqM'))) ? 3 : /half/i.test(String(g('freqM'))) ? 6 : /ann|year/i.test(String(g('freqM'))) ? 12 : 1;
    T.timing = /arrear/i.test(String(g('timing'))) ? 'arrears' : 'advance';
    if (N(g('escRate'))) T.escalation = { type: 'fixed', rate: N(g('escRate')), everyM: N(g('escEvery')) || 12 };
    T.discountRate = N(g('discountRate')) < 1 && N(g('discountRate')) > 0 ? N(g('discountRate')) * 100 : N(g('discountRate'));
    T.idc = N(g('idc')); T.incentives = N(g('incentives')); T.deposit = N(g('deposit'));
    if (N(g('extMonths'))) T.extension = { months: N(g('extMonths')), payment: '', certain: yes(g('extCertain')) };
    if (N(g('purchasePrice'))) T.purchase = { price: N(g('purchasePrice')), certain: yes(g('purchaseCertain')) };
    T.usefulLifeM = N(g('usefulLifeM')) || '';
    const ex = String(g('exemption') || '').toLowerCase(); T.exemption = ex.includes('short') ? 'short-term' : ex.includes('low') ? 'low-value' : 'none';
    if (g('area')) { l.area = N(g('area')); l.areaUnit = String(g('areaUnit') || 'sq ft'); }
    return l;
}
function renderTape(v: View, tape: Tape): View {
    const leases = tape.rows.map(r => tapeToLease(r, tape.map));
    const issues = leases.map(l => { const e: string[] = []; if (!/^\d{4}-\d{2}-\d{2}$/.test(l.terms.commencement)) e.push('commencement date'); if (!(N(l.terms.termMonths) > 0)) e.push('term'); if (!(N(l.terms.payment) > 0)) e.push('payment'); if (l.role === 'lessee' && l.terms.exemption === 'none' && !l.terms.discountRate) e.push('discount rate'); if (Store.get(l.id)) e.push('ID already exists'); return e; });
    const liab = leases.map(l => { let L = ''; try { const r = run(l, engineSettings()); L = r.mode === 'lessee' ? fmtNum(r.initial.liability) : r.mode === 'exempt' ? 'Exempt' : fmtNum((r.mode === 'lessor-finance' ? r.initial.netInvestment : 0) || 0); } catch { L = '—'; } return L; });
    const tv: TapeView = { tape, leases, issues, liab };
    const ready = leases.filter((_, i) => !issues[i].length).length;
    return {
        ...v,
        docMeta: `Sheet “${tape.sheet}”: ${leases.length} leases recognised from ${Object.keys(tape.map).length} matched columns.`,
        legend: { k: 'tape', cols: Object.entries(tape.map).map(([k, i]) => [tape.head[i], k]) },
        wsNormal: true,
        doc: { k: 'tape', tape: tv },
        fields: { k: 'tape', ready, total: leases.length }, aiNotes: 0,
        actions: { k: 'tape', tape: tv },
    };
}

/* ---- AI reading (app.js 3082-3180) ---- */
const EXTRACT_SCHEMA = `{
 "fields": {
  "counterpartyLessor": {"value": "string", "quote": "exact words from the contract"},
  "counterpartyLessee": {"value": "string", "quote": "..."},
  "name": {"value": "short description of the leased asset, e.g. 'Warehouse No. 4, Port Qasim'", "quote": "..."},
  "contractNumber": {"value": "string", "quote": "..."},
  "location": {"value": "city", "quote": "..."},
  "commencement": {"value": "YYYY-MM-DD (date the asset is available for use)", "quote": "..."},
  "endDate": {"value": "YYYY-MM-DD", "quote": "..."},
  "termMonths": {"value": number of months of the contract term, "quote": "..."},
  "lockIn": {"value": months non-cancellable if shorter than the term, "quote": "..."},
  "payment": {"value": number (rent per period, excluding separately stated service charges and taxes), "quote": "..."},
  "freqM": {"value": 1|3|6|12, "quote": "..."},
  "timing": {"value": "advance"|"arrears", "quote": "..."},
  "currency": {"value": "PKR|USD|EUR|GBP|AED|SAR|CNY", "quote": "..."},
  "escalation": {"value": {"rate": percent, "everyM": months}, "quote": "..."},
  "deposit": {"value": number, "quote": "..."},
  "area": {"value": number, "quote": "..."}, "areaUnit": {"value": "sq ft|sq m|sq yd|marla|kanal|acre|units", "quote": "..."},
  "discountRate": {"value": percent if the contract states an interest/markup rate, "quote": "..."},
  "kibor": {"value": {"benchmark": "e.g. 6-month KIBOR", "spread": percent}, "quote": "..."},
  "usefulLifeM": {"value": months, "quote": "..."},
  "extension": {"value": {"months": number, "payment": number or null}, "quote": "..."},
  "notice": {"value": {"days": number}, "quote": "..."},
  "penalty": {"value": number, "quote": "..."},
  "purchase": {"value": {"price": number or null}, "quote": "..."},
  "rvg": {"value": number, "quote": "..."},
  "rentFreeMonths": {"value": number, "quote": "..."},
  "serviceComponent": {"value": number per period, "quote": "..."},
  "idc": {"value": number, "quote": "..."},
  "assetClass": {"value": "building|warehouse|retail|land|vehicle|equipment|it|other", "quote": "..."}
 },
 "notes": ["IFRS 16 judgements the preparer must make, each one sentence with a paragraph reference"]
}`;

interface AiExtractOut { fields?: Record<string, { value?: unknown; quote?: string } | null>; notes?: unknown[]; transcript?: unknown }

async function aiExtract(set: SetView) {
    const S = ImportState, sample = await getSample();
    if (!sample) { set(v => ({ ...v, aiNotes: v.aiNotes + 1 })); return; }
    const ctl = new AbortController();
    set(v => ({ ...v, aiDisabled: true, fields: { k: 'aiBusy', ctl }, aiNotes: 0 }));
    let images: Blob[] = [];
    try {
        if (!S.text.trim()) {
            const lim = await sample.limits().catch(() => null);
            if (!lim || !lim.images) throw { code: 'images_unavailable' };
            if (S.image) images = [S.image];
            else if (S.pdf) {
                for (let i = 1; i <= Math.min(S.pdf.numPages, lim.images.maxPerCall || 6, 8); i++) {
                    const pg = await S.pdf.getPage(i), vp = pg.getViewport({ scale: 1.6 });
                    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
                    await pg.render({ canvasContext: c.getContext('2d') as CanvasRenderingContext2D, viewport: vp }).promise;
                    images.push(await new Promise<Blob>(r => c.toBlob(b => r(b as Blob), 'image/png')));
                }
            }
        }
        const prompt = `You are reading a lease contract for IFRS 16 accounting. Extract the terms below. Use only what the contract says; omit a field rather than guess. "quote" must be copied exactly from the contract text (a short phrase, up to 25 words) so it can be highlighted.${images.length ? ' The contract is in the attached page images. Also return "transcript": the full text you can read, so it can be shown to the user, and take quotes from that transcript.' : ''}
Dates in Pakistan are usually day/month/year. Monthly rent "per month" means freqM 1. If a refundable security deposit is stated as a number of months' rent, multiply it out.
Return only JSON in this shape:
${EXTRACT_SCHEMA}${images.length ? '\nplus a top-level "transcript": "..."' : ''}

CONTRACT (${S.name}):
"""
${S.text.slice(0, 90000)}
"""`;
        const out = await sample.json(prompt, { signal: ctl.signal, modelTier: 'default', images: images.length ? images : undefined }) as AiExtractOut | null;
        if (!out || typeof out !== 'object' || !out.fields) throw { code: 'invalid_json' };
        if (out.transcript && !S.text.trim()) S.text = String(out.transcript);
        const norm = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
        const flat = norm(S.text);
        const locate = (q: string | undefined): [number, number] => {
            if (!q) return [-1, -1];
            const i = S.text.indexOf(q); if (i >= 0) return [i, i + q.length];
            const nq = norm(q).slice(0, 80); const j = flat.indexOf(nq);
            if (j < 0) return [-1, -1];
            // map normalised index back to the original text
            let oi = 0, ni = 0; while (ni < j && oi < S.text.length) { if (/\s/.test(S.text[oi])) { while (oi < S.text.length && /\s/.test(S.text[oi])) oi++; ni++; } else { oi++; ni++; } }
            return [oi, Math.min(S.text.length, oi + q.length)];
        };
        const merged: Record<string, ImportField> = {};
        Object.entries(out.fields).forEach(([k, v]) => {
            if (!v || v.value === null || v.value === undefined || v.value === '') return;
            let val = v.value;
            if (k === 'escalation' && typeof val === 'object') { const o = val as { rate?: unknown; everyM?: unknown }; val = { type: 'fixed', rate: N(o.rate), everyM: N(o.everyM) || 12 }; }
            if (['termMonths', 'payment', 'deposit', 'area', 'discountRate', 'usefulLifeM', 'penalty', 'rvg', 'rentFreeMonths', 'serviceComponent', 'idc', 'lockIn', 'freqM'].includes(k)) val = N(val);
            const [s, e] = locate(v.quote);
            merged[k] = { value: val, start: s, end: e, snippet: v.quote || '', source: 'ai' };
        });
        // keep rule-based terms the AI did not return
        Object.entries(S.fields).forEach(([k, v]) => { if (!merged[k]) merged[k] = v; });
        const aiNotes = out.notes || [];
        S.fields = merged; S.notes = aiNotes.map(String).concat(S.notes.filter(n => !aiNotes.includes(n))); S.ai = true;
        set(v => analyse(v));
    } catch (e) {
        console.warn(e);
        set(v => S.text.trim() ? drawFields(v) : { ...v, fields: { k: 'error', msg: aiErr(e) }, aiNotes: 0 });
    } finally { set(v => ({ ...v, aiDisabled: false })); }
}

/* ---- Screen: three steps, each on its own (add a contract, review and edit, confirm) ---- */
type Stage = 'add' | 'review' | 'confirm';

export function ImportPage({ params: p }: ScreenProps<'import'>) {
    const resumed = !!ImportState.text && !p.fresh;
    const [view, setView] = useState<View>(() => resumed ? analyse(initialView()) : initialView());
    const [stage, setStage] = useState<Stage>(resumed ? 'review' : 'add');
    const [input, setInput] = useState<'file' | 'paste'>('file');
    const [pasted, setPasted] = useState('');
    const [over, setOver] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    const docRef = useRef<HTMLDivElement>(null);
    const fieldsRef = useRef<HTMLDivElement>(null);
    // Review edits live in the module state; this redraws the review and the confirm step after each one
    const [, setRev] = useState(0);
    const bump = () => setRev(r => r + 1);

    const toTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });
    const goStage = (s: Stage) => { setStage(s); toTop(); };
    const readFile = (f: File) => { setStage('review'); void handleFile(f, setView); toTop(); };
    const readPasted = () => {
        const t = pasted.trim(); if (!t) return toast('Paste the contract text first.');
        Object.assign(ImportState, { text: t, name: 'Pasted text', kind: 'text', pages: [], sheet: null, ai: false, extracted: false, file: undefined, image: undefined, pdf: undefined, role: 'lessee' });
        setView(v => analyse(v)); goStage('review');
    };
    const pasteInstead = () => { setInput('paste'); goStage('add'); };
    // A sample is read from its file, the same way as one chosen from the computer
    const loadSample = async (s: SampleContract, f: SampleFormat) => {
        try { readFile(await sampleFile(s, f)); } catch (e) { toast(errMessage(e)); }
    };
    const focusHit = (k: string) => {
        const dv = docRef.current; if (!dv) return;
        const m = dv.querySelector(`mark[data-field="${k}"]`);
        dv.querySelectorAll('mark.focus').forEach(x => x.classList.remove('focus'));
        if (m) { m.classList.add('focus'); m.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    };
    // A highlight in the document finds its term in the review, and marks it for a moment
    const onDocClick = (e: MouseEvent<HTMLDivElement>) => {
        const m = (e.target as HTMLElement).closest<HTMLElement>('mark');
        if (!m || !docRef.current?.contains(m)) return;
        const row = fieldsRef.current?.querySelector<HTMLElement>(`[data-term="${m.dataset.field}"]`);
        if (!row) return;
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.classList.remove('tf-flash'); void row.offsetWidth; row.classList.add('tf-flash');
    };

    const S = ImportState, F = view.fields, A = view.actions;
    const ess = essentials(S.role), readyN = F.k === 'list' ? ess.filter(filled).length : 0, ready = F.k === 'list' && readyN === ess.length;
    const loaded = view.docShown || F.k === 'reading' || F.k === 'aiBusy';
    const at: Stage = stage === 'add' || F.k === 'intro' || F.k === 'error' ? 'add' : stage === 'confirm' && ready ? 'confirm' : 'review';
    const steps: { label: string; sub: string; state: string; to?: Stage }[] = [
        { label: 'Add a contract', sub: loaded && S.name ? S.name : 'Upload, paste or try a sample', state: at === 'add' ? 'on' : loaded ? 'done' : '', to: 'add' },
        { label: 'Review and edit', sub: F.k === 'list' ? `${readyN} of ${ess.length} essentials ready` : 'Check each term that was read', state: at === 'review' ? 'on' : ready ? 'done' : '', to: loaded ? 'review' : undefined },
        { label: 'Confirm', sub: 'Check the measurement', state: at === 'confirm' ? 'on' : '', to: ready ? 'confirm' : undefined },
    ];

    return (<div className="imp">
        {F.k === 'tape' && at !== 'add' ? null : <nav className="imp-stepper" aria-label="Import steps"><ol>
            {steps.map((s, i) => <li key={s.label} className={s.state}>
                <button type="button" disabled={!s.to || s.state === 'on'} aria-current={s.state === 'on' ? 'step' : undefined} onClick={() => s.to && goStage(s.to)}>
                    <span className="imp-step-n">{s.state === 'done' ? <Ic d={I.check} size={14} /> : i + 1}</span>
                    <span className="imp-step-t"><b>{s.label}</b><small>{s.sub}</small></span>
                </button>
            </li>)}
        </ol></nav>}

        {at === 'add' && <>
            {F.k === 'error' && <div className="banner bad imp-banner" role="alert"><div><b>This file could not be read</b><p>{F.msg}</p></div><div className="banner-actions"><button className="btn btn-ghost btn-sm" onClick={() => setInput('paste')}>Paste the text</button></div></div>}
            {loaded && F.k !== 'error' && <div className="banner imp-banner"><div><b>You are reviewing {S.name}</b><p>Adding another contract replaces it.</p></div><div className="banner-actions"><button className="btn btn-sm" onClick={() => goStage('review')}>Back to the review<Ic d={I.chevron} size={14} /></button></div></div>}
            <section className="card imp-hero">
                <div className="imp-hero-main">
                    <div className="imp-hero-head">
                        <h2>Add a lease contract</h2>
                        <p>The terms are read for you to check and edit. Nothing is saved until you confirm.</p>
                    </div>
                    <div className="seg imp-input-tabs" role="group" aria-label="How to add the contract">
                        <button type="button" aria-pressed={input === 'file'} onClick={() => setInput('file')}><Ic d={I.upload} size={15} />Upload a file</button>
                        <button type="button" aria-pressed={input === 'paste'} id="show-paste" onClick={() => setInput('paste')}><Ic d={I.paste} size={15} />Paste text</button>
                    </div>
                    {input === 'file'
                        ? <div className={'imp-drop' + (over ? ' over' : '')} id="drop" tabIndex={0} role="button" aria-label="Choose a contract file"
                            onClick={() => fileRef.current?.click()}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
                            onDragOver={e => { e.preventDefault(); setOver(true); }}
                            onDragLeave={() => setOver(false)}
                            onDrop={e => { e.preventDefault(); setOver(false); if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]); }}>
                            <input type="file" id="file" ref={fileRef} hidden accept=".pdf,.docx,.xlsx,.xls,.csv,.txt,.md,.png,.jpg,.jpeg,.webp" onChange={e => { const fl = e.currentTarget.files; if (fl && fl[0]) readFile(fl[0]); e.currentTarget.value = ''; }} />
                            <span className="imp-drop-ic"><Ic d={I.upload} size={28} /></span>
                            <strong>{over ? 'Drop it here' : 'Drag and drop your contract here'}</strong>
                            <span className="imp-drop-or">or</span>
                            <span className="btn imp-drop-btn" aria-hidden="true">Choose a file</span>
                            <span className="imp-drop-formats" aria-hidden="true">{['PDF', 'Word', 'Excel', 'CSV', 'Text', 'Photo'].map(t => <span key={t}>{t}</span>)}</span>
                        </div>
                        : <div className="imp-paste">
                            <textarea id="paste" rows={11} value={pasted} autoFocus aria-label="Contract text" placeholder="Paste the full text of the contract here: the parties, the term, the rent and any options." onChange={e => setPasted(e.target.value)} />
                            <div className="imp-paste-foot"><span className="note">{pasted.trim() ? `${pasted.trim().length.toLocaleString()} characters` : 'Copy the text from the contract file or an email.'}</span>
                                <button className="btn" id="paste-go" disabled={!pasted.trim()} onClick={readPasted}>Read the terms<Ic d={I.chevron} size={15} /></button></div>
                        </div>}
                    <p className="imp-private"><Ic d={I.lock} size={13} />Files are read in your browser. Only “Read with AI” sends the text to Claude. Photos and scanned PDFs need AI.</p>
                </div>
                <aside className="imp-hero-guide"><ContractGuide /></aside>
            </section>
            <Samples onLoad={loadSample} />
            <section className="card imp-sheet" id="sheet-help">
                <span className="imp-sheet-ic"><Ic d={I.sheet} size={22} /></span>
                <div className="imp-sheet-text"><h3>Moving a whole portfolio?</h3><p>Fill in the spreadsheet template, one row per lease, and upload it above. Each ready row becomes a lease. To see how it works first, try the sample portfolio above.</p></div>
                <div className="btn-row"><button className="btn btn-ghost btn-sm" id="tpl-x" onClick={() => exportFile('xlsx', 'Lease_import_template', [{ name: 'Leases', rows: TEMPLATE_ROWS }])}><Ic d={I.download} size={14} />Blank template (.xlsx)</button><button className="btn btn-ghost btn-sm" id="tpl-c" onClick={() => exportFile('csv', 'Lease_import_template', [{ name: 'Leases', rows: TEMPLATE_ROWS }])}><Ic d={I.download} size={14} />Blank template (.csv)</button></div>
            </section>
        </>}

        {at === 'review' && F.k === 'tape' && A.k === 'tape' && <div className="imp-tape">
            <section className="card imp-tape-head">
                <div className="imp-file"><span className="imp-file-ic is-sheet"><Ic d={I.sheet} size={20} /></span><div><h3 id="doc-name">{view.docName}</h3><p className="note" id="doc-meta">{view.docMeta}</p></div></div>
                <div className="tape-sum" id="fields">
                    <div className="tape-sum-n"><b>{F.ready}</b><span>of {F.total} rows ready</span></div>
                    <div className="tape-meter" role="img" aria-label={`${F.ready} of ${F.total} rows ready`}><span style={{ width: `${F.total ? (F.ready / F.total) * 100 : 0}%` }} /></div>
                </div>
                <div className="imp-tape-go" id="actions"><TapeImport tv={A.tape} /><button className="btn btn-ghost" onClick={() => goStage('add')}>Use another file</button></div>
            </section>
            <section className="card" id="doc-card">
                {view.legend.k === 'tape' && <div className="imp-legend"><details className="tape-cols"><summary><Ic d={I.check} size={14} />{view.legend.cols.length} columns matched<span className="note">Show</span></summary>
                    <div className="col-chips">{view.legend.cols.map(([col, key]) => <span key={key} title={`Read as ${key}`}>{col}</span>)}</div></details></div>}
                <div className="doc-view is-tape" id="doc-view" ref={docRef}><TapeTable tv={A.tape} /></div>
                {F.ready < F.total ? <p className="note imp-tape-note">Rows with problems are skipped. Fix them in the sheet and upload it again.</p> : null}
            </section>
        </div>}

        {at === 'review' && F.k !== 'tape' && (F.k === 'reading'
            ? <section className="card imp-state"><span className="spinner" aria-hidden="true" /><h3>Reading {S.name || 'the file'}…</h3><p>This takes a moment for a long PDF.</p></section>
            : <div className="imp-review">
                <section className="card imp-doc" id="doc-card" hidden={!view.docShown}>
                    <header className="imp-doc-head">
                        <div className="imp-file"><span className="imp-file-ic"><Ic d={S.image ? I.image : I.doc} size={18} /></span><div><h3 id="doc-name" title={view.docName}>{view.docName}</h3><p className="note" id="doc-meta">{view.docMeta}</p></div></div>
                        <button className="btn btn-ghost btn-sm" id="doc-change" onClick={() => goStage('add')}>Change</button>
                    </header>
                    {view.legend.k === 'chips' && view.legend.used.length ? <p className="imp-doc-hint"><span className="imp-doc-swatch" aria-hidden="true" />Highlights show the words each term was read from. Click one to find the term.</p> : null}
                    {view.doc.k === 'html'
                        ? <div className="doc-view imp-doc-view" id="doc-view" ref={docRef} onClick={onDocClick} dangerouslySetInnerHTML={{ __html: view.doc.html }} />
                        : <div className="doc-view imp-doc-view" id="doc-view" ref={docRef}>
                            {view.doc.k === 'empty' && (S.image ? <ImagePreview file={S.image} /> : <p className="empty">No readable text in this file.</p>)}
                        </div>}
                </section>
                <div className="imp-terms" id="fields-card">
                    {F.k === 'list' || F.k === 'nothing' ? <div className={'imp-ai' + (S.ai ? ' is-ai' : '')}>
                        <span className="imp-ai-ic"><Ic d={S.ai ? I.check : I.sparkle} size={18} /></span>
                        <div className="imp-ai-text"><b>{S.ai ? 'Read by AI' : F.k === 'nothing' ? 'No text in this file' : 'Read by text rules'}</b>
                            <p>{S.ai ? 'Check each value against the highlighted words and change anything that is wrong.' : F.k === 'nothing' ? 'It looks like a scan or a photo. AI can read the page images, or you can paste the text.' : 'Quick, and the text stays in your browser, but it can miss terms. AI also picks up the asset, option prices and unusual wording.'}</p></div>
                        <button className={S.ai ? 'btn btn-ghost btn-sm' : 'btn btn-sm'} id="ai-read" disabled={view.aiDisabled} {...gate('ai.use')} onClick={() => aiExtract(setView)}><Ic d={I.sparkle} size={14} />{S.ai ? 'Read again' : 'Read with AI'}</button>
                    </div> : null}
                    {Array.from({ length: view.aiNotes }, (_, i) => <p className="banner warn imp-banner" key={'n' + i}>AI reading is not available here. It needs to be set up for your company; meanwhile, fill in the terms yourself.</p>)}
                    <div id="fields" ref={fieldsRef}>
                        {F.k === 'aiBusy' && <section className="card imp-state"><span className="spinner" aria-hidden="true" /><h3>Claude is reading the contract…</h3><p>This can take up to a minute.</p><button className="btn btn-ghost btn-sm" id="ai-stop" onClick={() => F.ctl.abort()}>Stop</button></section>}
                        {F.k === 'nothing' && <section className="card imp-state"><Ic d={I.doc} size={26} /><h3>Nothing to review yet</h3><p>Read the file with AI, or paste the contract text.</p><button className="btn btn-ghost btn-sm" onClick={pasteInstead}><Ic d={I.paste} size={14} />Paste text instead</button></section>}
                        {F.k === 'list' && <ReviewForm key={A.k === 'next' ? A.seq : 0} notes={F.notes} onChange={bump} onJump={focusHit} />}
                    </div>
                </div>
            </div>)}
        {at === 'review' && F.k === 'list' && <ReviewBar p={p} onNext={() => goStage('confirm')} />}

        {at === 'confirm' && <ConfirmStage p={p} notes={F.k === 'list' ? F.notes : []} onBack={() => goStage('review')} />}
    </div>);
}

/** A photographed contract, shown as it is while there is no text to show. */
function ImagePreview({ file }: { file: File }) {
    const [url, setUrl] = useState('');
    useEffect(() => { const u = URL.createObjectURL(file); setUrl(u); return () => URL.revokeObjectURL(u); }, [file]);
    return url ? <img className="imp-doc-img" src={url} alt={`The contract as photographed: ${file.name}`} /> : null;
}

/** Import button for a spreadsheet of leases; shows that it is working, and runs once. */
function TapeImport({ tv }: { tv: TapeView }) {
    const [busy, setBusy] = useState(false);
    const ready = tv.leases.filter((_, i) => !tv.issues[i].length).length;
    return <>
        <button className="btn imp-go" id="tape-go" disabled={busy || !ready} onClick={async () => { setBusy(true); try { await importTape(tv); } finally { setBusy(false); } }}>{busy ? <><span className="spinner" aria-hidden="true" />Importing…</> : `Import ${ready} lease${ready === 1 ? '' : 's'}`}</button>
        <p className="note">Added as {SETTINGS.requireApproval ? 'leases awaiting approval' : 'active leases'}.{ready < tv.leases.length ? ` ${tv.leases.length - ready} row${tv.leases.length - ready === 1 ? '' : 's'} with problems will be skipped.` : ''}</p>
    </>;
}

async function attach(p: ImportParams) {
    const S = ImportState;
    const l = deepClone(Store.get(p.attachTo as string) as Lease); l.documents = l.documents || [];
    l.documents.push(docRecord()); logHistory(l, `Document attached: ${S.name}`);
    if (!await Store.save(l)) return; toast('Document attached'); go('detail', { id: l.id, tab: 'documents' }, { reset: true });
}
async function importTape(tv: TapeView) {
    const { leases, issues } = tv;
    let n = 0;
    for (let i = 0; i < leases.length; i++) { if (issues[i].length) continue; const l = leases[i]; l.status = SETTINGS.requireApproval ? 'pending' : 'active'; logHistory(l, `Imported from ${ImportState.name}${SETTINGS.requireApproval ? ' and submitted for approval' : ''}`); if (await Store.save(l)) n++; }
    toast(`${n} leases imported`);
    if (!n) return; // nothing saved: stay, so the sheet can be imported again
    ImportState.text = ''; go('register', {}, { reset: true });
}

/** A number typed by the person reviewing: kept as typed while editing, saved as a number. */
function NumberInput({ id, value, onValue, placeholder, step = 'any' }: { id?: string; value: unknown; onValue: (v: number | '') => void; placeholder?: string; step?: string }) {
    const [text, setText] = useState(value === undefined || value === null || value === '' ? '' : String(value));
    return <input id={id} type="number" inputMode="decimal" step={step} value={text} placeholder={placeholder}
        onChange={e => { const t = e.target.value; setText(t); if (t === '') onValue(''); else if (Number.isFinite(Number(t))) onValue(Number(t)); }} />;
}

/** The input for one term, by its kind. Compound terms (increases, options) edit their parts. */
function TermInput({ k, onChange }: { k: string; onChange: () => void }) {
    const def = TERMS[k] || { kind: 'text' as const }, f = ImportState.fields[k], v = f ? f.value : '';
    const id = 'rv-' + k, set = (x: unknown) => { setTerm(k, x); onChange(); };
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const part = (key: string, base: Record<string, unknown>) => (x: number | '') => set({ ...base, ...o, [key]: x === '' ? null : x });
    switch (def.kind) {
        case 'date': return <input id={id} type="date" value={String(v || '')} onChange={e => set(e.target.value)} />;
        case 'number': return <NumberInput id={id} value={v} onValue={set} placeholder={k === 'discountRate' && ImportState.fields.kibor ? 'KIBOR at start + spread' : undefined} />;
        case 'select': return (
            <select id={id} value={String(v ?? '')} onChange={e => set(k === 'freqM' ? Number(e.target.value) : e.target.value)}>
                {filled(k) ? null : <option value="">Choose…</option>}
                {(def.options || []).map(([val, label]) => <option key={val} value={val}>{label}</option>)}
            </select>);
        case 'escalation': return <span className="rv-parts"><NumberInput id={id} value={o.rate} onValue={part('rate', { type: 'fixed', everyM: 12 })} /><span>% every</span><NumberInput value={o.everyM ?? 12} onValue={part('everyM', { type: 'fixed' })} step="1" /><span>months</span></span>;
        case 'extension': return <span className="rv-parts"><NumberInput id={id} value={o.months} onValue={part('months', {})} step="1" /><span>months, rent</span><NumberInput value={o.payment} onValue={part('payment', {})} placeholder="if stated" /></span>;
        case 'purchase': return <span className="rv-parts"><span>Price</span><NumberInput id={id} value={o.price} onValue={part('price', {})} placeholder="if stated" /></span>;
        case 'notice': return <span className="rv-parts"><NumberInput id={id} value={o.days} onValue={part('days', {})} step="1" /><span>days</span></span>;
        case 'kibor': return <span className="rv-parts"><input id={id} value={String(o.benchmark ?? '')} placeholder="6-month KIBOR" onChange={e => set({ ...o, benchmark: e.target.value })} /><span>+</span><NumberInput value={o.spread} onValue={part('spread', {})} /><span>%</span></span>;
        default: return <input id={id} value={String(v ?? '')} placeholder={def.hint} onChange={e => set(e.target.value)} />;
    }
}

/** A term's value in words, for the confirm summary. */
function termText(k: string): string {
    const f = ImportState.fields[k]; if (!f) return '';
    const v = f.value, def = TERMS[k] || { kind: 'text' as const }, o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const months = (x: unknown) => `${x} month${Number(x) === 1 ? '' : 's'}`;
    switch (def.kind) {
        case 'date': return fmtDate(String(v));
        case 'select': return def.options?.find(([val]) => String(val) === String(v))?.[1] || String(v);
        case 'escalation': return `${o.rate ?? 0}% every ${months(o.everyM ?? 12)}`;
        case 'extension': return `${months(o.months ?? 0)}${o.payment ? `, rent ${fmtNum(o.payment)}` : ''}`;
        case 'purchase': return o.price ? `Price ${fmtNum(o.price)}` : 'Price not stated';
        case 'notice': return `${o.days ?? 0} days`;
        case 'kibor': return `${o.benchmark || 'KIBOR'} + ${o.spread ?? 0}%`;
        case 'number':
            if (k === 'discountRate') return `${v}% a year`;
            if (['termMonths', 'lockIn', 'rentFreeMonths', 'usefulLifeM'].includes(k)) return months(v);
            if (k === 'area') return `${fmtNum(v)} ${String(ImportState.fields.areaUnit?.value || '')}`.trim();
            return fmtNum(v);
        default: return String(v);
    }
}

const SOURCE: Record<ImportField['source'], [string, string]> = { ai: ['AI', 'badge-info'], rules: ['Found', 'badge-ok'], edited: ['Edited', 'badge-pending'], user: ['Added', 'badge-pending'], settings: ['From Settings', 'badge-neutral'] };
const WIDE: TermKind[] = ['escalation', 'extension', 'kibor'];

/** One term: its name and where the value came from, an input, and the contract's words (which find it in the document). */
function TermField({ k, need, removable, onChange, onJump }: { k: string; need?: boolean; removable?: boolean; onChange: () => void; onJump: (k: string) => void }) {
    const f = ImportState.fields[k], missing = need && !filled(k), def = TERMS[k];
    const [label, cls] = f ? SOURCE[f.source] : ['', ''];
    const located = !!f && f.start != null && f.start >= 0;
    return (
        <div className={'tf' + (missing ? ' tf-missing' : '') + (def && WIDE.includes(def.kind) ? ' tf-wide' : '')} data-term={k}>
            <div className="tf-top">
                <label className="tf-l" htmlFor={'rv-' + k}><i style={{ background: FIELD_COLORS[k] || 'var(--line-2)' }} />{termLabel(k)}</label>
                {missing ? <span className="badge badge-bad">Needed</span> : f ? <span className={'badge ' + cls}>{label}</span> : null}
                {removable ? <button type="button" className="tf-x" aria-label={`Remove ${termLabel(k)}`} title="Remove this term" onClick={() => { removeTerm(k); onChange(); }}><Ic d={I.close} size={14} /></button> : null}
            </div>
            <div className="tf-in"><TermInput k={k} onChange={onChange} /></div>
            {f && f.snippet
                ? located ? <button type="button" className="tf-quote" data-jump={k} title="Show in the document" onClick={() => onJump(k)}>“{f.snippet.trim()}”</button> : <q className="tf-quote">{f.snippet.trim()}</q>
                : missing ? <p className="tf-hint">{def?.hint || 'Not found in the contract. Enter it from the contract or your records.'}</p>
                : f && f.source === 'settings' ? <p className="tf-hint">Not in the contract; your default from Settings.</p>
                : !f && def?.hint && def.kind !== 'text' ? <p className="tf-hint">{def.hint}</p> : null}
            {f && f.derived ? <p className="tf-hint">Worked out from the dates.</p> : null}
        </div>
    );
}

/** Everything read from the contract, editable, in cards: the essentials (with their progress), the asset, other terms. */
function ReviewForm({ notes, onChange, onJump }: { notes: string[]; onChange: () => void; onJump: (k: string) => void }) {
    const S = ImportState, ess = essentials(S.role), ready = ess.filter(filled).length;
    const others = OTHER_TERMS.filter(k => !ess.includes(k) && S.fields[k]);
    const addable = OTHER_TERMS.filter(k => !ess.includes(k) && !S.fields[k]);
    const field = (k: string, extra: { need?: boolean; removable?: boolean } = {}) => <TermField key={k} k={k} {...extra} onChange={onChange} onJump={onJump} />;
    const head = (title: string, sub: string, aside?: ReactNode) => <header className="rv-card-h"><div><h3>{title}</h3><p>{sub}</p></div>{aside}</header>;
    return (
        <div className="rv">
            <section className="card rv-card">
                {head('Essentials', 'What the lease needs to be measured.', <span className={'rv-count' + (ready === ess.length ? ' is-ok' : '')}>{ready} of {ess.length} ready</span>)}
                <div className="rv-meter" role="img" aria-label={`${ready} of ${ess.length} essential terms ready`}><span style={{ width: `${ready / ess.length * 100}%` }} /></div>
                <div className="rv-role"><span>We are the</span>
                    <div className="seg seg-sm" role="group" aria-label="Our side of the lease">
                        {(['lessee', 'lessor'] as const).map(r => <button type="button" key={r} aria-pressed={S.role === r} onClick={() => { S.role = r; onChange(); }}>{r === 'lessee' ? 'Lessee (we pay rent)' : 'Lessor (we receive it)'}</button>)}
                    </div>
                </div>
                <div className="tf-grid">{ess.map(k => field(k, { need: true }))}</div>
            </section>
            <section className="card rv-card">
                {head('Asset', 'How the lease is named and found in the register.')}
                <div className="tf-grid">{ASSET_TERMS.map(k => field(k))}</div>
            </section>
            <section className="card rv-card">
                {head('Options and other terms', 'Increases, deposits, renewals and other clauses.')}
                {others.length ? <div className="tf-grid">{others.map(k => field(k, { removable: true }))}</div> : <p className="rv-empty">None found. Add any the contract has.</p>}
                {addable.length ? <select className="rv-add" value="" aria-label="Add a term" onChange={e => { const k = e.target.value; if (!k) return; setTerm(k, TERMS[k]?.kind === 'number' || TERMS[k]?.kind === 'date' || TERMS[k]?.kind === 'text' ? '' : {}); onChange(); }}>
                    <option value="">+ Add a term from the contract…</option>
                    {addable.map(k => <option key={k} value={k}>{termLabel(k)}</option>)}
                </select> : null}
            </section>
            {notes.length > 0 && <section className="card rv-card">
                {head('Judgements to make', 'Points the contract leaves to you; they are kept in the lease notes.')}
                <ul className="rv-notes">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </section>}
        </div>
    );
}

/** The headline figure of a measurement, for the review bar. */
function headline(res: NonNullable<ReturnType<typeof run>>, cur: string): [string, string] {
    return res.mode === 'lessee' ? [`Lease liability (${cur})`, fmtNum(res.initial.liability)]
        : res.mode === 'lessor-finance' ? [`Net investment (${cur})`, fmtNum(res.initial.netInvestment)]
        : res.mode === 'lessor-operating' ? [`Income a month (${cur})`, fmtNum(res.initial.monthlyIncome)]
        : [`Expense a month (${cur})`, fmtNum(res.initial.monthlyExpense)];
}

/** Follows the review down the page: how many essentials are ready, the measurement once they are, and the way on. */
function ReviewBar({ p, onNext }: { p: ImportParams; onNext: () => void }) {
    const ess = essentials(ImportState.role), missing = ess.filter(k => !filled(k)), done = ess.length - missing.length;
    const m = missing.length ? null : measured();
    const fig = m && m.res ? headline(m.res, m.lease.currency) : null;
    const open = () => go('entry', { mode: 'new', prefill: measured().lease }, { reset: true });
    const C = 2 * Math.PI * 15;
    return (
        <div className="imp-bar" id="actions">
            <div className="imp-bar-status">
                <svg className={'imp-ring' + (missing.length ? '' : ' is-ok')} viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" /><circle cx="18" cy="18" r="15" strokeDasharray={`${done / ess.length * C} ${C}`} /></svg>
                <div>
                    <b>{missing.length ? `${done} of ${ess.length} essentials ready` : fig ? `${fig[0]}: ${fig[1]}` : 'All essentials ready'}</b>
                    <span>{missing.length ? `Still needed: ${missing.map(termLabel).join(', ')}` : fig ? 'Measured from the terms as reviewed. It updates as you edit.' : 'These terms cannot be measured yet. Check the start date, term and rent.'}</span>
                </div>
            </div>
            <div className="btn-row">
                {p.attachTo && <button className="btn btn-ghost" id="imp-attach" onClick={() => attach(p)}>Attach to {p.attachTo}</button>}
                {missing.length ? <button className="btn btn-ghost" id="imp-anyway" onClick={open}>Continue in the form anyway</button> : null}
                <button className="btn" id="imp-next" disabled={!!missing.length || !fig} onClick={onNext}>Continue to confirm<Ic d={I.chevron} size={15} /></button>
            </div>
        </div>
    );
}

/** Terms on the confirm step, in the order an accountant reads a lease. */
const SUMMARY: [string, string[]][] = [
    ['Parties and asset', ['counterpartyLessor', 'counterpartyLessee', 'name', 'assetClass', 'location', 'contractNumber', 'area']],
    ['Term', ['commencement', 'termMonths', 'endDate', 'lockIn', 'notice', 'rentFreeMonths']],
    ['Payments', ['payment', 'freqM', 'timing', 'currency', 'escalation', 'deposit', 'serviceComponent', 'discountRate', 'kibor']],
    ['Options and other terms', ['extension', 'purchase', 'rvg', 'penalty', 'idc', 'usefulLifeM']],
];

/** The lease as reviewed, measured; confirming opens it in the lease form, where nothing is saved until it is submitted. */
function ConfirmStage({ p, notes, onBack }: { p: ImportParams; notes: string[]; onBack: () => void }) {
    const { lease, res } = measured(), cur = lease.currency;
    const open = () => go('entry', { mode: 'new', prefill: lease }, { reset: true });
    const sum = (xs: number[]) => xs.reduce((s, x) => s + (Number(x) || 0), 0);
    const figs: [string, string, string?][] = !res ? []
        : res.mode === 'lessee' ? [['Lease liability at start', fmtNum(res.initial.liability), cur], ['Right-of-use asset at start', fmtNum(res.initial.rou), cur], ['Rent over the lease', fmtNum(sum(res.rows.map(r => r.payAdv + r.payArr))), cur], ['Interest over the lease', fmtNum(sum(res.rows.map(r => r.int))), `at ${(res.initial.annualRate || 0).toFixed(2)}% a year`]]
        : res.mode === 'lessor-finance' ? [['Net investment at start', fmtNum(res.initial.netInvestment), cur], ['Implicit rate', `${(res.initial.annualRate || 0).toFixed(2)}%`, 'a year']]
        : res.mode === 'lessor-operating' ? [['Income a month', fmtNum(res.initial.monthlyIncome), cur], ['Income over the lease', fmtNum(res.initial.total), cur]]
        : [['Expense a month', fmtNum(res.initial.monthlyExpense), cur], ['Expense over the lease', fmtNum(res.initial.total), 'short-term or low-value: expensed']];
    const treatment = !res ? '' : res.mode === 'lessee' ? 'On the balance sheet: a lease liability and a right-of-use asset.' : res.mode === 'lessor-finance' ? 'A finance lease: a net investment in the lease.' : res.mode === 'lessor-operating' ? 'An operating lease: income on a straight line.' : 'Exempt: payments are expensed as they fall due.';
    return (
        <div className="imp-confirm">
            <section className="card imp-confirm-main">
                <header className="imp-confirm-h">
                    <div><h2>Check and confirm</h2><p>{treatment} Measured from the terms as you reviewed them.</p></div>
                    <span className="badge badge-ok">{essentials(ImportState.role).length} of {essentials(ImportState.role).length} essentials</span>
                </header>
                {res ? <div className="imp-figs">{figs.map(([l, v, s]) => <div className="imp-fig" key={l}><span>{l}</span><b>{v}</b>{s ? <small>{s}</small> : null}</div>)}</div>
                    : <p className="banner warn imp-banner">These terms cannot be measured yet. Go back and check the start date, term and rent.</p>}
                <div className="imp-summary">
                    {SUMMARY.map(([title, keys]) => {
                        const rows = keys.filter(k => ImportState.fields[k] && k !== 'areaUnit' && termText(k) !== '');
                        if (title === 'Term' && !ImportState.fields.endDate) rows.push('__end');
                        if (!rows.length) return null;
                        return <div className="imp-sum-g" key={title}><h4>{title}</h4><dl>{rows.map(k => k === '__end'
                            ? <div key={k}><dt>Ends</dt><dd>{fmtDate(contractEnd(lease))}</dd></div>
                            : <div key={k}><dt>{termLabel(k)}</dt><dd>{termText(k)}{ImportState.fields[k].source === 'edited' || ImportState.fields[k].source === 'user' ? <span className="imp-sum-tag">{SOURCE[ImportState.fields[k].source][0]}</span> : null}</dd></div>)}</dl></div>;
                    })}
                </div>
                {notes.length ? <div className="imp-sum-notes"><h4>Judgements to make</h4><ul className="rv-notes">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul></div> : null}
            </section>
            <aside className="card imp-next">
                <h3>What happens next</h3>
                <ol className="imp-next-steps">
                    <li><b>The lease form opens</b><span>with these terms filled in and the contract attached.</span></li>
                    <li><b>Finish the details</b><span>such as whether options are reasonably certain.</span></li>
                    <li><b>Submit it</b><span>{SETTINGS.requireApproval ? 'and it goes for approval.' : 'and the lease is saved.'}</span></li>
                </ol>
                <button className="btn imp-go" id="imp-create" disabled={!res} onClick={open}>Confirm and open in lease form<Ic d={I.chevron} size={15} /></button>
                {p.attachTo && <button className="btn btn-ghost imp-go" id="imp-attach" onClick={() => attach(p)}>Attach to {p.attachTo} instead</button>}
                <button className="btn btn-ghost imp-go" onClick={onBack}><Ic d={I.back} size={15} />Back to edit</button>
                <button className="btn btn-ghost imp-go" id="imp-ask" {...gate('ai.use')} onClick={() => go('ai', { contract: { name: ImportState.name, text: ImportState.text.slice(0, 60000) } }, { reset: true })}><Ic d={I.sparkle} size={15} />Ask AI about this contract</button>
                <p className="note rv-safe"><Ic d={I.lock} size={13} />Nothing is saved until you submit the lease form.</p>
            </aside>
        </div>
    );
}

/** What a contract should say, beside the upload. */
function ContractGuide() {
    return <>
        <h3>What your contract should state</h3>
        <p className="note">The essentials for measuring the lease. Anything missing can be filled in during review.</p>
        <ul className="imp-checklist">
            {[['The parties', 'who leases to whom'], ['Start date and length', 'or the end date'], ['Rent', 'the amount, how often, and whether paid in advance or arrears'], ['Currency', 'otherwise your reporting currency'], ['Interest or markup rate', 'if stated; otherwise your borrowing rate']].map(([b, s]) =>
                <li key={b}><span className="imp-check"><Ic d={I.check} size={12} /></span><span><b>{b}</b><small>{s}</small></span></li>)}
        </ul>
        <h4>Also read when present</h4>
        <div className="imp-guide-chips">{['Yearly increases', 'Security deposit', 'Rent-free period', 'Renewal or extension', 'Lock-in and notice', 'Termination penalty', 'Purchase option', 'Residual value guarantee', 'Service charges', 'Initial direct costs'].map(t => <span key={t}>{t}</span>)}</div>
    </>;
}

type LoadSample = (s: SampleContract, f: SampleFormat) => Promise<void>;
const FORMAT_ICON: Record<SampleFormat, string> = { pdf: I.doc, docx: I.doc, txt: I.doc, jpg: I.image, xlsx: I.sheet };

/** Opens a sample as if it had been uploaded; shows that it is loading (a PDF or Word reader may load first). */
function SampleButton({ s, f, onLoad }: { s: SampleContract; f: SampleFormat; onLoad: LoadSample }) {
    const [busy, setBusy] = useState(false);
    return <button type="button" className="btn btn-sm" data-sample={s.id} data-format={f} disabled={busy} onClick={async () => { setBusy(true); try { await onLoad(s, f); } finally { setBusy(false); } }}>
        {busy ? <><span className="spinner" aria-hidden="true" />Opening…</> : 'Use this sample'}</button>;
}
function DownloadSample({ s, f }: { s: SampleContract; f: SampleFormat }) {
    const download = async () => { try { const file = await sampleFile(s, f); await saveFile(sampleName(s, f), file); } catch (e) { toast(errMessage(e)); } };
    return <button type="button" className="btn btn-ghost btn-sm" title={`Download ${sampleName(s, f)}`} onClick={() => void download()}><Ic d={I.download} size={14} />Download</button>;
}

/** One sample contract, in the format chosen (PDF, Word or text; the scanned one only as an image). */
function SampleCard({ s, onLoad }: { s: SampleContract; onLoad: LoadSample }) {
    const [f, setF] = useState<SampleFormat>(s.formats[0]);
    return (
        <article className="card imp-sample">
            <div className="imp-sample-top">
                <span className={'imp-sample-ic is-' + f}><Ic d={FORMAT_ICON[f]} size={20} /><small>{f.toUpperCase()}</small></span>
                {s.formats.length > 1
                    ? <div className="seg seg-sm imp-sample-fmt" role="group" aria-label={`Format of the ${s.title} sample`}>{s.formats.map(x => <button type="button" key={x} aria-pressed={f === x} onClick={() => setF(x)}>{FORMAT_LABELS[x]}</button>)}</div>
                    : <span className="imp-sample-only">{FORMAT_LABELS[f]} only</span>}
            </div>
            <h4>{s.title}</h4>
            <span className="imp-sample-tags">{s.tags.map(t => <span key={t} className={'badge ' + (t === 'Has gaps' || t === 'Needs AI' ? 'badge-pending' : 'badge-neutral')}>{t}</span>)}</span>
            <p>{s.summary}</p>
            <div className="imp-sample-foot"><SampleButton s={s} f={f} onLoad={onLoad} /><DownloadSample s={s} f={f} /></div>
        </article>
    );
}

/** Sample contracts to try the import with, in the formats a contract usually arrives in. */
function Samples({ onLoad }: { onLoad: LoadSample }) {
    return (
        <section className="imp-samples" id="samples">
            <div className="imp-sec-h"><h3>No contract to hand? Try a sample</h3><p>Fictional contracts with typical terms: as PDF, Word or text, a scanned page, terms sent by email, and a spreadsheet of many leases. Open one to see the reading, the checklist and the review, or download it to upload yourself.</p></div>
            <div className="imp-sample-grid">{SAMPLE_CONTRACTS.map(s => <SampleCard key={s.id} s={s} onLoad={onLoad} />)}</div>
        </section>
    );
}

function TapeTable({ tv }: { tv: TapeView }) {
    const { leases, issues, liab } = tv;
    return (
        <div className="scroll-x"><table><thead><tr><th>Lease</th><th>Check</th><th>Description</th><th>Commences</th><th className="num">Months</th><th className="num">Payment</th><th className="num">Rate %</th><th className="num">Liability</th></tr></thead><tbody>
            {leases.map((l, i) => <tr key={i}><td><b>{l.id}</b></td><td>{issues[i].length ? <span className="badge badge-bad">{issues[i].includes('ID already exists') && issues[i].length === 1 ? 'ID already exists' : `Missing ${issues[i].join(', ')}`}</span> : <span className="badge badge-ok">Ready</span>}</td><td className="tape-desc">{l.name}</td><td>{fmtDate(l.terms.commencement)}</td><td className="num">{l.terms.termMonths || '—'}</td><td className="num">{fmtNum(l.terms.payment)}</td><td className="num">{l.terms.discountRate || '—'}</td><td className="num">{issues[i].length ? '—' : liab[i]}</td></tr>)}
        </tbody></table></div>
    );
}
