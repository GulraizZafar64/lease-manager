import { Fragment, useEffect, useRef, useSyncExternalStore } from 'react';
import { Ent, can, entities, entityAllowed, gate, myRole, roleLabel, setRoleOverride } from '../../domain/enterprise';
import { getTrail, go, goToCrumb } from '../../domain/nav';
import { SETTINGS, type AppSettings } from '../../domain/settings';
import { applyTheme } from '../../domain/startup';
import { notify } from '../../domain/state';
import { popover, popoverStore } from '../../utils/uiStore';
import { LOGIN_PATH, getSession, sessionRemembered, signIn, signOut } from '../../domain/session';
import { currentCompany, findAccounts, isCompanyActive, type Account } from '../../domain/platform';
import { userName } from '../../domain/directory';
import { USE_API } from '../../api/client';
import { otherServerCompanies, serverLogout, setSwitchTarget } from '../../api/auth';
import { audit } from '../../domain/enterprise';
import { AS_OF, SCOPE, setAsOf, setScopeEntity } from '../../domain/state';
import { Store } from '../../domain/store';
import { screenMeta } from '../../pages/registry';

function Crumbs() {
    const trail = getTrail();
    return (
        <nav className="crumbs" id="crumbs" aria-label="Breadcrumb">
            {trail.length >= 2 && trail.map((t, i) => {
                const label = screenMeta(t).crumb;
                return (
                    <Fragment key={i}>
                        {i > 0 && <span className="muted">›</span>}
                        {i === trail.length - 1
                            ? <span aria-current="page">{label}</span>
                            : <button type="button" onClick={() => goToCrumb(i)}>{label}</button>}
                    </Fragment>
                );
            })}
        </nav>
    );
}


const ICONS = {
    chevron: 'M6 9l6 6 6-6',
    light: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
    dark: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
    system: 'M3 4h18v12H3zM8 20h8M12 16v4',
    settings: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
    admin: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    building: 'M3 21h18M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1',
    eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
};
const Icon = ({ d, size = 16 }: { d: string; size?: number }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

/** End the session and return to the login page (a fresh load, so no company data stays in memory). */
export async function logOut(): Promise<void> {
    void audit('session.signout', 'Signed out');
    if (USE_API) await serverLogout();
    signOut();
    window.location.replace(LOGIN_PATH() + '?reason=bye');
}

interface SwitchOption { id: string; name: string; role: string; open: () => void }
/** Other companies the signed-in person belongs to. On the server each account has its own
    password and code, so switching signs out here and signs in to the other company. */
function otherCompanies(): SwitchOption[] {
    if (USE_API) return otherServerCompanies().map(c => ({
        id: c.id, name: c.name, role: c.role,
        open: async () => {
            void audit('session.switch', `Switching to ${c.name}`);
            setSwitchTarget({ email: Store.actorEmail(), companyId: c.id, companyName: c.name });
            await serverLogout();
            signOut();
            window.location.replace(LOGIN_PATH());
        },
    }));
    const s = getSession(), email = Store.actorEmail();
    const accounts: Account[] = s && email ? findAccounts(email).filter(a => a.company.id !== s.companyId && a.user.status === 'active' && isCompanyActive(a.company)) : [];
    return accounts.map(a => ({
        id: a.company.id, name: a.company.name, role: a.user.role,
        open: () => {
            void audit('session.switch', `Switched to ${a.company.name}`);
            signIn(a.company.id, { id: a.user.id, name: userName(a.user), email: a.user.email }, sessionRemembered());
            window.location.replace(import.meta.env.BASE_URL);
        },
    }));
}

const initials = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
const savedLabel = (): string => (Store.mode === 'db' ? 'Shared workspace' : Store.mode === 'api' ? 'Saved on the server' : Store.mode === 'local' ? 'Saved in this browser' : 'Not saved') + (Store.writeable ? '' : ', view only');
const isSaved = (): boolean => Store.mode !== 'memory';

function Avatar({ name, large }: { name: string; large?: boolean }) {
    return <span className={`who-avatar${large ? ' lg' : ''}`} aria-hidden="true">{initials(name)}<i className={`who-dot ${isSaved() ? 'ok' : 'off'}`} /></span>;
}

/** Theme for this browser, as chosen in Settings; kept with the same storage key. */
function setTheme(theme: AppSettings['theme']): void {
    SETTINGS.theme = theme;
    try { localStorage.setItem('ifrs16.theme', theme); } catch { /* storage unavailable */ }
    applyTheme();
    notify();
}

function UserMenu() {
    const name = Store.actorName();
    const role = roleLabel(myRole());
    const company = currentCompany(), others = otherCompanies();
    const adminOpen = can('admin.users') || can('admin.settings') || can('audit.view');
    const open = (screen: 'settings' | 'admin') => { popover.close(); go(screen, {}, { reset: true }); };
    return (
        <div className="user-menu" role="menu" aria-label="Account">
            <div className="um-head">
                <Avatar name={name} large />
                <div className="um-id"><b>{name}</b>{Store.actorEmail() && <span className="um-email">{Store.actorEmail()}</span>}<span>{role}{Ent.roleOverride ? ' (preview)' : ''}</span></div>
            </div>
            {company && <div className="um-company"><Icon d={ICONS.building} size={15} /><span><b>{company.name}</b>{others.length ? <em>{others.length + 1} companies</em> : null}</span></div>}
            <div className={`um-status ${isSaved() ? 'ok' : 'off'}`}>{savedLabel()}</div>
            {others.length ? <><div className="um-label">Switch company</div>{others.map(o => <button key={o.id} className="um-item" role="menuitem" onClick={() => { popover.close(); void o.open(); }}><Icon d={ICONS.building} />{o.name}<span className="um-item-note">{roleLabel(o.role)}</span></button>)}</> : null}
            {Ent.roleOverride && <button className="um-item" role="menuitem" onClick={() => { popover.close(); setRoleOverride(null); }}><Icon d={ICONS.eye} />End role preview</button>}
            <div className="um-sep" />
            <div className="um-label">Theme</div>
            <div className="um-theme" role="group" aria-label="Theme">
                {(['light', 'dark', 'system'] as const).map(t => (
                    <button key={t} aria-pressed={SETTINGS.theme === t} onClick={() => { setTheme(t); popover.close(); }}>
                        <Icon d={ICONS[t]} size={14} />{t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark'}
                    </button>
                ))}
            </div>
            <div className="um-sep" />
            <button className="um-item" role="menuitem" {...gate('admin.settings')} onClick={() => open('settings')}><Icon d={ICONS.settings} />Settings</button>
            {adminOpen && <button className="um-item" role="menuitem" onClick={() => open('admin')}><Icon d={ICONS.admin} />Administration</button>}
            <div className="um-sep" />
            <button className="um-item um-danger" role="menuitem" onClick={() => void logOut()}><Icon d={ICONS.logout} />Log out</button>
        </div>
    );
}

/** Signed-in person and role; opens the account menu. */
function Who() {
    const name = Store.actorName();
    const ref = useRef<HTMLButtonElement>(null);
    const pop = useSyncExternalStore(popoverStore.subscribe, popoverStore.get);
    const expanded = !!pop && pop.anchor === ref.current;
    return (
        <button type="button" className="who" id="who" ref={ref} aria-haspopup="menu" aria-expanded={expanded} title={savedLabel()}
            onClick={e => expanded ? popover.close() : popover.open(e.currentTarget, <UserMenu />)}>
            <Avatar name={name} />
            <span className="who-text">
                <b>{name}</b>
                <span className="who-role">{roleLabel(myRole())}{Ent.roleOverride ? ' (preview)' : ''}</span>
            </span>
            <span className="who-chev"><Icon d={ICONS.chevron} size={15} /></span>
        </button>
    );
}

function ScopeSelect() {
    const ents = entities().filter(e => entityAllowed(e.name));
    return (
        <select id="scope" aria-label="Entity" style={{ width: 'auto' }} hidden={ents.length < 2} value={SCOPE.entity} onChange={e => setScopeEntity(e.target.value)}>
            <option value="">{ents.length > 1 ? 'All entities (consolidated)' : (ents[0] ? ents[0].name : 'All')}</option>
            {ents.length > 1 && ents.map(e => <option key={e.name} value={e.name}>{e.name}</option>)}
        </select>
    );
}

/** Publishes the header height for things that stick below it, and marks the header once the page scrolls. */
function useStickyHeader() {
    const ref = useRef<HTMLElement>(null);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const onScroll = () => el.classList.toggle('scrolled', window.scrollY > 4);
        const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', el.offsetHeight + 'px'));
        ro.observe(el);
        onScroll();
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => { ro.disconnect(); window.removeEventListener('scroll', onScroll); };
    }, []);
    return ref;
}

export function Topbar({ title, ready }: { title: string; ready: boolean }) {
    const ref = useStickyHeader();
    return (
        <header className="topbar" ref={ref}>
            <div className="top-title"><Crumbs /><h1 id="page-title" key={title}>{title}</h1></div>
            <div className="top-tools">
                {ready ? <ScopeSelect /> : <select id="scope" aria-label="Entity" style={{ width: 'auto' }} hidden />}
                <label className="asof" htmlFor="asof">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM16 2v4M8 2v4M3 10h18" /></svg>
                    Balances at <input type="date" id="asof" defaultValue={AS_OF}
                    onChange={e => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) setAsOf(e.target.value); }} /></label>
                {ready ? <Who /> : <div className="who" id="who"></div>}
            </div>
        </header>
    );
}
