/* ======================================================================
   Contract term extraction (rule-based; runs without AI)
   Returns candidate values for each lease field with the matching span,
   so the document view can highlight where each term came from.
   ====================================================================== */
import { addDays, monthsBetween } from './engine';

export type ExtractedValue =
    | string | number
    | { months: number }
    | { days: number }
    | { benchmark: string; spread: number }
    | { price: number | null }
    | { type: string; rate: number; everyM: number }
    | { months: number; certain: boolean }
    | { price: number | null; certain: boolean };

export interface ExtractExtra { currency?: string | null; freqM?: number; everyM?: number; unit?: string }
export interface ExtractHit { field: string; label: string; value: ExtractedValue; extra: ExtractExtra; start: number; end: number; snippet: string }
export interface ExtractedField { value: ExtractedValue; hit: ExtractHit; derived?: boolean }
export interface ExtractResult { fields: Record<string, ExtractedField>; notes: string[] }

interface Rule { field: string; label: string; re: RegExp; parse: (m: RegExpExecArray) => ExtractedValue | null; extra?: (m: RegExpExecArray) => ExtractExtra }

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, eighteen: 18, twenty: 20, 'twenty-four': 24, thirty: 30, 'thirty-six': 36, forty: 40, 'forty-eight': 48, sixty: 60, ninety: 90 };
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const CUR = '(?:Rs\\.?|PKR|Rupees|USD|US\\$|\\$|EUR|€|GBP|£|AED|SAR|CNY|CU)';
const AMT = '([0-9]{1,3}(?:[,\\s][0-9]{2,3})+(?:\\.[0-9]+)?|[0-9]+(?:\\.[0-9]+)?)\\s*(million|mn|m|lakh|lac|lacs|crore|k)?\\b';
const NUMW = '(\\d+|' + Object.keys(WORDS).join('|') + ')(?:\\s*\\((\\d+)\\))?';
const DATE = '(\\d{1,2}(?:st|nd|rd|th)?[\\s\\-/.](?:\\d{1,2}|[A-Za-z]{3,9})[\\s\\-/.,]+\\d{2,4}|[A-Za-z]{3,9}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})';

const toNum = (s: string, unit?: string): number => {
    let v = Number(String(s).replace(/[,\s]/g, ''));
    const u = (unit || '').toLowerCase();
    if (u === 'million' || u === 'mn' || u === 'm') v *= 1e6;
    else if (u === 'lakh' || u === 'lac' || u === 'lacs') v *= 1e5;
    else if (u === 'crore') v *= 1e7;
    else if (u === 'k') v *= 1e3;
    return v;
};
const wordNum = (w: string, paren?: string): number => paren ? Number(paren) : (WORDS[String(w).toLowerCase()] ?? Number(w));

/** Parse a contract date (day first, as in Pakistan and the UK) to YYYY-MM-DD. */
export function parseDate(s: string): string | null {
    s = s.trim().replace(/(\d)(st|nd|rd|th)/i, '$1').replace(/,/g, ' ');
    let m: RegExpMatchArray | null;
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return `${m[1]}-${m[2]}-${m[3]}`;
    if ((m = s.match(/^(\d{1,2})[\s/.-]+(\d{1,2})[\s/.-]+(\d{2,4})$/))) { // day first (Pakistan/UK convention)
        const y = m[3].length === 2 ? '20' + m[3] : m[3];
        return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    }
    if ((m = s.match(/^(\d{1,2})[\s/.-]+([A-Za-z]{3,9})[\s/.-]+(\d{2,4})$/))) {
        const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; if (!mo) return null;
        const y = m[3].length === 2 ? '20' + m[3] : m[3];
        return `${y}-${String(mo).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    }
    if ((m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{4})$/))) {
        const mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; if (!mo) return null;
        return `${m[3]}-${String(mo).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
    }
    return null;
}
const currencyOf = (s: string): string | null => /PKR|Rs|Rupee/i.test(s) ? 'PKR' : /USD|US\$|\$/.test(s) ? 'USD' : /EUR|€/.test(s) ? 'EUR' : /GBP|£/.test(s) ? 'GBP' : /AED/.test(s) ? 'AED' : /SAR/.test(s) ? 'SAR' : /CNY/.test(s) ? 'CNY' : null;

function cleanName(n: string): string { return n.replace(/,?\s*(?:a company|a firm|having|through|registered|incorporated|a partnership|an individual|s\/o|d\/o|w\/o).*$/i, '').replace(/[\s,]+$/, '').trim(); }
function classify(w: string): string {
    w = w.toLowerCase();
    if (/warehouse|godown|depot|cold/.test(w)) return 'warehouse';
    if (/office|floor|building|premises/.test(w)) return 'building';
    if (/shop|showroom|outlet|kiosk/.test(w)) return 'retail';
    if (/land|plot/.test(w)) return 'land';
    if (/vehicle|car|truck|bike|motorcycle/.test(w)) return 'vehicle';
    if (/server|laptop|printer|copier/.test(w)) return 'it';
    return 'equipment';
}

// Each rule: field, regex, parse(m) -> value, label
const RULES: Rule[] = [
    { field: 'lessor', label: 'Lessor', re: new RegExp(`(?:between|by and between)\\s+([A-Z][\\w&.,'()\\- ]{2,90}?)\\s*(?:,\\s*)?\\(?\\s*(?:hereinafter|herein after)[^)]{0,60}?(?:Lessor|Landlord|Owner)`, 'g'), parse: m => cleanName(m[1]) },
    { field: 'lessor', label: 'Lessor', re: /\b(?:Lessor|Landlord)\s*[:-]\s*([A-Z][^\n,;]{2,80})/g, parse: m => m[1].trim() },
    { field: 'lessee', label: 'Lessee', re: /\b(?:and|AND)\s+([A-Z][\w&.,'()\- ]{2,90}?)\s*(?:,\s*)?\(?\s*(?:hereinafter|herein after)[^)]{0,60}?(?:Lessee|Tenant)/g, parse: m => cleanName(m[1]) },
    { field: 'lessee', label: 'Lessee', re: /\b(?:Lessee|Tenant)\s*[:-]\s*([A-Z][^\n,;]{2,80})/g, parse: m => m[1].trim() },
    { field: 'commencement', label: 'Commencement date', re: new RegExp(`(?:commenc\\w*|effective|start(?:ing)?|w\\.?e\\.?f\\.?|with effect from)[^.\\n]{0,50}?${DATE}`, 'gi'), parse: m => parseDate(m[1]) },
    { field: 'endDate', label: 'End date', re: new RegExp(`(?:expir\\w*|end(?:ing)?\\s+on|until|till|up to|upto|terminat\\w* on)[^.\\n]{0,40}?${DATE}`, 'gi'), parse: m => parseDate(m[1]) },
    { field: 'termMonths', label: 'Lease term', re: new RegExp(`(?<!lock[- ]in\\s)(?<!lock[- ]in\\s\\w{0,10}\\s?)(?:period|term|tenure|duration)\\s+of\\s+${NUMW}\\s*(years?|months?)`, 'gi'), parse: m => wordNum(m[1], m[2]) * (/year/i.test(m[3]) ? 12 : 1) },
    { field: 'termMonths', label: 'Lease term', re: new RegExp(`${NUMW}\\s*(years?|months?)\\s+(?:lease|tenancy|term|period)`, 'gi'), parse: m => wordNum(m[1], m[2]) * (/year/i.test(m[3]) ? 12 : 1) },
    { field: 'payment', label: 'Rent / payment', re: new RegExp(`(?:monthly|quarterly|annual|yearly|half[- ]yearly)?\\s*(?:lease\\s+)?(?:rent(?:al)?|lease\\s+payment|instal(?:l)?ment|hire)\\b[^.\\n]{0,70}?(${CUR})\\s?${AMT}`, 'gi'), parse: m => toNum(m[2], m[3]), extra: m => ({ currency: currencyOf(m[1]) }) },
    { field: 'payment', label: 'Rent / payment', re: new RegExp(`(${CUR})\\s?${AMT}\\s*(?:\\/-)?\\s*(?:\\([^)]{0,80}\\)\\s*)?(?:per|a|each|every|\\/)\\s*(month|quarter|annum|year|p\\.?m\\.?|p\\.?a\\.?)`, 'gi'), parse: m => toNum(m[2], m[3]), extra: m => ({ currency: currencyOf(m[1]), freqM: /quarter/i.test(m[4]) ? 3 : /annum|year|p\.?a/i.test(m[4]) ? 12 : 1 }) },
    { field: 'freqM', label: 'Payment frequency', re: /\b(monthly|per month|every month|quarterly|per quarter|half[- ]yearly|bi-?annual(?:ly)?|six[- ]monthly|annually|yearly|per annum)\b/gi, parse: m => /quarter/i.test(m[1]) ? 3 : /half|bi-?annual|six/i.test(m[1]) ? 6 : /annual|yearly|annum/i.test(m[1]) ? 12 : 1 },
    { field: 'timing', label: 'Payment timing', re: /\b(in advance|advance(?:d)?\s+(?:rent|payment)|payable\s+in\s+advance|before the (?:\d+\w*|first|fifth|tenth) (?:day|of)|in arrears?|at the end of each)\b/gi, parse: m => /arrear|end of each/i.test(m[1]) ? 'arrears' : 'advance' },
    { field: 'escalation', label: 'Escalation', re: /(?:increase|increment|escalat\w*|enhance\w*|revis\w*)[^.\n]{0,80}?(\d+(?:\.\d+)?)\s*%[^.\n]{0,60}?(every\s+(?:year|annum|two years|2 years|three years|3 years)|annual(?:ly)?|per annum|after every\s+\w+\s+\w+|yearly)?/gi, parse: m => Number(m[1]), extra: m => ({ everyM: /two|2 years/i.test(m[2] || '') ? 24 : /three|3 years/i.test(m[2] || '') ? 36 : 12 }) },
    { field: 'deposit', label: 'Security deposit', re: new RegExp(`(?:security\\s+deposit|refundable\\s+deposit|advance\\s+deposit)[^.\\n]{0,60}?(${CUR})\\s?${AMT}`, 'gi'), parse: m => toNum(m[2], m[3]) },
    { field: 'deposit', label: 'Security deposit (months)', re: new RegExp(`(?:security\\s+deposit)[^.\\n]{0,40}?(?:equal to|equivalent to|of)\\s+${NUMW}\\s*months?['’]?\\s*rent`, 'gi'), parse: m => ({ months: wordNum(m[1], m[2]) }) },
    { field: 'area', label: 'Area', re: /([0-9][0-9,]*(?:\.\d+)?)\s*(sq\.?\s*(?:ft|feet|m|meters?|metres?)|square\s+(?:feet|foot|meters?|metres?)|sft|sqm|sq\.?\s*yds?|square\s+yards?|kanals?|marlas?|acres?)\b/gi, parse: m => Number(m[1].replace(/,/g, '')), extra: m => ({ unit: /m(et|$)|sqm/i.test(m[2]) && !/yd|yard/i.test(m[2]) ? 'sq m' : /yd|yard/i.test(m[2]) ? 'sq yd' : /kanal/i.test(m[2]) ? 'kanal' : /marla/i.test(m[2]) ? 'marla' : /acre/i.test(m[2]) ? 'acre' : 'sq ft' }) },
    { field: 'discountRate', label: 'Interest / discount rate', re: /(?:discount(?:ing)?|interest|implicit|borrowing|mark[- ]?up|profit)\s+rate[^.\n]{0,40}?(\d{1,2}(?:\.\d+)?)\s*%/gi, parse: m => Number(m[1]) },
    { field: 'kibor', label: 'Floating rate (KIBOR / benchmark)', re: /((?:\d{1,2}[- ]?(?:month|M)\s+)?(?:KIBOR|SOFR|LIBOR|EIBOR|SAIBOR))\s*(?:\+|plus)\s*(\d+(?:\.\d+)?)\s*(%|percent|bps|basis points)?/gi, parse: m => ({ benchmark: m[1], spread: /bp|basis/i.test(m[3] || '') ? Number(m[2]) / 100 : Number(m[2]) }) },
    { field: 'usefulLifeM', label: 'Useful / economic life', re: new RegExp(`(?:useful|economic)\\s+life[^.\\n]{0,30}?${NUMW}\\s*(years?|months?)`, 'gi'), parse: m => wordNum(m[1], m[2]) * (/year/i.test(m[3]) ? 12 : 1) },
    { field: 'extension', label: 'Renewal / extension option', re: new RegExp(`(?:renew\\w*|extend\\w*|extension)[^.\\n]{0,90}?(?:further|additional|another)?\\s*(?:period|term)?\\s*(?:of)?\\s*${NUMW}\\s*(years?|months?)`, 'gi'), parse: m => ({ months: wordNum(m[1], m[2]) * (/year/i.test(m[3]) ? 12 : 1) }) },
    { field: 'notice', label: 'Termination notice', re: new RegExp(`${NUMW}\\s*(days?|months?)['’]?\\s*(?:prior\\s+)?(?:written\\s+)?notice`, 'gi'), parse: m => ({ days: wordNum(m[1], m[2]) * (/month/i.test(m[3]) ? 30 : 1) }) },
    { field: 'penalty', label: 'Termination penalty', re: new RegExp(`(?:early\\s+termination|terminat\\w*)[^.\\n]{0,80}?(?:penalty|compensation|forfeit\\w*)[^.\\n]{0,40}?(?:(${CUR})\\s?${AMT}|${NUMW}\\s*months?['’]?\\s*rent)`, 'gi'), parse: m => m[2] ? toNum(m[2], m[3]) : { months: wordNum(m[4], m[5]) } },
    { field: 'lockIn', label: 'Lock-in / non-cancellable period', re: new RegExp(`(?:lock[- ]in|non[- ]cancell?able)[^.\\n]{0,40}?${NUMW}\\s*(years?|months?)`, 'gi'), parse: m => wordNum(m[1], m[2]) * (/year/i.test(m[3]) ? 12 : 1) },
    { field: 'purchase', label: 'Purchase option', re: new RegExp(`(?:option to (?:purchase|buy|acquire)|purchase option|bargain purchase|transfer of ownership)[^.\\n]{0,90}?(?:(${CUR})\\s?${AMT})?`, 'gi'), parse: m => ({ price: m[2] ? toNum(m[2], m[3]) : null }) },
    { field: 'rvg', label: 'Residual value guarantee', re: new RegExp(`(?:residual value)[^.\\n]{0,40}?guarant\\w*[^.\\n]{0,40}?(${CUR})\\s?${AMT}`, 'gi'), parse: m => toNum(m[2], m[3]) },
    { field: 'rentFree', label: 'Rent-free / fit-out period', re: new RegExp(`(?:rent[- ]free|fit[- ]?out|free\\s+period|grace\\s+period\\s+for\\s+rent)[^.\\n]{0,30}?${NUMW}\\s*(months?|days?)`, 'gi'), parse: m => Math.round(wordNum(m[1], m[2]) / (/day/i.test(m[3]) ? 30 : 1)) },
    { field: 'service', label: 'Maintenance / service charge', re: new RegExp(`(?:maintenance|service)\\s+charges?[^.\\n]{0,50}?(${CUR})\\s?${AMT}`, 'gi'), parse: m => toNum(m[2], m[3]) },
    { field: 'idc', label: 'Initial direct costs (commission, legal)', re: new RegExp(`(?:commission|brokerage|legal fee|stamp duty|registration fee)s?[^.\\n]{0,50}?(${CUR})\\s?${AMT}`, 'gi'), parse: m => toNum(m[2], m[3]) },
    { field: 'assetClass', label: 'Asset type', re: /\b(warehouse|godown|depot|cold\s+storage|office|floor|building|premises|shop|showroom|outlet|kiosk|land|plot|vehicles?|cars?|trucks?|bike|motorcycles?|forklifts?|generators?|machinery|machines?|equipment|servers?|laptops?|printers?|copiers?|chillers?|visi-?coolers?|freezers?)\b/gi, parse: m => classify(m[1]) },
    { field: 'currency', label: 'Currency', re: /\b(PKR|Rs\.?|Rupees|USD|US\$|EUR|GBP|AED|SAR|CNY)\b/g, parse: m => currencyOf(m[1]) },
];

export function run(text: string): ExtractHit[] {
    const found: ExtractHit[] = [];
    for (const rule of RULES) {
        rule.re.lastIndex = 0;
        let m: RegExpExecArray | null, guard = 0;
        while ((m = rule.re.exec(text)) && guard++ < 50) {
            let value: ExtractedValue | null;
            try { value = rule.parse(m); } catch { value = null; }
            if (value === null || value === undefined || (typeof value === 'number' && !isFinite(value))) continue;
            const extra = rule.extra ? rule.extra(m) : {};
            found.push({ field: rule.field, label: rule.label, value, extra, start: m.index, end: m.index + m[0].length, snippet: m[0] });
            if (m[0].length === 0) rule.re.lastIndex++;
        }
    }
    return found;
}

/* Views on a candidate's value for the fields that carry objects. */
const asNum = (v: ExtractedValue): number => v as number;
const monthsOf = (v: ExtractedValue): number => (v as { months: number }).months;

/** Pick the best candidate per field and turn them into lease form values. */
export function toLease(found: ExtractHit[], text: string): ExtractResult {
    const by = (f: string) => found.filter(x => x.field === f);
    const firstVal = (f: string): ExtractHit | null => { const a = by(f); return a.length ? a[0] : null; };
    const mode = (f: string): ExtractHit | null => {
        const a = by(f); if (!a.length) return null;
        const c: Record<string, number> = {}; a.forEach(x => { const k = JSON.stringify(x.value); c[k] = (c[k] || 0) + 1; });
        const k = Object.keys(c).sort((x, y) => c[y] - c[x])[0];
        return a.find(x => JSON.stringify(x.value) === k) || null;
    };
    const out: ExtractResult = { fields: {}, notes: [] };
    const set = (k: string, hit: ExtractHit | null, v?: ExtractedValue) => { if (hit) out.fields[k] = { value: v ?? hit.value, hit }; };
    set('counterpartyLessor', firstVal('lessor')); set('counterpartyLessee', firstVal('lessee'));
    const com = firstVal('commencement'); set('commencement', com);
    const end = firstVal('endDate');
    const lock = firstVal('lockIn');
    const terms = by('termMonths').filter(x => !lock || x.start !== lock.start && !/lock/i.test(text.slice(Math.max(0, x.start - 12), x.start)));
    const term = terms.length ? terms.sort((a, b) => asNum(b.value) - asNum(a.value))[0] : null;
    const fromDates = com && end ? monthsBetween(String(com.value), addDays(String(end.value), 1)) : null;
    if (fromDates && end) { out.fields.termMonths = { value: fromDates, hit: end, derived: true }; if (term && term.value !== fromDates) out.notes.push(`The stated term (${term.value} months) differs from the dates (${fromDates} months). Dates were used; check the contract.`); }
    else if (term) set('termMonths', term);
    if (lock && out.fields.termMonths && asNum(lock.value) < asNum(out.fields.termMonths.value)) out.notes.push(`Lock-in of ${lock.value} months is shorter than the contract term. If the lessee can exit after the lock-in without more than an insignificant penalty, the non-cancellable period is ${lock.value} months and later periods count only if the lessee is reasonably certain not to terminate (16.18-19, B34-B35).`);
    if (end) set('endDate', end);
    // payment: prefer the largest-frequency mention with an amount
    const pays = by('payment').filter(p => asNum(p.value) > 0);
    if (pays.length) { const p = pays[0]; set('payment', p); if (p.extra.freqM) out.fields.freqM = { value: p.extra.freqM, hit: p }; if (p.extra.currency) out.fields.currency = { value: p.extra.currency, hit: p }; }
    if (!out.fields.freqM) set('freqM', mode('freqM'));
    if (!out.fields.currency) set('currency', mode('currency'));
    set('timing', firstVal('timing'));
    const esc = firstVal('escalation'); if (esc) out.fields.escalation = { value: { type: 'fixed', rate: asNum(esc.value), everyM: esc.extra.everyM as number }, hit: esc };
    const dep = firstVal('deposit'); if (dep) out.fields.deposit = { value: typeof dep.value === 'object' && out.fields.payment ? monthsOf(dep.value) * asNum(out.fields.payment.value) : dep.value, hit: dep };
    const area = firstVal('area'); if (area) { out.fields.area = { value: area.value, hit: area }; out.fields.areaUnit = { value: area.extra.unit as string, hit: area }; }
    set('discountRate', firstVal('discountRate'));
    const kib = firstVal('kibor');
    if (kib) { const k = kib.value as { benchmark: string; spread: number }; out.fields.kibor = { value: kib.value, hit: kib }; out.notes.push(`Floating rate found (${k.benchmark} + ${k.spread}%). IFRS 16 uses the rate at commencement; later benchmark changes are remeasured at a revised rate (16.43).`); }
    set('usefulLifeM', firstVal('usefulLifeM'));
    const ext = firstVal('extension'); if (ext) out.fields.extension = { value: { months: monthsOf(ext.value), certain: false }, hit: ext };
    const pen = firstVal('penalty'); if (pen) out.fields.penalty = { value: typeof pen.value === 'object' && out.fields.payment ? monthsOf(pen.value) * asNum(out.fields.payment.value) : pen.value, hit: pen };
    set('notice', firstVal('notice'));
    set('lockIn', firstVal('lockIn'));
    const pur = firstVal('purchase'); if (pur) out.fields.purchase = { value: { price: (pur.value as { price: number | null }).price, certain: false }, hit: pur };
    set('rvg', firstVal('rvg')); set('rentFreeMonths', firstVal('rentFree')); set('serviceComponent', firstVal('service')); set('idc', firstVal('idc'));
    const classes = by('assetClass'); const specific = classes.filter(x => !/premises|floor|building/i.test(x.snippet));
    if (classes.length) {
        const pick = (specific.length ? specific : classes); const c: Record<string, number> = {};
        pick.forEach(x => { const k = String(x.value); c[k] = (c[k] || 0) + 1; });
        const v = Object.keys(c).sort((a, b) => c[b] - c[a])[0];
        out.fields.assetClass = { value: v, hit: pick.find(x => x.value === v) as ExtractHit };
    }
    if (/sub-?lease|sub-?let/i.test(text)) out.notes.push('The document mentions a sublease. A sublease is classified by reference to the right-of-use asset from the head lease (16.B58).');
    if (/maintenance|service charge|utilities/i.test(text)) out.notes.push('Maintenance, services or utilities are mentioned. These are non-lease components unless you elect to combine them (16.12-15).');
    if (/KIBOR|variable|turnover|sales|revenue share/i.test(text) && !kib) out.notes.push('Variable payments may be present. Only those depending on an index or rate are in the lease liability (16.27(b)); sales-based payments are expensed (16.38(b)).');
    return out;
}

export const Extractor = { run, toLease, parseDate };
