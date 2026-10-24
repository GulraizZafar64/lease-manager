/* Lease model: the shape stored in the workspace and edited by the lease form. */

/** A numeric form value: a number, or '' while the field is blank. */
export type Num = number | '';

export type LeaseRole = 'lessee' | 'lessor';
export type Timing = 'advance' | 'arrears';
export type Exemption = 'none' | 'short-term' | 'low-value';
export type RateBasis = 'IBR' | 'implicit' | 'solve';
export type Classification = 'auto' | 'finance' | 'operating';
export type LateType = 'none' | 'interest' | 'fine' | 'both';
export type LeaseStatus = 'draft' | 'pending' | 'rejected' | 'active';
export type DisplayStatus = LeaseStatus | 'future' | 'expired' | 'terminated';

export interface Escalation {
    type: 'none' | 'fixed' | 'index';
    rate?: Num;
    everyM?: Num;
    indexBase?: Num;
}

export interface LeaseTerms {
    commencement: string;
    termMonths: Num;
    payment: Num;
    freqM: number;
    timing: Timing;
    rentFreeMonths: Num;
    escalation: Escalation;
    extension: { months: Num; payment: Num; certain: boolean };
    termination: { month: Num; penalty: Num; certain: boolean; notice?: Num };
    purchase: { price: Num; certain: boolean };
    rvg: Num;
    discountRate: Num;
    rateBasis: RateBasis;
    fairValue: Num;
    lessorIDC: Num;
    urv: Num;
    idc: Num;
    incentives: Num;
    prepaid: Num;
    restoration: Num;
    deposit: Num;
    usefulLifeM: Num;
    ownershipTransfer: boolean;
    exemption: Exemption;
    serviceComponent: Num;
    combine: boolean;
    variableNote: string;
    carryingAmount: Num;
    dealer: boolean;
    classification: Classification;
    marketRate: Num;
    specialised: boolean;
    underlyingRemainingLifeM: Num;
    gracePeriodDays: Num;
    lateType: LateType;
    lateRate: Num;
    fineRate: Num;
    partialRule: 'interest-first' | 'principal-first' | 'proportional';
    rouOverride?: Num;
}

export type EventType =
    | 'reassess-index' | 'reassess-floating' | 'reassess-rvg' | 'reassess-term' | 'reassess-purchase'
    | 'mod-change' | 'mod-decrease' | 'mod-separate' | 'terminate' | 'impair';

export type EventStatus = 'pending' | 'approved' | 'rejected';

export interface Approval {
    by: string;
    name: string;
    role: string;
    at: string;
}

export interface LeaseEvent {
    id: string;
    type: EventType;
    effective: string;
    status: EventStatus;
    reason?: string;
    newRate?: number;
    newPayment?: number;
    escPct?: number;
    escEveryM?: number;
    extPayment?: number | '';
    areaRetainedPct?: number;
    penalty?: number;
    assetValue?: number;
    amount?: number;
    purchasePrice?: number;
    purchaseCertain?: boolean;
    rvg?: number;
    urv?: number;
    newEndMonth?: number;
    submittedBy?: string;
    submittedByName?: string;
    submittedOn?: string;
    approvedBy?: string;
    approvedByName?: string;
    approvedOn?: string;
    rejectedBy?: string;
    rejectedByName?: string;
    approvals?: Approval[];
}

export interface LeasePayment {
    id: string;
    kind: 'scheduled' | 'variable';
    dueDate: string;
    amount: number;
    paidDate?: string;
    forType?: string;
    ref?: string;
    bankLineId?: string;
}

export interface HistoryEntry {
    at: string;
    actor: string;
    actorName: string;
    text: string;
}

export interface DocumentHit {
    field: string;
    start: number;
    end: number;
}

export interface LeaseDocument {
    name: string;
    addedAt: string;
    text: string;
    hits: DocumentHit[];
    fields: Record<string, unknown>;
}

export interface BankDetails {
    iban: string;
    account: string;
    bankName: string;
    swift: string;
}

export interface Lease {
    id: string;
    contractNumber: string;
    name: string;
    role: LeaseRole;
    counterparty: string;
    assetClass: string;
    location: string;
    area: Num;
    areaUnit: string;
    currency: string;
    entity: string;
    costCentre: string;
    status: LeaseStatus;
    notes: string;
    terms: LeaseTerms;
    events: LeaseEvent[];
    payments: LeasePayment[];
    history: HistoryEntry[];
    documents: LeaseDocument[];
    createdAt: string;
    updatedAt?: string;
    approvals?: Approval[];
    bank?: BankDetails;
    parentId?: string;
    /** Signed in through the API: the server's entity id and record version (for edit conflicts). */
    entityId?: string;
    version?: number;
    /** Where a prefilled lease came from (import, AI); removed on save. */
    _source?: string;
}
