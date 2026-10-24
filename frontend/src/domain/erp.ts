/* ======================================================================
   ERP / general ledger integration
   Generates journal files in each system's import layout. Direct API
   posting needs credentials and a server-side connector (see Admin).
   ====================================================================== */
import { SETTINGS, type ErpConfig } from './settings';
import { Store } from './store';
import { entityOf } from './enterprise';
import { hash } from './banking';
import type { Journal } from './journals';
import { fmtNum, sum } from '../utils/format';
import { todayISO } from '../utils/dates';
import type { Sheet, SheetValue } from '../utils/files';

export const acctCode = (name: string): string => (String(name).match(/^\s*([A-Za-z0-9.-]+)\s/) || [])[1] || '';
export const acctName = (name: string): string => String(name).replace(/^\s*[A-Za-z0-9.-]+\s+/, '');
const r2 = (v: number): number => Math.round(v * 100) / 100;
export const xmlEsc = (s: unknown): string => String(s ?? '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string));
const leaseOf = (id: string) => Store.get(id);

export interface ErpProfile {
    label: string;
    note: string;
    ext: string;
    multi?: boolean;
    rows?: (js: Journal[], o: ErpConfig) => SheetValue[][];
    sheets?: (js: Journal[], o: ErpConfig) => Sheet[];
    text?: (js: Journal[]) => string;
}

export const ERP: Record<string, ErpProfile> = {
    sap: { label: 'SAP S/4HANA / ECC', note: 'Flat file in BKPF/BSEG terms (header and line). Map to your LSMW, Migration Cockpit or “Upload General Journal Entries” template.', ext: 'csv',
        rows: (js, o) => ([['DocKey', 'CompanyCode', 'DocumentDate', 'PostingDate', 'DocumentType', 'Currency', 'Reference', 'HeaderText', 'LineItem', 'GLAccount', 'DebitCreditInd', 'Amount', 'ItemText', 'CostCenter']] as SheetValue[][]).concat(js.flatMap((j, n) => j.lines.map((x, i) => [n + 1, o.company || '1000', j.date, j.date, o.docType || 'SA', j.currency, j.leaseId, j.memo.slice(0, 25), i + 1, acctCode(x.account), x.dr ? 'S' : 'H', r2(x.dr || x.cr), j.memo.slice(0, 50), (leaseOf(j.leaseId) || { costCentre: '' }).costCentre || '']))) },
    b1: { label: 'SAP Business One (DTW)', note: 'Two sheets for Data Transfer Workbench: JournalEntries (header) and JournalEntries_Lines.', ext: 'xlsx', multi: true,
        sheets: (js) => [{ name: 'JournalEntries', rows: ([['RecordKey', 'ReferenceDate', 'TaxDate', 'DueDate', 'Memo', 'Reference']] as SheetValue[][]).concat(js.map((j, n) => [n + 1, j.date.replace(/-/g, ''), j.date.replace(/-/g, ''), j.date.replace(/-/g, ''), j.memo.slice(0, 50), j.leaseId])) },
            { name: 'JournalEntries_Lines', rows: ([['ParentKey', 'LineNum', 'AccountCode', 'Debit', 'Credit', 'FCCurrency', 'LineMemo']] as SheetValue[][]).concat(js.flatMap((j, n) => j.lines.map((x, i) => [n + 1, i, acctCode(x.account), r2(x.dr), r2(x.cr), j.currency === SETTINGS.functionalCurrency ? '' : j.currency, j.memo.slice(0, 50)]))) }] },
    odoo: { label: 'Odoo', note: 'account.move import: one row per line; repeat header fields only on the first line.', ext: 'csv',
        rows: (js, o) => ([['ref', 'date', 'journal_id', 'line_ids/account_id', 'line_ids/name', 'line_ids/debit', 'line_ids/credit', 'line_ids/currency_id']] as SheetValue[][]).concat(js.flatMap(j => j.lines.map((x, i) => [i ? '' : j.leaseId + ' ' + j.kind, i ? '' : j.date, i ? '' : (o.journal || 'MISC'), acctCode(x.account) + ' ' + acctName(x.account), j.memo, r2(x.dr), r2(x.cr), j.currency]))) },
    dynamics: { label: 'Microsoft Dynamics 365 Business Central', note: 'General journal lines (signed amounts). Import through a configuration package or Edit in Excel.', ext: 'csv',
        rows: (js, o) => ([['Journal Template Name', 'Journal Batch Name', 'Posting Date', 'Document No.', 'Account Type', 'Account No.', 'Description', 'Currency Code', 'Amount']] as SheetValue[][]).concat(js.flatMap((j, n) => j.lines.map(x => ['GENERAL', o.batch || 'LEASES', j.date, `LS${String(n + 1).padStart(5, '0')}`, 'G/L Account', acctCode(x.account), j.memo.slice(0, 100), j.currency === SETTINGS.functionalCurrency ? '' : j.currency, r2((x.dr || 0) - (x.cr || 0))]))) },
    oracle: { label: 'Oracle E-Business Suite / Fusion (GL interface)', note: 'GL_INTERFACE columns. Put your chart-of-accounts segments in Segment1-3 (entity, account, cost centre).', ext: 'csv',
        rows: (js, o) => ([['STATUS', 'LEDGER_ID', 'ACCOUNTING_DATE', 'CURRENCY_CODE', 'DATE_CREATED', 'ACTUAL_FLAG', 'USER_JE_CATEGORY_NAME', 'USER_JE_SOURCE_NAME', 'SEGMENT1', 'SEGMENT2', 'SEGMENT3', 'ENTERED_DR', 'ENTERED_CR', 'REFERENCE1', 'REFERENCE10', 'GROUP_ID']] as SheetValue[][]).concat(js.flatMap(j => j.lines.map(x => ['NEW', o.ledger || '', j.date, j.currency, todayISO(), 'A', 'Lease Accounting', 'IFRS16', entityOf((leaseOf(j.leaseId) || { entity: '' }).entity).code || '', acctCode(x.account), (leaseOf(j.leaseId) || { costCentre: '' }).costCentre || '', x.dr ? r2(x.dr) : '', x.cr ? r2(x.cr) : '', j.leaseId, j.memo.slice(0, 240), o.group || '']))) },
    quickbooks: { label: 'QuickBooks Online', note: 'Journal entry import (Settings › Import data › Journal entries). Account names must match QuickBooks exactly.', ext: 'csv',
        rows: (js) => ([['Journal No', 'Journal Date', 'Currency', 'Account', 'Debits', 'Credits', 'Description', 'Name']] as SheetValue[][]).concat(js.flatMap((j, n) => j.lines.map(x => [`LS-${n + 1}`, j.date.split('-').reverse().join('/'), j.currency, acctName(x.account), x.dr ? r2(x.dr) : '', x.cr ? r2(x.cr) : '', j.memo.slice(0, 200), (leaseOf(j.leaseId) || { counterparty: '' }).counterparty || '']))) },
    xero: { label: 'Xero', note: 'Manual journal import template. Debits positive, credits negative.', ext: 'csv',
        rows: (js) => ([['*Narration', '*Date', 'Description', '*AccountCode', '*TaxRate', '*Amount', 'TrackingName1', 'TrackingOption1']] as SheetValue[][]).concat(js.flatMap(j => j.lines.map(x => [`${j.leaseId}: ${j.memo}`.slice(0, 200), j.date.split('-').reverse().join('/'), j.memo.slice(0, 100), acctCode(x.account), 'Tax Exempt', r2((x.dr || 0) - (x.cr || 0)), 'Lease', j.leaseId]))) },
    json: { label: 'JSON (any system / middleware)', note: 'Balanced entries with lines, for an integration platform or custom API.', ext: 'json',
        text: js => JSON.stringify({ source: 'IFRS16 Lease Manager', entity: SETTINGS.entity, generated: new Date().toISOString(), entries: js.map(j => ({ key: j.key, date: j.date, leaseId: j.leaseId, type: j.kind, memo: j.memo, currency: j.currency, lines: j.lines.map(x => ({ account: acctCode(x.account), accountName: acctName(x.account), debit: r2(x.dr), credit: r2(x.cr) })) })) }, null, 1) },
    xml: { label: 'XML (any system / middleware)', note: 'Same content as JSON, in XML.', ext: 'xml',
        text: js => `<?xml version="1.0" encoding="UTF-8"?>\n<Journals source="IFRS16 Lease Manager" entity="${xmlEsc(SETTINGS.entity)}" generated="${new Date().toISOString()}">\n` + js.map(j => `<Entry key="${j.key}" date="${j.date}" lease="${xmlEsc(j.leaseId)}" type="${xmlEsc(j.kind)}" currency="${j.currency}"><Memo>${xmlEsc(j.memo)}</Memo>${j.lines.map(x => `<Line account="${xmlEsc(acctCode(x.account))}" debit="${r2(x.dr)}" credit="${r2(x.cr)}">${xmlEsc(acctName(x.account))}</Line>`).join('')}</Entry>`).join('\n') + '\n</Journals>' },
};

export const entryKey = (j: Journal): string => hash(`${j.leaseId}|${j.date}|${j.kind}|${j.memo}|${j.lines.map(x => x.account + r2(x.dr) + '/' + r2(x.cr)).join(',')}`);
export function validateEntries(js: Journal[]): string[] {
    const errs: string[] = [];
    js.forEach(j => {
        const d = sum(j.lines, x => x.dr), c = sum(j.lines, x => x.cr);
        if (Math.abs(d - c) > 0.05) errs.push(`${j.leaseId} ${j.date}: entry does not balance (${fmtNum(d, 2)} / ${fmtNum(c, 2)})`);
        j.lines.forEach(x => { if (!acctCode(x.account)) errs.push(`${j.leaseId} ${j.date}: account “${x.account}” has no code. Add codes in Settings › Chart of accounts.`); });
    });
    return [...new Set(errs)];
}

export const INTEGRATION_STATUS: [integration: string, now: string, needs: string][] = [
    ['Bank statements', 'CSV, Excel, SWIFT MT940 and ISO 20022 CAMT.053 import with automatic matching and duplicate detection.', 'Direct feeds: a bank API agreement (for example host-to-host or the bank’s corporate API) and a server-side connector holding the credentials.'],
    ['Bulk payments', 'ISO 20022 pain.001 and CSV payment files from approved batches, for upload to your bank portal.', 'Straight-through submission: bank API credentials, signing certificates, and the bank’s own approval workflow.'],
    ['Payment gateways (cards, wallets, 1LINK / Raast)', 'Not applicable to outgoing rent; receipts can be imported from gateway settlement reports as statements.', 'A merchant account with the gateway and a server endpoint to receive its notifications.'],
    ['SAP, SAP Business One, Odoo, Dynamics 365, Oracle, QuickBooks, Xero', 'Journal files in each system’s import layout, validation, duplicate detection and a posting monitor.', 'API posting: an integration user and OAuth or API credentials for each system, held by a server or integration platform; never inside this page.'],
    ['Single sign-on and MFA', 'Sign-in through Claude accounts with verified user IDs; roles and entity access in the app.', 'Your organisation’s identity provider configured for Claude (SSO with MFA policies) by your Claude administrator.'],
    ['Exchange rates', 'Manual and pasted dated rates.', 'An automatic feed needs a rates API key (for example from your bank or a market data provider) and a server-side scheduler.'],
];
