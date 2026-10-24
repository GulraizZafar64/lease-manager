/* ======================================================================
   Banking: statement import, reconciliation, payment batch files.
   Live bank APIs need a server-side integration with bank credentials;
   this module works with the statement and bulk-payment files banks issue.
   ====================================================================== */
import { SETTINGS } from './settings';
import { Store } from './store';
import { Ent, audit, lockGuard, logHistory } from './enterprise';
import { parseDate } from './extractor';
import { paymentRows, type PaymentRow } from './payments';
import { matchLines } from '../api/banking';
import { loadLib } from '../utils/files';
import { toast } from '../utils/uiStore';
import { deepClone, fmtNum, uid } from '../utils/format';
import { fmtDate } from '../utils/dates';
import type { BankLine, BankStatement, PaymentBatch } from '../types/enterprise';

export const hash = (s: string): string => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

export function ibanValid(iban: string | null | undefined): boolean {
    const s = String(iban || '').replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
    if (s.startsWith('PK') && s.length !== 24) return false;
    const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
    let m = 0; for (const d of r) m = (m * 10 + Number(d)) % 97;
    return m === 1;
}

/** A statement line as parsed, before it is stored. */
export interface ParsedLine { date: string; amount: number; ref: string; desc: string }

/* ---- Statement parsers ---- */
export function parseMT940(text: string): ParsedLine[] {
    const lines: ParsedLine[] = [], blocks = text.replace(/\r/g, '').split(/\n(?=:\d{2}[A-Z]?:)/);
    let cur: ParsedLine | null = null;
    for (const b of blocks) {
        const m = b.match(/^:61:(\d{6})(\d{4})?(R?[CD])([A-Z])?([\d,]+)(\w{4})?([^\n/]*)(?:\/\/([^\n]*))?/);
        if (m) {
            const y = 2000 + Number(m[1].slice(0, 2)), date = `${y}-${m[1].slice(2, 4)}-${m[1].slice(4, 6)}`;
            const amt = Number(m[5].replace(',', '.')) * (/D/.test(m[3]) ? -1 : 1);
            cur = { date, amount: amt, ref: (m[7] || '').trim(), desc: '' }; lines.push(cur);
        } else if (b.startsWith(':86:') && cur) cur.desc = b.slice(4).replace(/\n/g, ' ').trim();
    }
    return lines;
}
export function parseCAMT(text: string): ParsedLine[] {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const q = (el: Element, tag: string): Element | undefined => el.getElementsByTagNameNS('*', tag)[0];
    const txt = (el: Element | undefined) => (el && el.textContent) || '';
    return Array.from(doc.getElementsByTagNameNS('*', 'Ntry')).map(n => {
        const amt = Number(txt(q(n, 'Amt')) || 0), sign = txt(q(n, 'CdtDbtInd')) === 'DBIT' ? -1 : 1;
        const dt = q(n, 'BookgDt') || q(n, 'ValDt'), d = dt ? txt(q(dt, 'Dt') || q(dt, 'DtTm')).slice(0, 10) : '';
        const ustrd = Array.from(n.getElementsByTagNameNS('*', 'Ustrd')).map(x => x.textContent).join(' ');
        const nm = txt(q(n, 'Nm'));
        return { date: d, amount: amt * sign, ref: txt(q(n, 'AcctSvcrRef') || q(n, 'EndToEndId')).trim(), desc: [nm, ustrd, txt(q(n, 'AddtlNtryInf'))].filter(Boolean).join(' ').trim() };
    });
}
export function parseTable(rows: SheetCell[][]): ParsedLine[] {
    for (let h = 0; h < Math.min(15, rows.length); h++) {
        const head = rows[h].map(c => String(c || '').toLowerCase().trim());
        const f = (re: RegExp) => head.findIndex(c => re.test(c));
        const di = f(/^(transaction |value |posting |book(ing)? )?date|^dated?$/), de = f(/desc|narrat|particular|detail|remark/), rf = f(/ref|cheque|chq|instrument/);
        const dr = f(/debit|withdraw|paid out|dr\b/), cr = f(/credit|deposit|paid in|cr\b/), am = f(/^amount|^amt/);
        if (di >= 0 && (am >= 0 || dr >= 0 || cr >= 0)) {
            return rows.slice(h + 1).filter(r => r[di] !== '' && r[di] != null).map(r => {
                const num = (v: SheetCell) => typeof v === 'number' ? v : Number(String(v || '').replace(/[,\s]/g, '').replace(/^\((.*)\)$/, '-$1')) || 0;
                const amount = am >= 0 ? num(r[am]) : num(r[cr]) - num(r[dr]);
                const dv = r[di];
                const date = dv instanceof Date ? dv.toISOString().slice(0, 10) : typeof dv === 'number' ? new Date(Math.round((dv - 25569) * 864e5)).toISOString().slice(0, 10) : (parseDate(String(dv)) || '');
                return { date, amount, desc: de >= 0 ? String(r[de] || '') : '', ref: rf >= 0 ? String(r[rf] || '') : '' };
            }).filter(x => x.date && x.amount);
        }
    }
    return [];
}
export async function readStatementFile(f: File): Promise<{ format: string; lines: ParsedLine[] }> {
    const ext = (f.name.split('.').pop() || '').toLowerCase(), text = ['xlsx', 'xls'].includes(ext) ? '' : await f.text();
    if (/:61:/.test(text) && /:20:|:25:/.test(text)) return { format: 'MT940', lines: parseMT940(text) };
    if (/<Document|camt\.05[234]/i.test(text)) return { format: 'CAMT.05x', lines: parseCAMT(text) };
    await loadLib('xlsx');
    const XLSX = window.XLSX as XlsxStatic;
    const wb = XLSX.read(ext === 'csv' || !['xlsx', 'xls'].includes(ext) ? text : await f.arrayBuffer(), { type: ['xlsx', 'xls'].includes(ext) ? 'array' : 'string', cellDates: true });
    for (const n of wb.SheetNames) { const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }); const l = parseTable(rows); if (l.length) return { format: ext.toUpperCase(), lines: l }; }
    return { format: ext.toUpperCase(), lines: [] };
}

/* ---- Reconciliation ---- */
export interface ReconCandidate { row: PaymentRow; score: number; partial: boolean }
export function reconCandidates(line: BankLine): ReconCandidate[] {
    const out: ReconCandidate[] = [], txt = (line.desc + ' ' + line.ref).toLowerCase();
    for (const r of paymentRows()) {
        const l = Store.get(r.leaseId); if (!l) continue;
        const inflow = l.role === 'lessor';
        if ((line.amount > 0) !== inflow) continue;
        const amt = Math.abs(line.amount), target = r.outstanding > 0.5 ? r.outstanding : r.amount;
        const diffAmt = Math.abs(amt - target), tol = Math.max(1, target * 0.005);
        const days = Math.abs((new Date(line.date).getTime() - new Date(r.dueDate).getTime()) / 864e5);
        let score = 0;
        if (diffAmt <= tol) score += 50; else if (amt < target && amt > target * 0.2) score += 15; else continue;
        score += days <= 3 ? 25 : days <= 10 ? 15 : days <= 35 ? 5 : -20;
        const tokens = [l.id, l.contractNumber, ...(String(l.counterparty || '').toLowerCase().split(/\W+/).filter(w => w.length > 3 && !['private', 'limited', 'company', 'holdings', 'estates'].includes(w)))].filter(Boolean).map(x => String(x).toLowerCase());
        if (tokens.some(t => txt.includes(t))) score += 30;
        if (r.status === 'paid') { // recorded already: link the bank line unless every payment for it is already linked
            const recs = (l.payments || []).filter(p => p.dueDate === r.dueDate && p.kind !== 'variable');
            if (recs.length && recs.every(p => p.bankLineId && p.bankLineId !== line.id)) score -= 60;
        }
        out.push({ row: r, score, partial: diffAmt > tol });
    }
    return out.sort((a, b) => b.score - a.score);
}
/** Match a bank line to an instalment, recording the payment; false when it was not recorded. */
export async function recordMatch(_stmt: BankStatement, ln: BankLine, row: PaymentRow, auto: boolean): Promise<boolean> {
    if (Store.mode === 'api') return (await matchOnServer([{ ln, row }], auto)) === 1;
    const l = Store.get(row.leaseId); if (!l) return false;
    if (!lockGuard(ln.date, 'Bank match')) return false;
    const l2 = deepClone(l); l2.payments = l2.payments || [];
    const existing = l2.payments.find(p => p.bankLineId === ln.id);
    if (!existing) {
        if (row.status === 'paid') { const p = l2.payments.find(p => p.dueDate === row.dueDate && !p.bankLineId); if (p) p.bankLineId = ln.id; }
        else l2.payments.push({ id: uid('p'), kind: 'scheduled', dueDate: row.dueDate, forType: row.kind, amount: Math.round(Math.abs(ln.amount)), paidDate: ln.date, ref: `Bank: ${(ln.ref || ln.desc).slice(0, 60)}`, bankLineId: ln.id });
        logHistory(l2, `${auto ? 'Auto-reconciled' : 'Reconciled'} bank line ${fmtDate(ln.date)} ${fmtNum(Math.abs(ln.amount))} to instalment due ${fmtDate(row.dueDate)}`);
        if (!await Store.save(l2)) return false;
    }
    ln.status = 'matched'; ln.match = { leaseId: row.leaseId, dueDate: row.dueDate, key: row.key, by: Store.actorId(), auto: !!auto }; delete ln.suggest;
    return true;
}
/** Signed in through the API: the server records each payment (or refuses it with a reason); returns how many were matched. */
async function matchOnServer(picks: { ln: BankLine; row: PaymentRow }[], auto: boolean): Promise<number> {
    picks = picks.filter(p => lockGuard(p.ln.date, 'Bank match'));
    if (!picks.length) return 0;
    let results;
    try { results = await matchLines(picks.map(({ ln, row }) => ({ lineId: ln.id, leaseId: row.leaseId, dueDate: row.dueDate, forType: row.kind, auto }))); }
    catch (e) { toast('Not matched: ' + (e instanceof Error && e.message ? e.message : 'check your connection and try again.')); return 0; }
    for (const r of results) { const p = picks.find(x => x.ln.id === r.lineId); if (p && r.ok && r.match) { p.ln.status = 'matched'; p.ln.match = r.match; delete p.ln.suggest; } }
    const refused = results.filter(r => !r.ok);
    if (refused.length) toast(picks.length === 1 ? `Not matched: ${refused[0].message}` : `${refused.length} of ${picks.length} lines not matched: ${refused[0].message}`);
    const leases = [...new Set(picks.filter(p => results.some(r => r.ok && r.lineId === p.ln.id)).map(p => p.row.leaseId))];
    if (leases.length > 10) await Store.refresh(); else await Promise.all(leases.map(id => Store.refreshLease(id)));
    return results.length - refused.length;
}
export async function autoReconcile(stmt: BankStatement, apply = true): Promise<{ matched: number; suggested: number }> {
    let matched = 0, suggested = 0;
    const used = new Set<string>(), picks: { ln: BankLine; row: PaymentRow }[] = [];
    for (const ln of stmt.lines) {
        if (ln.status === 'matched' || ln.status === 'ignored' || ln.duplicate) continue;
        const c = reconCandidates(ln).filter(x => !used.has(x.row.key));
        if (c[0] && c[0].score >= 75 && !c[0].partial && (!c[1] || c[0].score - c[1].score >= 15)) {
            used.add(c[0].row.key);
            if (apply && Store.mode === 'api') picks.push({ ln, row: c[0].row }); // sent together below
            else if (apply && await recordMatch(stmt, ln, c[0].row, true)) matched++;
        } else if (c[0] && c[0].score >= 40) { ln.status = 'suggested'; ln.suggest = { key: c[0].row.key, score: c[0].score }; suggested++; }
        else ln.status = 'unmatched';
    }
    if (picks.length) matched = await matchOnServer(picks, true);
    await Ent.bank.save(stmt);
    audit('bank.reconcile', `Auto-reconciled ${stmt.name}: ${matched} matched, ${suggested} suggested`);
    return { matched, suggested };
}

/* ---- Payment batches (maker-checker) and bank payment files ---- */
export const BATCH_STATUS: Record<string, string> = { draft: 'Draft', pending: 'Awaiting approval', approved: 'Approved', released: 'Bank file released', rejected: 'Rejected' };

export function pain001(b: PaymentBatch): string {
    const x = (s: unknown) => String(s ?? '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string));
    const acct = (SETTINGS.bankAccounts || []).find(a => a.name === b.account) || { iban: '', account: '', swift: '' };
    const tx = b.lines.map(ln => { const l = Store.get(ln.leaseId), bk = (l && l.bank) || { iban: '', account: '', bankName: '', swift: '' }; return `<CdtTrfTxInf><PmtId><EndToEndId>${x((ln.leaseId + '-' + ln.dueDate).slice(0, 35))}</EndToEndId></PmtId><Amt><InstdAmt Ccy="${x(b.currency)}">${ln.amount.toFixed(2)}</InstdAmt></Amt>${bk.swift ? `<CdtrAgt><FinInstnId><BIC>${x(bk.swift)}</BIC></FinInstnId></CdtrAgt>` : ''}<Cdtr><Nm>${x(((l && l.counterparty) || '').slice(0, 70))}</Nm></Cdtr><CdtrAcct><Id>${bk.iban ? `<IBAN>${x(bk.iban)}</IBAN>` : `<Othr><Id>${x(bk.account)}</Id></Othr>`}</Id></CdtrAcct><RmtInf><Ustrd>${x(`${ln.leaseId} ${(l && l.contractNumber) || ''} rent due ${ln.dueDate}`.slice(0, 140))}</Ustrd></RmtInf></CdtTrfTxInf>`; }).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CstmrCdtTrfInitn><GrpHdr><MsgId>${x(b.id)}</MsgId><CreDtTm>${new Date().toISOString().slice(0, 19)}</CreDtTm><NbOfTxs>${b.lines.length}</NbOfTxs><CtrlSum>${b.total.toFixed(2)}</CtrlSum><InitgPty><Nm>${x(SETTINGS.entity)}</Nm></InitgPty></GrpHdr><PmtInf><PmtInfId>${x(b.id)}</PmtInfId><PmtMtd>TRF</PmtMtd><NbOfTxs>${b.lines.length}</NbOfTxs><CtrlSum>${b.total.toFixed(2)}</CtrlSum><ReqdExctnDt>${x(b.valueDate)}</ReqdExctnDt><Dbtr><Nm>${x(SETTINGS.entity)}</Nm></Dbtr><DbtrAcct><Id>${acct.iban ? `<IBAN>${x(acct.iban)}</IBAN>` : `<Othr><Id>${x(acct.account || 'SET-IN-ADMIN')}</Id></Othr>`}</Id></DbtrAcct><DbtrAgt><FinInstnId>${acct.swift ? `<BIC>${x(acct.swift)}</BIC>` : '<Othr><Id>NOTPROVIDED</Id></Othr>'}</FinInstnId></DbtrAgt>${tx}</PmtInf></CstmrCdtTrfInitn></Document>`;
}
