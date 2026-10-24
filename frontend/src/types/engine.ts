/* Calculation engine inputs and outputs. */

export type NumLike = number | string | null | undefined;

export type RateConvention = 'effective' | 'nominal';

export interface EngineSettings {
    rateConvention: RateConvention;
    majorPartPct: number;
    substantiallyAllPct: number;
}

/** Terms as the engine reads them. Calculators pass partial terms, so everything is optional. */
export interface TermsInput {
    commencement?: string;
    termMonths?: NumLike;
    payment?: NumLike;
    freqM?: NumLike;
    timing?: string;
    rentFreeMonths?: NumLike;
    escalation?: { type?: string; rate?: NumLike; everyM?: NumLike } | null;
    extension?: { months?: NumLike; payment?: NumLike; certain?: boolean } | null;
    termination?: { month?: NumLike; penalty?: NumLike; certain?: boolean } | null;
    purchase?: { price?: NumLike; certain?: boolean } | null;
    rvg?: NumLike;
    discountRate?: NumLike;
    rateBasis?: string;
    fairValue?: NumLike;
    lessorIDC?: NumLike;
    urv?: NumLike;
    idc?: NumLike;
    incentives?: NumLike;
    prepaid?: NumLike;
    restoration?: NumLike;
    deposit?: NumLike;
    usefulLifeM?: NumLike;
    ownershipTransfer?: boolean;
    exemption?: string;
    serviceComponent?: NumLike;
    combine?: boolean;
    carryingAmount?: NumLike;
    dealer?: boolean;
    classification?: string;
    marketRate?: NumLike;
    specialised?: boolean;
    underlyingRemainingLifeM?: NumLike;
    rouOverride?: NumLike;
}

export interface EventInput {
    id: string;
    type: string;
    status: string;
    effective: string;
    newRate?: NumLike;
    newPayment?: NumLike;
    escPct?: NumLike;
    escEveryM?: NumLike;
    extPayment?: NumLike;
    areaRetainedPct?: NumLike;
    penalty?: NumLike;
    assetValue?: NumLike;
    amount?: NumLike;
    purchasePrice?: NumLike;
    purchaseCertain?: boolean;
    rvg?: NumLike;
    urv?: NumLike;
    newEndMonth?: NumLike;
}

export interface LeaseInput {
    role: string;
    terms: TermsInput;
    events?: EventInput[];
}

export interface Flow {
    t: number;
    amount: number;
    kind?: 'adv' | 'arr';
    type?: string;
}

export interface CashFlow extends Flow {
    date: string;
}

export interface EventTypeInfo {
    label: string;
    rate: 'unchanged' | 'revised' | 'n/a';
    ref: string;
    modification: boolean;
}

export interface Indicator {
    key: string;
    label: string;
    met: boolean;
    ref: string;
}

export interface LessorClassification {
    indicators: Indicator[];
    auto: 'finance' | 'operating';
    classification: string;
    pvRatio: number | null;
}

/* ---- Lessee ---- */
export interface LesseeEventResult {
    id: string;
    type: string;
    t: number;
    date: string;
    label: string;
    before: { L: number; A: number };
    after: { L: number; A: number };
    penalty?: number;
    partial?: { fraction: number; dL: number; dA: number; gain: number };
    newRate?: number | null;
    remeasured?: number;
    adjustment?: number;
}

export interface LesseeRow {
    t: number;
    start: string;
    end: string;
    openL: number;
    openA: number;
    addL: number;
    addA: number;
    remL: number;
    remA: number;
    derL: number;
    derA: number;
    imp: number;
    gain: number;
    payAdv: number;
    payArr: number;
    int: number;
    dep: number;
    provInt: number;
    depInt: number;
    cash: number;
    events: LesseeEventResult[];
    closeL?: number;
    closeA?: number;
    provClose?: number;
    depositClose?: number;
}

export interface LesseeInitial {
    liability: number;
    rou: number;
    paidAtCommencement: number;
    idc: number;
    incentives: number;
    restoration: number;
    depositFV: number;
    depositAdj: number;
    deposit: number;
    depMonths: number;
    monthlyRate: number;
    annualRate: number;
    implicitSolved: boolean;
    termMonths: number;
}

export interface LesseeResult {
    mode: 'lessee';
    rows: LesseeRow[];
    events: LesseeEventResult[];
    initial: LesseeInitial;
    cashflows: CashFlow[];
    termMonths: number;
    depEnd: number;
    endReason: string | null;
    owns: boolean;
}

/* ---- Exempt (short-term / low-value) ---- */
export interface ExemptRow {
    t: number;
    start: string;
    end: string;
    expense: number;
    cash: number;
    prepaid: number;
    events: never[];
}

export interface ExemptResult {
    mode: 'exempt';
    exemption: string;
    rows: ExemptRow[];
    events: never[];
    initial: { monthlyExpense: number; total: number; termMonths: number };
    cashflows: CashFlow[];
    termMonths: number;
}

/* ---- Lessor: finance lease ---- */
export interface FinanceEventResult {
    id: string;
    type: string;
    t: number;
    date: string;
    before: { L: number };
    after: { L: number };
    assetValue?: number;
    adjustment?: number;
}

export interface FinanceRow {
    t: number;
    start: string;
    end: string;
    openL: number;
    addL: number;
    remL: number;
    derL: number;
    gain: number;
    int: number;
    rcpAdv: number;
    rcpArr: number;
    cash: number;
    events: FinanceEventResult[];
    closeL?: number;
    assetReturned?: number;
}

export interface FinanceInitial {
    netInvestment: number;
    receivedAtCommencement: number;
    monthlyRate: number;
    annualRate: number;
    implicitSolved: boolean;
    revenue: number;
    cogs: number;
    sellingProfit: number;
    dealerIDC: number;
    gainOnDerecognition: number;
    urv: number;
    pvURV: number;
    termMonths: number;
}

export interface LessorFinanceResult {
    mode: 'lessor-finance';
    rows: FinanceRow[];
    events: FinanceEventResult[];
    classification: LessorClassification;
    cashflows: CashFlow[];
    initial: FinanceInitial;
    termMonths: number;
}

/* ---- Lessor: operating lease ---- */
export interface OperatingEventResult {
    id: string;
    type: string;
    t: number;
    date: string;
    before: { accrued: number };
    after: { accrued: number };
    newMonthlyIncome?: number;
}

export interface OperatingRow {
    t: number;
    start: string;
    end: string;
    income: number;
    cash: number;
    assetDep: number;
    idcAmort: number;
    events: OperatingEventResult[];
    gain?: number;
    accrued?: number;
}

export interface LessorOperatingResult {
    mode: 'lessor-operating';
    rows: OperatingRow[];
    events: OperatingEventResult[];
    classification: LessorClassification;
    cashflows: CashFlow[];
    initial: { monthlyIncome: number; total: number; assetDepMonthly: number; idc: number; termMonths: number };
    termMonths: number;
}

export type EngineResult = LesseeResult | ExemptResult | LessorFinanceResult | LessorOperatingResult;
export type EngineRow = LesseeRow | ExemptRow | FinanceRow | OperatingRow;
export type EngineEventResult = LesseeEventResult | FinanceEventResult | OperatingEventResult;

export const SUM_KEYS = ['addL', 'addA', 'remL', 'remA', 'derL', 'derA', 'imp', 'gain', 'payAdv', 'payArr', 'int', 'dep', 'provInt', 'depInt', 'cash', 'rcpAdv', 'rcpArr', 'income', 'expense', 'assetDep', 'idcAmort'] as const;
export type SumKey = typeof SUM_KEYS[number];
export type Totals = Record<SumKey, number>;

export interface AggregateRow extends Totals {
    key: string | number;
    start: string;
    end: string;
    openL: number;
    openA: number;
    closeL?: number;
    closeA?: number;
    accrued?: number;
    prepaid?: number;
    events: EngineEventResult[];
}

export interface Balance {
    L: number;
    A: number;
    accrued: number;
    prepaid: number;
}

export interface Band {
    label: string;
    maxDays: number;
}
