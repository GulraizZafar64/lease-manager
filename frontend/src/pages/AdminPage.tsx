import type { ComponentType } from 'react';
import type { ScreenProps } from './registry';
import { can } from '../domain/enterprise';
import { setParams } from '../domain/nav';
import { useAppState } from '../hooks/useAppState';
import { UsersTab } from '../components/admin/UsersTab';
import { EntitiesTab, FxTab, IntegrationsTab, PolicyTab } from '../components/admin/SettingsTabs';
import { SecurityTab } from '../components/admin/SecurityTab';
import { AuditTab, MonitorTab } from '../components/admin/MonitorTabs';
import type { Permission } from '../types/enterprise';

const ADMIN_TABS: [string, string, Permission][] = [['users', 'Users and roles', 'admin.users'], ['policy', 'Approval policy', 'admin.settings'], ['entities', 'Entities', 'admin.settings'], ['fx', 'Currencies and rates', 'admin.settings'], ['integrations', 'Integrations', 'admin.settings'], ['security', 'Security and data', 'admin.data'], ['monitor', 'System monitor', 'audit.view'], ['audit', 'Audit log', 'audit.view']];
const ADMIN: Record<string, ComponentType> = { users: UsersTab, policy: PolicyTab, entities: EntitiesTab, fx: FxTab, integrations: IntegrationsTab, security: SecurityTab, monitor: MonitorTab, audit: AuditTab };

export function AdminPage({ params: p }: ScreenProps<'admin'>) {
    useAppState();
    const tabs = ADMIN_TABS.filter(t => can(t[2]));
    if (!tabs.length) return <div className="banner warn"><div><strong>Not available for your role</strong></div></div>;
    const tab = tabs.find(t => t[0] === p.tab) ? p.tab as string : tabs[0][0];
    const Body = ADMIN[tab];
    return (
        <div className="card"><div className="tabs">{tabs.map(([k, v]) => <button key={k} className={`tab ${tab === k ? 'active' : ''}`} data-t={k} onClick={() => setParams<'admin'>({ tab: k })}>{v}</button>)}</div><div className="pad" id="ad-body"><Body key={tab} /></div></div>
    );
}
