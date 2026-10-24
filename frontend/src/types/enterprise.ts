import type { Approval } from './lease';

export type BuiltinRole = 'superadmin' | 'admin' | 'controller' | 'preparer' | 'treasury' | 'auditor' | 'viewer';
/** A built-in role, or the id of a custom role created in Roles and permissions. */
export type RoleKey = BuiltinRole | (string & Record<never, never>);
export type Permission =
    | 'lease.view' | 'lease.edit' | 'lease.change' | 'lease.delete' | 'lease.import' | 'approve' | 'payment.record'
    | 'bank.reconcile' | 'payment.batch' | 'gl.export' | 'report.export' | 'audit.view' | 'admin.users' | 'admin.settings'
    | 'admin.data' | 'period.override' | 'ai.use' | 'ai.approve';

export interface UserRecord {
    id: string;
    role: RoleKey;
    status: 'active' | 'disabled';
    entities?: string[];
    limit?: number | '';
    extraPerms?: Permission[];
    addedBy?: string;
    addedAt?: string;
    label?: string;
    /** Profile fields for users managed in this app (Users screen). */
    name?: string;
    email?: string;
    title?: string;
    lastLoginAt?: string;
    updatedAt?: string;
    /** Sign-in state reported by the server (users managed through the API). */
    mfaEnabled?: boolean;
    mustChangePassword?: boolean;
    lockedUntil?: string | null;
}

/** A role's settings: built-in roles can have their permissions changed; custom roles are fully editable. */
export interface RoleDef {
    id: RoleKey;
    label: string;
    desc: string;
    perms: Permission[];
    custom?: boolean;
    updatedAt?: string;
    updatedBy?: string;
}

export interface AccessRequest { id: string; at: string; note: string }

export interface BatchLine { key: string; leaseId: string; dueDate: string; forType: string; amount: number }
export type BatchStatus = 'draft' | 'pending' | 'approved' | 'released' | 'rejected';
export interface PaymentBatch {
    id: string;
    name: string;
    currency: string;
    valueDate: string;
    account: string;
    createdAt: string;
    createdBy: string;
    status: BatchStatus;
    approvals: Approval[];
    lines: BatchLine[];
    total: number;
    submittedAt?: string;
    releasedAt?: string;
}

export interface ExportRecord {
    id: string;
    target: string;
    from: string;
    to: string;
    createdAt: string;
    createdBy: string;
    count: number;
    debits: number;
    keys: string[];
    status: 'generated' | 'posted' | 'failed';
    notes?: string;
    markedBy?: string;
}

export interface DraftRecord {
    id: string;
    title: string;
    from: string;
    to: string;
    text: string;
    createdAt: string;
    createdBy: string;
    status: 'draft' | 'final';
    approvals: Approval[];
    source: string;
    editedBy?: string;
}

export type BankLineStatus = 'unmatched' | 'suggested' | 'matched' | 'ignored';
export interface BankLine {
    id: string;
    h: string;
    date: string;
    amount: number;
    ref: string;
    desc: string;
    status: BankLineStatus;
    duplicate: boolean;
    suggest?: { key: string; score: number };
    match?: { leaseId: string; dueDate: string; key: string; by: string; auto: boolean };
}
export interface BankStatement {
    id: string;
    name: string;
    format: string;
    account: string;
    importedAt: string;
    importedBy: string;
    lines: BankLine[];
}

export interface AuditEntry {
    id: string;
    at: string;
    actor: string;
    actorName: string;
    role: string;
    action: string;
    detail: string;
    leaseId?: string;
    entity?: string;
}
