/* Workspace settings. SETTINGS is a single mutable object, as in the original page:
   screens assign into it and then save it through Store.saveSettings(). */
import { num } from './engine';
import type { EngineSettings, RateConvention } from '../types/engine';

export interface EntityRecord { name: string; code: string; functionalCurrency: string; parent: string; country: string; /** Server id (signed in through the API). */ id?: string }
export interface PolicyTier { upTo: number | null | ''; approvals: number; roles: string[] }
export type ApprovalPolicy = Record<'lease' | 'change' | 'batch' | 'export' | 'draft', PolicyTier[]>;
export interface FxHistoryEntry { date: string; rates: Record<string, number> }
export interface BankAccount { name: string; bank: string; iban: string; swift: string; currency: string; gl: string; account?: string }
export interface ErpConfig { target: string; company: string; docType: string; journal: string; batch: string; ledger: string; group: string }
export interface Retention { auditYears: number; idleMinutes: number }

export type AccountKey =
    | 'rou' | 'rouAccDep' | 'liability' | 'cash' | 'interest' | 'depreciation' | 'gain' | 'impairment' | 'provision' | 'provInterest'
    | 'deposit' | 'depositIncome' | 'incentive' | 'stExpense' | 'lvExpense' | 'varExpense' | 'prepaid' | 'netInvestment' | 'financeIncome'
    | 'leaseIncome' | 'accruedIncome' | 'ppe' | 'ppeAccDep' | 'ppeDep' | 'revenue' | 'cogs' | 'inventory' | 'sellingExp' | 'idcDeferred'
    | 'idcAmort' | 'fxLoss';

export interface AppSettings {
    entity: string;
    functionalCurrency: string;
    fyEndMonth: number;
    rateConvention: RateConvention;
    majorPartPct: number;
    substantiallyAllPct: number;
    lowValueThreshold: number;
    lowValueCurrency: string;
    requireApproval: boolean;
    segregateApproval: boolean;
    interestCashFlow: 'financing' | 'operating';
    numberGrouping: 'international' | 'south-asian';
    displayUnit: number;
    fx: Record<string, number>;
    accounts: Record<AccountKey, string>;
    theme: 'light' | 'dark' | 'system';
    userName: string;
    presentationCurrency: string;
    lockedThrough: string;
    defaultRate?: number | '';
    entities?: EntityRecord[];
    approvalPolicy?: ApprovalPolicy;
    fxHistory?: FxHistoryEntry[];
    bankAccounts?: BankAccount[];
    erp?: ErpConfig;
    retention?: Retention;
    exitPenaltyMonths?: number;
    localRole?: string;
    lastBackup?: string;
    lastBackupBy?: string;
}

export const CURRENCY_NAMES: Record<string, string> = {
    PKR: 'Pakistani rupee', USD: 'US dollar', EUR: 'Euro', GBP: 'Pound sterling', CNY: 'Chinese yuan', AED: 'UAE dirham', SAR: 'Saudi riyal', QAR: 'Qatari riyal', KWD: 'Kuwaiti dinar', BHD: 'Bahraini dinar', OMR: 'Omani rial', JOD: 'Jordanian dinar', EGP: 'Egyptian pound', TRY: 'Turkish lira', ILS: 'Israeli shekel',
    INR: 'Indian rupee', BDT: 'Bangladeshi taka', LKR: 'Sri Lankan rupee', NPR: 'Nepalese rupee', AFN: 'Afghan afghani', JPY: 'Japanese yen', KRW: 'South Korean won', HKD: 'Hong Kong dollar', SGD: 'Singapore dollar', MYR: 'Malaysian ringgit', IDR: 'Indonesian rupiah', THB: 'Thai baht', VND: 'Vietnamese dong', PHP: 'Philippine peso', TWD: 'New Taiwan dollar',
    CHF: 'Swiss franc', SEK: 'Swedish krona', NOK: 'Norwegian krone', DKK: 'Danish krone', PLN: 'Polish zloty', CZK: 'Czech koruna', HUF: 'Hungarian forint', RON: 'Romanian leu', RUB: 'Russian rouble',
    CAD: 'Canadian dollar', MXN: 'Mexican peso', BRL: 'Brazilian real', ARS: 'Argentine peso', CLP: 'Chilean peso', COP: 'Colombian peso', AUD: 'Australian dollar', NZD: 'New Zealand dollar', ZAR: 'South African rand', NGN: 'Nigerian naira', KES: 'Kenyan shilling', MAD: 'Moroccan dirham',
};
/** Currencies (ISO 4217). Rates are entered by the user; none are assumed. */
export const CURRENCIES = Object.keys(CURRENCY_NAMES);

export const ASSET_CLASSES: Record<string, string> = { building: 'Buildings and offices', warehouse: 'Warehouses and depots', retail: 'Retail space', land: 'Land', vehicle: 'Vehicles', equipment: 'Plant and equipment', it: 'IT equipment', other: 'Other' };
export const FREQ: Record<number, string> = { 1: 'Monthly', 3: 'Quarterly', 6: 'Half-yearly', 12: 'Annually' };

export const DEFAULT_SETTINGS: AppSettings = {
    entity: 'My company', functionalCurrency: 'PKR', fyEndMonth: 6,
    rateConvention: 'effective', majorPartPct: 75, substantiallyAllPct: 90, lowValueThreshold: 5000, lowValueCurrency: 'USD',
    requireApproval: true, segregateApproval: true, interestCashFlow: 'financing', numberGrouping: 'international', displayUnit: 1,
    fx: { PKR: 1, USD: 280, EUR: 305, GBP: 355, AED: 76.2, SAR: 74.6, CNY: 39 },
    accounts: {
        rou: '1610 Right-of-use assets', rouAccDep: '1615 Accumulated depreciation - ROU', liability: '2410 Lease liabilities', cash: '1010 Bank',
        interest: '7110 Interest on lease liabilities', depreciation: '6410 Depreciation - ROU assets', gain: '7910 Gain / (loss) on lease modification',
        impairment: '6490 Impairment - ROU assets', provision: '2450 Provision for restoration', provInterest: '7120 Unwinding of restoration provision',
        deposit: '1520 Security deposits', depositIncome: '7210 Finance income - deposits', incentive: '1010 Bank',
        stExpense: '6420 Short-term lease expense', lvExpense: '6425 Low-value lease expense', varExpense: '6430 Variable lease payments', prepaid: '1450 Prepaid lease rentals',
        netInvestment: '1630 Net investment in leases', financeIncome: '4210 Finance income on leases', leaseIncome: '4220 Operating lease income',
        accruedIncome: '1460 Accrued operating lease income', ppe: '1210 Property, plant and equipment', ppeAccDep: '1215 Accumulated depreciation - PPE', ppeDep: '6110 Depreciation - PPE',
        revenue: '4010 Revenue', cogs: '5010 Cost of sales', inventory: '1310 Inventory', sellingExp: '6510 Selling expenses', idcDeferred: '1470 Deferred initial direct costs', idcAmort: '6520 Amortisation of lease costs', fxLoss: '7310 Exchange (gain) / loss on lease balances',
    },
    theme: 'light', userName: '', presentationCurrency: '', lockedThrough: '',
};

export const SETTINGS: AppSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

export const engineSettings = (): EngineSettings => ({ rateConvention: SETTINGS.rateConvention, majorPartPct: num(SETTINGS.majorPartPct) || 75, substantiallyAllPct: num(SETTINGS.substantiallyAllPct) || 90 });
