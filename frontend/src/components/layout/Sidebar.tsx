import { useLayoutEffect, useRef, useState } from 'react';
import { can, gate } from '../../domain/enterprise';
import { getTrail, go, type ScreenId } from '../../domain/nav';
import { pendingApprovals } from '../../domain/approvals';
import type { Permission } from '../../types/enterprise';
import { NavIcon } from './NavIcon';
import { currentCompany } from '../../domain/platform';

interface NavItem { screen: ScreenId; label: string; perm?: Permission }
interface NavGroup { title: string; items: NavItem[] }

const NAV: NavGroup[] = [
    { title: 'Portfolio', items: [
        { screen: 'dashboard', label: 'Overview' },
        { screen: 'register', label: 'Lease register' },
        { screen: 'entry', label: 'Add a lease', perm: 'lease.edit' },
        { screen: 'import', label: 'Import a contract', perm: 'lease.import' },
    ] },
    { title: 'Operations', items: [
        { screen: 'payments', label: 'Payments and receipts' },
        { screen: 'approvals', label: 'Approvals' },
        { screen: 'bank', label: 'Bank reconciliation', perm: 'bank.reconcile' },
        { screen: 'batches', label: 'Payment batches', perm: 'payment.batch' },
        { screen: 'journals', label: 'Journal entries' },
        { screen: 'erp', label: 'ERP export', perm: 'gl.export' },
    ] },
    { title: 'Reporting', items: [
        { screen: 'reports', label: 'Reports and disclosures' },
        { screen: 'analytics', label: 'Analytics' },
    ] },
    { title: 'Guidance', items: [
        { screen: 'ai', label: 'AI advisor', perm: 'ai.use' },
        { screen: 'guidance', label: 'IFRS 16 guidance' },
        { screen: 'tools', label: 'Calculators' },
        { screen: 'validation', label: 'Validation' },
    ] },
    { title: 'Administration', items: [
        { screen: 'users', label: 'Users', perm: 'admin.users' },
        { screen: 'roles', label: 'Roles and permissions', perm: 'admin.users' },
        { screen: 'admin', label: 'Administration', perm: 'audit.view' },
        { screen: 'settings', label: 'Settings', perm: 'admin.settings' },
    ] },
];

function open(screen: ScreenId) {
    if (screen === 'entry') go('entry', { mode: 'new' }, { reset: true });
    else if (screen === 'import') go('import', { fresh: true }, { reset: true });
    else go(screen, {}, { reset: true });
}

/** Keeps the highlight behind the active link, sliding it there when the active link changes. */
function useNavInk(root: ScreenId | undefined, collapsed: boolean) {
    const nav = useRef<HTMLElement>(null);
    const ink = useRef<HTMLSpanElement>(null);
    const place = (animate: boolean) => {
        const el = ink.current, link = nav.current && nav.current.querySelector<HTMLElement>('.nav-link.active');
        if (!el) return;
        el.classList.toggle('animate', animate && el.classList.contains('on'));
        el.classList.toggle('on', !!link);
        if (link) { el.style.transform = `translateY(${link.offsetTop}px)`; el.style.height = link.offsetHeight + 'px'; }
    };
    const placeRef = useRef(place);
    placeRef.current = place;
    useLayoutEffect(() => { placeRef.current(true); }, [root]);
    // Collapsing or expanding moves every link: place the highlight again now and once the width has settled.
    useLayoutEffect(() => {
        placeRef.current(false);
        const side = nav.current;
        const settle = (e: TransitionEvent) => { if (e.target === side && e.propertyName === 'width') placeRef.current(false); };
        side?.addEventListener('transitionend', settle);
        return () => side?.removeEventListener('transitionend', settle);
    }, [collapsed]);
    useLayoutEffect(() => {
        // Link heights change once the web font loads and when the layout reflows.
        const settle = () => placeRef.current(false);
        let live = true;
        document.fonts.ready.then(() => { if (live) settle(); });
        window.addEventListener('resize', settle);
        return () => { live = false; window.removeEventListener('resize', settle); };
    }, []);
    return { nav, ink };
}

/* On a wide screen the sidebar can fold to its icons; the choice is kept for this browser. */
const COLLAPSE_KEY = 'ifrs16.sideCollapsed';
const savedCollapsed = (): boolean => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } };

export function Sidebar() {
    const root = getTrail()[0]?.screen;
    const [collapsed, setCollapsed] = useState(savedCollapsed);
    const toggleCollapsed = () => setCollapsed(c => { try { localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1'); } catch { /* storage unavailable */ } return !c; });
    const { nav, ink } = useNavInk(root, collapsed);
    const pending = pendingApprovals().length;
    // On a phone the menu folds away behind a button; choosing a screen folds it again.
    const [menuOpen, setMenuOpen] = useState(false);
    // Administration is shown to anyone who can manage users or settings, or view the audit log.
    const adminOpen = can('admin.users') || can('admin.settings') || can('audit.view');
    return (
        <nav className={`side${menuOpen ? ' open' : ''}${collapsed ? ' collapsed' : ''}`} aria-label="Main" ref={nav}>
            <div className="brand"><div className="brand-mark" aria-hidden="true">16</div><div className="brand-text"><b>IFRS 16 Lease Manager</b><span>{currentCompany()?.name || 'Lessee and lessor accounting'}</span></div>
                <button type="button" className="side-collapse" id="side-collapse" aria-expanded={!collapsed} aria-controls="nav-menu" aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar to icons'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={toggleCollapsed}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={collapsed ? 'M9 6l6 6-6 6' : 'M15 18l-6-6 6-6'} /></svg>
                </button>
                <button type="button" className="nav-toggle" id="nav-toggle" aria-expanded={menuOpen} aria-controls="nav-menu" aria-label={menuOpen ? 'Close menu' : 'Open menu'} onClick={() => setMenuOpen(o => !o)}>
                    {pending ? <span className="nav-count" aria-hidden="true">{pending}</span> : null}
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d={menuOpen ? 'M6 6l12 12M18 6 6 18' : 'M4 7h16M4 12h16M4 17h16'} /></svg>
                </button>
            </div>
            <div className="nav-menu" id="nav-menu">
                <span className="nav-ink" ref={ink} aria-hidden="true" />
                {NAV.map(g => (
                    <div className="nav-group" key={g.title}>
                        <h5>{g.title}</h5>
                        {g.items.map(it => {
                            const perm = it.screen === 'admin' && adminOpen ? {} : it.perm ? gate(it.perm) : {};
                            return (
                                <button key={it.screen} className={`nav-link${root === it.screen ? ' active' : ''}`} data-screen={it.screen} title={collapsed ? it.label : undefined} onClick={() => { setMenuOpen(false); open(it.screen); }} aria-current={root === it.screen ? 'page' : undefined} {...perm}>
                                    <NavIcon screen={it.screen} /><span className="nav-label">{it.label}</span>
                                    {it.screen === 'approvals' && <>{' '}<span className="nav-count" id="nav-approvals-count" hidden={!pending}>{pending || ''}</span></>}
                                </button>
                            );
                        })}
                    </div>
                ))}
                <div className="side-foot">Figures are only as good as the inputs and judgements. Review before posting.</div>
            </div>
        </nav>
    );
}
