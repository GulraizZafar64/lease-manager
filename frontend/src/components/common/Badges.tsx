import type { ReactNode } from 'react';
import { STATUS_CLASS, STATUS_LABEL } from '../../domain/lease';
import { cap } from '../../utils/format';

export type BadgeTone = 'ok' | 'bad' | 'pending' | 'neutral' | 'info';

export function Badge({ tone, children }: { tone: BadgeTone | string; children: ReactNode }) {
    return <span className={`badge badge-${tone}`}>{children}</span>;
}

/** Lease or change status (Draft, Pending approval, Active, ...). */
export function StatusBadge({ status }: { status: string }) {
    return <Badge tone={STATUS_CLASS[status] || 'neutral'}>{STATUS_LABEL[status] || cap(status)}</Badge>;
}

/** An IFRS paragraph reference chip. */
export function Ref({ children }: { children: ReactNode }) {
    return <span className="ref">{children}</span>;
}

export function Spinner() {
    return <span className="spinner" />;
}
