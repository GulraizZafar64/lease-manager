/* ======================================================================
   Store: shared workspace in the page's database, else this browser.
   When the page runs inside the Claude viewer, window.claude provides a shared
   database and the signed-in user; elsewhere leases are kept in localStorage.
   ====================================================================== */
import { SETTINGS } from './settings';
import { getSession } from './session';
import { companyKey } from './platform';
import { serverMe } from '../api/auth';
import { ApiError, USE_API } from '../api/client';
import { loadCompanySettings, saveCompanySettings } from '../api/companySettings';
import { deleteLease, importLeases, loadLease, loadLeases, saveLease } from '../api/leases';
import { clearResults, dropResult } from './lease';
import { notify } from './state';
import { Ent, audit, guard, inScope } from './enterprise';
import { toast } from '../utils/uiStore';
import { deepClone, errCode } from '../utils/format';
import type { Lease } from '../types/lease';

/** db: the Claude viewer's shared database; api: the company's server (VITE_USE_API); local: this browser. */
export type StoreMode = 'memory' | 'local' | 'db' | 'api';
const notSaved = (e: unknown): string => 'Not saved: ' + (e instanceof Error && e.message ? e.message : 'check your connection and try again.');

export const Store = {
    all: [] as Lease[],
    get leases(): Lease[] { return this.all.filter(l => inScope(l)); },
    mode: 'memory' as StoreMode,
    db: null as ClaudeDb | null,
    user: null as ClaudeUserCapability | null,
    me: null as ClaudeUserProfile | null,
    ready: false,
    writeable: true,
    paths: { lease: (id: string) => `ws/main/leases/${id}`, leases: 'ws/main/leases', settings: 'ws/settings' },
    async init(): Promise<void> {
        const c = window.claude;
        if (c && c.use) {
            try {
                const [db, user] = await Promise.all([c.use('db'), c.use('user')]);
                this.user = user;
                if (user) { try { this.me = await user.me(); } catch { /* no verified identity */ } }
                if (db) {
                    this.db = db; this.mode = 'db';
                    if (user) { const w = await user.can('data.write').catch(() => null); if (w === false) this.writeable = false; }
                    const s = await db.doc(this.paths.settings).get().catch(() => null);
                    if (s && s.exists) Object.assign(SETTINGS, deepClone(s.data()), { theme: SETTINGS.theme });
                    await new Promise<void>(resolve => {
                        let first = true;
                        db.collection(this.paths.leases).onSnapshot(snap => {
                            this.all = snap.docs.map(d => d.data()).filter(Boolean).map(x => deepClone(x as Lease));
                            if (first) { first = false; resolve(); } else this.emit();
                        }, err => { console.warn('db subscription ended', err); if (first) { first = false; resolve(); } });
                        setTimeout(() => { if (first) { first = false; resolve(); } }, 8000);
                    });
                    this.ready = true; return;
                }
            } catch (e) { console.warn('db unavailable', e); }
        }
        // Signed in through the API: the company's settings, entities, rates and leases come from the server
        if (USE_API) {
            await loadCompanySettings();
            this.all = await loadLeases();
            this.mode = 'api'; this.ready = true; return;
        }
        try {
            const raw = localStorage.getItem(companyKey('leases'));
            if (raw) this.all = JSON.parse(raw);
            const s = localStorage.getItem(companyKey('settings'));
            if (s) Object.assign(SETTINGS, JSON.parse(s));
            this.mode = 'local';
        } catch { this.mode = 'memory'; }
        this.ready = true;
    },
    actorId(): string { const s = getSession(); return (this.me && this.me.id) || (this.mode !== 'db' && s && s.userId) || 'local-user'; },
    actorName(): string {
        const u = Ent.users.get(this.actorId()), m = serverMe();
        return (this.me && this.me.name) || (m && m.user.name) || (u && u.name) || SETTINGS.userName || 'User';
    },
    /** Email of the signed-in user, for users managed in this app. */
    actorEmail(): string { const m = serverMe(), u = Ent.users.get(this.actorId()); return (m && m.user.email) || (u && u.email) || ''; },
    emit(): void { clearResults(); notify(); },
    persistLocal(): void {
        if (this.mode !== 'local') return;
        try { localStorage.setItem(companyKey('leases'), JSON.stringify(this.all)); } catch { toast('This browser could not save the change. Export a backup from Settings.'); }
    },
    /** Read one lease again from the server (after a change, or to show what it holds after a refusal). */
    async refreshLease(id: string): Promise<void> {
        let fresh: Lease | null = null;
        try { fresh = await loadLease(id); } catch (e) { if (!(e instanceof ApiError && e.code === 'not_found')) return; }
        this.all = fresh ? (this.all.some(l => l.id === id) ? this.all.map(l => l.id === id ? fresh as Lease : l) : this.all.concat([fresh])) : this.all.filter(l => l.id !== id);
        dropResult(id); notify();
    },
    /** All leases again from the server: other people's changes. */
    async refresh(): Promise<void> {
        if (this.mode !== 'api') return;
        try { this.all = await loadLeases(); clearResults(); notify(); } catch { /* shown on the next action */ }
    },
    /** Entity names on leases after entities are renamed (the server links leases to entities by id). */
    remapEntities(): void {
        for (const l of this.all) { const e = (SETTINGS.entities || []).find(x => x.id && x.id === l.entityId); if (e) l.entity = e.name; }
        clearResults(); notify();
    },
    /** Leases brought in as they are (sample portfolio): on the server, one request; returns how many were added. */
    async importAll(list: Lease[], source: string): Promise<number> {
        if (this.mode !== 'api') { for (const l of list) await this.save(l); return list.length; }
        try { const r = await importLeases(list, source); await this.refresh(); if (r.skipped.length) toast(`${r.skipped.length} lease ID${r.skipped.length > 1 ? 's were' : ' was'} already used and left as they are: ${r.skipped.join(', ')}`); return r.imported.length; }
        catch (e) { toast(notSaved(e)); return 0; }
    },
    /** Save a lease; false (with the reason shown) when it was not saved. */
    async save(lease: Lease): Promise<boolean> {
        if (this.mode === 'api') {
            try { await saveLease(this.get(lease.id), lease); }
            catch (e) { toast(notSaved(e)); await this.refreshLease(lease.id); return false; }
            await this.refreshLease(lease.id);
            return true;
        }
        lease.updatedAt = new Date().toISOString();
        const i = this.all.findIndex(l => l.id === lease.id);
        if (i >= 0) this.all[i] = lease; else this.all.push(lease);
        dropResult(lease.id);
        if (this.mode === 'db' && this.db) {
            try { await this.db.doc(this.paths.lease(lease.id)).set(deepClone(lease)); }
            catch (e) { const c = errCode(e); toast(c === 'quota_exceeded' ? 'Storage is full. Delete old leases or documents.' : c === 'invalid_argument' ? 'You have view-only access, so changes are not saved.' : 'Could not save. Try again.'); console.warn(e); notify(); return false; }
        } else this.persistLocal();
        notify();
        return true;
    },
    /** Delete a lease: needs the lease.delete permission and is recorded in the audit log. */
    async remove(id: string): Promise<boolean> {
        if (!guard('lease.delete')) return false;
        if (this.mode !== 'api') audit('lease.delete', `Lease ${id} deleted`, { leaseId: id }); // the server records its own
        return this.removeUnchecked(id);
    },
    async removeUnchecked(id: string): Promise<boolean> {
        if (this.mode === 'api') {
            try { await deleteLease(id); } catch (e) { toast(notSaved(e)); return false; }
            this.all = this.all.filter(l => l.id !== id); dropResult(id); notify();
            return true;
        }
        this.all = this.all.filter(l => l.id !== id); dropResult(id);
        if (this.mode === 'db' && this.db) { try { await this.db.doc(this.paths.lease(id)).delete(); } catch { toast('Could not delete.'); } }
        else this.persistLocal();
        notify();
        return true;
    },
    /** Save SETTINGS; false (with the reason shown) when it was not saved. */
    async saveSettings(): Promise<boolean> {
        const s = deepClone(SETTINGS);
        let ok = true;
        try { localStorage.setItem('ifrs16.theme', SETTINGS.theme); } catch { /* storage unavailable */ }
        if (this.mode === 'db' && this.db) { try { await this.db.doc(this.paths.settings).set(s); } catch { toast('Could not save settings.'); ok = false; } }
        else if (USE_API) ok = await saveCompanySettings();
        else { try { localStorage.setItem(companyKey('settings'), JSON.stringify(s)); } catch { /* storage unavailable */ } }
        clearResults();
        notify();
        return ok;
    },
    get(id: string): Lease | undefined { return this.all.find(l => l.id === id); },
};
