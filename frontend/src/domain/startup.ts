/* Start-up: theme, workspace load and the enterprise layer. */
import { SETTINGS } from './settings';
import { applyColors, loadColors } from './colors';
import { Store } from './store';
import { notify } from './state';
import { Ent, audit, entities, myRole, policy, resolveNames, roleLabel } from './enterprise';

const sysDark: MediaQueryList | { matches: boolean } = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : { matches: false };

export function applyTheme(): void {
    const t = SETTINGS.theme === 'system' ? (sysDark.matches ? 'dark' : 'light') : SETTINGS.theme;
    document.documentElement.dataset.theme = t;
    applyColors();
}

/** Theme and colours from this browser, then follow the system theme when "Match system" is chosen. */
export function initTheme(): void {
    try { const t = localStorage.getItem('ifrs16.theme'); if (t) SETTINGS.theme = t as typeof SETTINGS.theme; } catch { /* storage unavailable */ }
    loadColors();
    applyTheme();
    if ('addEventListener' in sysDark) sysDark.addEventListener('change', () => { if (SETTINGS.theme === 'system') { applyTheme(); notify(); } });
}

/** Called after leases load: users, collections, policy defaults and the session audit entry. */
async function enterpriseStart(): Promise<void> {
    try { Ent.isOwner = Store.user ? await Store.user.isOwner() : false; } catch { /* not owner */ }
    await Promise.all([Ent.users, Ent.roles, Ent.requests, Ent.batches, Ent.exports, Ent.drafts, Ent.bank].map(c => c.init()));
    entities(); policy();
    SETTINGS.accounts.fxLoss = SETTINGS.accounts.fxLoss || '7310 Exchange (gain) / loss on lease balances';
    if (Store.mode === 'db' && Store.me && Store.me.id && Ent.isOwner && !Ent.users.items.some(u => u.role === 'superadmin' && u.status !== 'disabled')) {
        try { await Ent.users.save({ id: Store.actorId(), role: 'superadmin', status: 'active', addedBy: 'system', addedAt: new Date().toISOString() }); } catch { /* view-only */ }
    }
    await resolveNames(Ent.users.items.filter(u => !u.email).map(u => u.id));
    audit('session.start', `Signed in as ${roleLabel(myRole())}`);
    [Ent.users, Ent.roles, Ent.batches, Ent.exports, Ent.drafts, Ent.bank].forEach(c => c.on(notify));
}

export async function startApp(): Promise<void> {
    await Store.init();
    await enterpriseStart();
    applyTheme();
}
