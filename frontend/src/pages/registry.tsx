/* Screens: page component, title and breadcrumb label for each screen, and the
   role checks the original page applied before rendering some screens. */
import type { ComponentType } from 'react';
import { Store } from '../domain/store';
import { PERMS, can, entityAllowed, myRole, roleLabel } from '../domain/enterprise';
import type { ScreenId, ScreenParamMap, TrailItem } from '../domain/nav';
import type { Permission } from '../types/enterprise';
import { DashboardPage } from './DashboardPage';
import { RegisterPage } from './RegisterPage';
import { LeaseDetailPage } from './LeaseDetailPage';
import { LeaseEntryPage } from './LeaseEntryPage';
import { ImportPage } from './ImportPage';
import { PaymentsPage } from './PaymentsPage';
import { ApprovalsPage } from './ApprovalsPage';
import { JournalsPage } from './JournalsPage';
import { ReportsPage } from './ReportsPage';
import { AiAdvisorPage } from './AiAdvisorPage';
import { GuidancePage } from './GuidancePage';
import { CalculatorsPage } from './CalculatorsPage';
import { ValidationPage } from './ValidationPage';
import { SettingsPage } from './SettingsPage';
import { BankPage } from './BankPage';
import { BatchesPage } from './BatchesPage';
import { ErpPage } from './ErpPage';
import { AnalyticsPage } from './AnalyticsPage';
import { AdminPage } from './AdminPage';
import { UsersPage } from './UsersPage';
import { RolesPage } from './RolesPage';

export interface ScreenProps<S extends ScreenId> { params: ScreenParamMap[S] }
interface Meta { title: string; crumb: string }
interface ScreenDef<S extends ScreenId> { component: ComponentType<ScreenProps<S>>; meta: (p: ScreenParamMap[S]) => Meta }

const fixed = (title: string, crumb: string) => () => ({ title, crumb });

const SCREENS: { [S in ScreenId]: ScreenDef<S> } = {
    dashboard: { component: DashboardPage, meta: fixed('Portfolio overview', 'Overview') },
    register: { component: RegisterPage, meta: p => ({ title: 'Lease register', crumb: p && p.preset ? 'Filtered register' : 'Register' }) },
    detail: { component: LeaseDetailPage, meta: p => ({ title: (Store.get(p.id) || { name: '' }).name || 'Lease ' + p.id, crumb: p.id }) },
    entry: { component: LeaseEntryPage, meta: p => p.mode === 'edit' ? { title: 'Edit ' + p.id, crumb: 'Edit' } : { title: 'Add a lease', crumb: 'Add lease' } },
    import: { component: ImportPage, meta: p => ({ title: p && p.attachTo ? 'Attach a document to ' + p.attachTo : 'Import a contract', crumb: 'Import' }) },
    payments: { component: PaymentsPage, meta: fixed('Payments and receipts', 'Payments') },
    approvals: { component: ApprovalsPage, meta: fixed('Approvals', 'Approvals') },
    journals: { component: JournalsPage, meta: fixed('Journal entries', 'Journals') },
    reports: { component: ReportsPage, meta: fixed('Reports and disclosures', 'Reports') },
    ai: { component: AiAdvisorPage, meta: fixed('AI advisor', 'AI advisor') },
    guidance: { component: GuidancePage, meta: fixed('IFRS 16 guidance', 'Guidance') },
    tools: { component: CalculatorsPage, meta: fixed('Calculators', 'Calculators') },
    validation: { component: ValidationPage, meta: fixed('Calculation validation', 'Validation') },
    settings: { component: SettingsPage, meta: fixed('Settings', 'Settings') },
    bank: { component: BankPage, meta: fixed('Bank reconciliation', 'Bank') },
    batches: { component: BatchesPage, meta: fixed('Payment batches', 'Batches') },
    erp: { component: ErpPage, meta: fixed('ERP and general ledger export', 'ERP export') },
    analytics: { component: AnalyticsPage, meta: fixed('Analytics', 'Analytics') },
    admin: { component: AdminPage, meta: fixed('Administration', 'Administration') },
    users: { component: UsersPage, meta: fixed('Users', 'Users') },
    roles: { component: RolesPage, meta: fixed('Roles and permissions', 'Roles') },
};

export function screenMeta(t: TrailItem): Meta {
    const def = SCREENS[t.screen] as ScreenDef<ScreenId> | undefined;
    return def ? def.meta(t.params) : { title: t.screen, crumb: t.screen };
}

/** Screens the original page refused for some roles, with the message it showed. */
const SCREEN_PERM: Partial<Record<ScreenId, Permission>> = { entry: 'lease.edit', import: 'lease.import', settings: 'admin.settings', users: 'admin.users', roles: 'admin.users' };

function NotForRole({ perm }: { perm: Permission }) {
    return <div className="banner warn"><div><strong>Not available for your role</strong><p>{roleLabel(myRole())} cannot {PERMS[perm].toLowerCase()}. Ask an administrator if you need access.</p></div></div>;
}

export function Screen({ item }: { item: TrailItem }) {
    const { screen, params } = item;
    const perm = SCREEN_PERM[screen];
    const attaching = screen === 'import' && (params as ScreenParamMap['import']).attachTo && can('lease.edit');
    if (perm && !attaching && !can(perm)) return <NotForRole perm={perm} />;
    if (screen === 'detail') {
        const l = Store.get((params as ScreenParamMap['detail']).id);
        if (l && !entityAllowed(l.entity)) return <div className="banner warn"><div><strong>No access</strong><p>This lease belongs to an entity you are not assigned to.</p></div></div>;
    }
    const Page = SCREENS[screen].component as ComponentType<ScreenProps<ScreenId>>;
    return <Page params={params} />;
}
