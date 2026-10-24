import { useRef, useState, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import type { ScreenProps } from './registry';
import type { ScreenParamMap } from '../domain/nav';
import { go } from '../domain/nav';
import { ASSET_CLASSES, SETTINGS, engineSettings } from '../domain/settings';
import { blankLease } from '../domain/lease';
import { Store } from '../domain/store';
import { gate, logHistory } from '../domain/enterprise';
import { num as N, run } from '../domain/engine';
import { Extractor, type ExtractHit } from '../domain/extractor';
import { FIELD_COLORS, FIELD_LABELS, fmtField, highlightText } from '../domain/contractFields';
import { aiErr, getSample } from '../domain/ai';
import { nextLeaseId } from '../domain/lease';
import { toast } from '../utils/uiStore';
import { LIBS, exportFile, loadLib, type SheetValue } from '../utils/files';
import { deepClone, errMessage, fmtNum } from '../utils/format';
import { fmtDate } from '../utils/dates';
import type { DocumentHit, Lease, LeaseDocument } from '../types/lease';

type ImportParams = ScreenParamMap['import'];

/* ======================================================================
   Contract import. The document stays in module state, so it is still
   there when the user leaves the screen and comes back.
   ====================================================================== */
interface ImportField { value: unknown; start: number; end: number; snippet: string; derived?: boolean; source: 'rules' | 'ai' }
interface SheetData { name: string; rows: SheetCell[][] }
interface ImportStateT {
    text: string; name: string; kind: string; fields: Record<string, ImportField>; notes: string[]; hits: DocumentHit[];
    pages: PdfPage[]; sheet: SheetData[] | null; ai: boolean; file?: File; pdf?: PdfDocument; image?: File; allHits?: ExtractHit[];
}
const ImportState: ImportStateT = { text: '', name: '', kind: '', fields: {}, notes: [], hits: [], pages: [], sheet: null, ai: false };

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
type Legend = { k: 'none' } | { k: 'chips'; used: string[] } | { k: 'tape'; text: string };
type DocView = { k: 'none' } | { k: 'empty' } | { k: 'html'; html: string } | { k: 'tape'; tape: TapeView };
type Actions = { k: 'hidden' } | { k: 'next'; seq: number; rate: string; ratePh: string } | { k: 'tape'; tape: TapeView };
interface View {
    docShown: boolean; docName: string; docMeta: string; legend: Legend; doc: DocView; wsNormal: boolean;
    fields: FieldsView; aiNotes: number; aiDisabled: boolean; actions: Actions;
}
type SetView = (f: (v: View) => View) => void;

const initialView = (): View => ({ docShown: false, docName: '', docMeta: '', legend: { k: 'none' }, doc: { k: 'none' }, wsNormal: false, fields: { k: 'intro' }, aiNotes: 0, aiDisabled: true, actions: { k: 'hidden' } });

async function handleFile(f: File, set: SetView) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    Object.assign(ImportState, { name: f.name, kind: ext, text: '', pages: [], sheet: null, ai: false, file: f });
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
            ImportState.text = out.join('\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
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
        return { ...v, docMeta: S.kind === 'pdf' ? 'No text layer: this looks like a scanned PDF.' : 'This is an image.', doc: { k: 'empty' }, fields: { k: 'nothing' }, aiNotes: 0, aiDisabled: false };
    }
    if (!S.ai) {
        const found = Extractor.run(S.text);
        const r = Extractor.toLease(found, S.text);
        S.fields = {}; Object.entries(r.fields).forEach(([k, f]) => S.fields[k] = { value: f.value, start: f.hit.start, end: f.hit.end, snippet: f.hit.snippet, derived: f.derived, source: 'rules' });
        S.notes = r.notes;
        S.allHits = found;
    }
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
    const rate = S.fields.discountRate ? S.fields.discountRate.value : (S.fields.kibor ? '' : SETTINGS.defaultRate || '');
    return {
        ...v, fields: { k: 'list', fields: { ...S.fields }, notes: S.notes.slice() }, aiNotes: 0,
        actions: { k: 'next', seq: ++drawSeq, rate: String(rate ?? ''), ratePh: S.fields.kibor ? 'KIBOR at commencement + spread' : 'Incremental borrowing rate' },
    };
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
        legend: { k: 'tape', text: `Matched columns: ${Object.entries(tape.map).map(([k, i]) => `${tape.head[i]} → ${k}`).join(', ')}` },
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

/* ---- Screen ---- */
export function ImportPage({ params: p }: ScreenProps<'import'>) {
    const [view, setView] = useState<View>(() => ImportState.text && !p.fresh ? analyse(initialView()) : initialView());
    const [over, setOver] = useState(false);
    const [pasteShown, setPasteShown] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    const pasteRef = useRef<HTMLTextAreaElement>(null);
    const docRef = useRef<HTMLDivElement>(null);
    const fieldsRef = useRef<HTMLDivElement>(null);
    const roleRef = useRef<HTMLSelectElement>(null);
    const rateRef = useRef<HTMLInputElement>(null);

    const showPaste = () => { flushSync(() => setPasteShown(true)); pasteRef.current?.focus(); };
    const readPasted = () => {
        const t = (pasteRef.current?.value || '').trim(); if (!t) return toast('Paste the contract text first.');
        Object.assign(ImportState, { text: t, name: 'Pasted text', kind: 'text', pages: [], sheet: null, ai: false });
        setView(v => analyse(v));
    };
    const focusHit = (k: string) => {
        const dv = docRef.current; if (!dv) return;
        const m = dv.querySelector(`mark[data-field="${k}"]`);
        dv.querySelectorAll('mark.focus').forEach(x => x.classList.remove('focus'));
        if (m) { m.classList.add('focus'); m.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    };
    const onDocClick = (e: MouseEvent<HTMLDivElement>) => {
        const m = (e.target as HTMLElement).closest<HTMLElement>('mark');
        if (!m || !docRef.current?.contains(m)) return;
        const row = fieldsRef.current?.querySelector(`[data-jump="${m.dataset.field}"]`);
        if (row) row.closest('.xf')?.scrollIntoView({ block: 'center' });
    };

    const F = view.fields;
    const A = view.actions;
    return (
        <div className="import">
            <div className="stack">
                <div className={'drop' + (over ? ' over' : '')} id="drop" tabIndex={0} role="button" aria-label="Choose a contract file"
                    onClick={() => fileRef.current?.click()}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
                    onDragOver={e => { e.preventDefault(); setOver(true); }}
                    onDragLeave={() => setOver(false)}
                    onDrop={e => { e.preventDefault(); setOver(false); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0], setView); }}>
                    <input type="file" id="file" ref={fileRef} hidden accept=".pdf,.docx,.xlsx,.xls,.csv,.txt,.md,.png,.jpg,.jpeg,.webp" onChange={e => { const fl = e.currentTarget.files; if (fl && fl[0]) handleFile(fl[0], setView); }} />
                    <strong>Drop a lease contract here or choose a file</strong>
                    <p className="note" style={{ margin: '6px auto 0' }}>PDF, Word (.docx), Excel, CSV or text. Photos and scanned PDFs are read by AI. Files are read in your browser; only AI reading sends text to Claude.</p>
                </div>
                <div className="card" id="doc-card" hidden={!view.docShown}>
                    <div className="section-head"><div><h3 id="doc-name">{view.docName}</h3><p className="note" id="doc-meta">{view.docMeta}</p></div><div className="btn-row"><button className="btn btn-ghost btn-sm" id="doc-paste" onClick={showPaste}>Paste text instead</button></div></div>
                    <div className="pad" id="legend" style={{ paddingBottom: 0 }}>
                        {view.legend.k === 'chips' && view.legend.used.map(k => <span className="legend-chip" key={k}><i style={{ background: FIELD_COLORS[k] || '#eee' }}></i>{FIELD_LABELS[k] || k}</span>)}
                        {view.legend.k === 'tape' && <p className="note">{view.legend.text}</p>}
                    </div>
                    {view.doc.k === 'html'
                        ? <div className="doc-view" id="doc-view" ref={docRef} style={view.wsNormal ? { whiteSpace: 'normal' } : undefined} onClick={onDocClick} dangerouslySetInnerHTML={{ __html: view.doc.html }} />
                        : <div className="doc-view" id="doc-view" ref={docRef} style={view.wsNormal ? { whiteSpace: 'normal' } : undefined} onClick={onDocClick}>
                            {view.doc.k === 'empty' && <p className="empty">No readable text. Use “Read with AI” to read it from the page images, or paste the text.</p>}
                            {view.doc.k === 'tape' && <TapeTable tv={view.doc.tape} />}
                        </div>}
                </div>
                <div className="card pad" id="paste-card" hidden={!pasteShown}><label htmlFor="paste">Paste the contract text</label><textarea id="paste" rows={10} ref={pasteRef}></textarea><div className="form-actions"><button className="btn" id="paste-go" onClick={readPasted}>Read terms</button></div></div>
                <div className="card pad"><h3>Bring in existing leases from a spreadsheet</h3><p className="note">For migrating a portfolio: one row per lease. Download the template, fill it in, then drop it above. Each row becomes a draft for review.</p><div className="btn-row" style={{ marginTop: '10px' }}><button className="btn btn-ghost" id="tpl-x" onClick={() => exportFile('xlsx', 'Lease_import_template', [{ name: 'Leases', rows: TEMPLATE_ROWS }])}>Template (.xlsx)</button><button className="btn btn-ghost" id="tpl-c" onClick={() => exportFile('csv', 'Lease_import_template', [{ name: 'Leases', rows: TEMPLATE_ROWS }])}>Template (.csv)</button><button className="btn btn-ghost" id="show-paste" onClick={showPaste}>Paste contract text</button></div></div>
            </div>
            <div className="stack">
                <div className="card" id="fields-card"><div className="section-head"><h3>Terms found</h3><button className="btn btn-ghost btn-sm" id="ai-read" disabled={view.aiDisabled} {...gate('ai.use')} onClick={() => aiExtract(setView)}>Read with AI</button></div>
                    <div className="pad" id="fields" ref={fieldsRef}>
                        {Array.from({ length: view.aiNotes }, (_, i) => <p className="note" key={'n' + i}>AI is not available in this view. Open the page in Claude to use it.</p>)}
                        {F.k === 'intro' && <p className="note">Terms appear here with the sentence they came from. Select a term to jump to it in the document.</p>}
                        {F.k === 'reading' && <p className="note"><span className="spinner"></span> Reading the file…</p>}
                        {F.k === 'error' && <p className="note">{F.msg}</p>}
                        {F.k === 'nothing' && <p className="note">Nothing found yet.</p>}
                        {F.k === 'aiBusy' && <p className="note"><span className="spinner"></span> Claude is reading the contract. This can take up to a minute. <button className="link" id="ai-stop" onClick={() => F.ctl.abort()}>Stop</button></p>}
                        {F.k === 'tape' && <p>{F.ready} of {F.total} rows are ready. Rows with problems are skipped; fix them in the sheet and import again.</p>}
                        {F.k === 'list' && <FieldList fields={F.fields} notes={F.notes} onJump={focusHit} />}
                    </div>
                </div>
                <div className="card pad" id="actions" hidden={A.k === 'hidden'}>
                    {A.k === 'next' && <>
                        <h3>Next step</h3><p className="note" style={{ marginBottom: '10px' }}>Review the terms, then open them in the lease form. Nothing is saved until you submit the form.</p>
                        <div className="row2"><div className="fg"><label htmlFor="imp-role">We are the</label><select id="imp-role" key={'r' + A.seq} ref={roleRef} defaultValue="lessee"><option value="lessee">Lessee</option><option value="lessor">Lessor</option></select></div><div className="fg"><label htmlFor="imp-rate">Discount rate % (if not in the contract)</label><input type="number" step="any" id="imp-rate" key={'t' + A.seq} ref={rateRef} defaultValue={A.rate} placeholder={A.ratePh} /></div></div>
                        <div className="btn-row">
                            {p.attachTo && <button className="btn" id="imp-attach" onClick={() => attach(p)}>Attach to {p.attachTo}</button>}
                            <button className={'btn ' + (p.attachTo ? 'btn-ghost' : '')} id="imp-create" onClick={() => { const l = leaseFromImport(roleRef.current?.value || 'lessee', rateRef.current?.value || ''); go('entry', { mode: 'new', prefill: l }, { reset: true }); }}>Open in lease form</button>
                            <button className="btn btn-ghost" id="imp-ask" {...gate('ai.use')} onClick={() => go('ai', { contract: { name: ImportState.name, text: ImportState.text.slice(0, 60000) } }, { reset: true })}>Ask AI about this contract</button>
                        </div>
                    </>}
                    {A.k === 'tape' && <>
                        <h3>Import</h3><p className="note" style={{ marginBottom: '10px' }}>Ready rows are added as {SETTINGS.requireApproval ? 'leases awaiting approval' : 'active leases'}.</p><button className="btn" id="tape-go" onClick={() => importTape(A.tape)}>Import {A.tape.leases.filter((_, i) => !A.tape.issues[i].length).length} leases</button>
                    </>}
                </div>
            </div>
        </div>
    );
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
    toast(`${n} leases imported`); ImportState.text = ''; go('register', {}, { reset: true });
}

function FieldList({ fields, notes, onJump }: { fields: Record<string, ImportField>; notes: string[]; onJump: (k: string) => void }) {
    const order = Object.keys(FIELD_LABELS).filter(k => fields[k]);
    return <>
        {order.length ? order.map(k => {
            const f = fields[k];
            return (
                <div className="xf" key={k}><strong>{FIELD_LABELS[k]}</strong><span>{`${fmtField(k, f.value)} `}{f.source === 'ai' && <span className="badge badge-info">AI</span>}{f.derived && <>{' '}<span className="note">(from dates)</span></>}</span>
                    <div className="src">{f.snippet ? `“${f.snippet.slice(0, 140)}${f.snippet.length > 140 ? '…' : ''}” ` : ''}{f.start != null && f.start >= 0 && <button className="link" data-jump={k} onClick={() => onJump(k)}>Show</button>}</div></div>
            );
        }) : <p className="note">No terms recognised. Try “Read with AI”.</p>}
        {notes.length > 0 && <ul className="warn-list" style={{ marginTop: '12px' }}>{notes.map((n, i) => <li className="info" key={i}>{n}</li>)}</ul>}
    </>;
}

function TapeTable({ tv }: { tv: TapeView }) {
    const { leases, issues, liab } = tv;
    return (
        <div className="scroll-x"><table><thead><tr><th>Lease</th><th>Description</th><th>Commences</th><th className="num">Months</th><th className="num">Payment</th><th className="num">Rate %</th><th className="num">Liability</th><th>Check</th></tr></thead><tbody>
            {leases.map((l, i) => <tr key={i}><td>{l.id}</td><td>{l.name}</td><td>{fmtDate(l.terms.commencement)}</td><td className="num">{l.terms.termMonths}</td><td className="num">{fmtNum(l.terms.payment)}</td><td className="num">{l.terms.discountRate || '—'}</td><td className="num">{issues[i].length ? '—' : liab[i]}</td><td>{issues[i].length ? <span className="badge badge-bad">Missing {issues[i].join(', ')}</span> : <span className="badge badge-ok">Ready</span>}</td></tr>)}
        </tbody></table></div>
    );
}
