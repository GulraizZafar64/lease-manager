export const todayISO = (): string => {
    const d = new Date();
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10);
};

export const fmtDate = (s: string | null | undefined): string => {
    if (!s) return '—';
    const d = new Date(s + 'T00:00:00Z');
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

export const monthLabel = (s: string): string => new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Date and time as the original page shows it (en-GB locale string). */
export const fmtDateTime = (s: string | number | Date): string => new Date(s).toLocaleString('en-GB');
