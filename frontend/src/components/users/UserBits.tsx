import { roleLabel } from '../../domain/enterprise';
import type { RoleKey } from '../../types/enterprise';

export const initials = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';

export function UserAvatar({ name, size = 32, muted }: { name: string; size?: number; muted?: boolean }) {
    return <span className={`who-avatar${muted ? ' muted' : ''}`} aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * .37) }}>{initials(name)}</span>;
}

const ROLE_TONE: Record<string, string> = { superadmin: 'bad', admin: 'pending', controller: 'info', preparer: 'ok', treasury: 'info', auditor: 'neutral', viewer: 'neutral' };
export function RoleBadge({ role }: { role: RoleKey }) {
    return <span className={`badge badge-${ROLE_TONE[role] || 'neutral'} role-badge`}>{roleLabel(role)}</span>;
}

export function StatusPill({ status }: { status: 'active' | 'disabled' }) {
    return <span className={`status-pill ${status}`}>{status === 'active' ? 'Active' : 'Disabled'}</span>;
}
