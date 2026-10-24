-- Multiple companies (SaaS): one shared database, a company_id on every company's row.
-- Business keys (lease IDs, user emails, entity codes and names, settings, exchange rates) become
-- unique per company, and child rows reference their parent together with the company, so the
-- database itself refuses rows that mix companies. Existing data moves into a "Default company".

CREATE TABLE companies (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code               text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,29}$'),
    name               text NOT NULL,
    base_currency      char(3) NOT NULL DEFAULT 'PKR',
    status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
    status_changed_at  timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    created_by         uuid                -- platform administrator; null when created by the CLI or this migration
);
CREATE UNIQUE INDEX companies_name_uq ON companies (lower(name));

-- The SaaS operator's own accounts, separate from every company's users (used from the platform API).
CREATE TABLE platform_admins (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email                 text NOT NULL,
    name                  text NOT NULL,
    role                  text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
    status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    password_hash         text NOT NULL,
    must_change_password  boolean NOT NULL DEFAULT true,
    password_changed_at   timestamptz NOT NULL DEFAULT now(),
    mfa_secret_enc        text,
    mfa_enabled           boolean NOT NULL DEFAULT false,
    mfa_last_step         bigint,
    failed_logins         int NOT NULL DEFAULT 0,
    locked_until          timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_admins_email_uq ON platform_admins (lower(email));
CREATE TABLE platform_sessions (
    token_hash   text PRIMARY KEY,
    admin_id     uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
    mfa_passed   boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen    timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    ip           inet,
    user_agent   text
);
CREATE INDEX platform_sessions_admin_idx ON platform_sessions (admin_id);

-- Existing installations: everything so far belongs to one company.
INSERT INTO companies (code, name, base_currency)
SELECT 'default', 'Default company', coalesce((SELECT value->>'currency' FROM settings WHERE key = 'base_currency'), 'PKR')
WHERE EXISTS (SELECT 1 FROM users) OR EXISTS (SELECT 1 FROM entities) OR EXISTS (SELECT 1 FROM settings) OR EXISTS (SELECT 1 FROM leases);

-- Add company_id to each table, fill it for existing rows, then require it.
ALTER TABLE users          ADD COLUMN company_id uuid REFERENCES companies(id);
ALTER TABLE entities       ADD COLUMN company_id uuid REFERENCES companies(id);
ALTER TABLE settings       ADD COLUMN company_id uuid REFERENCES companies(id);
ALTER TABLE leases         ADD COLUMN company_id uuid REFERENCES companies(id);
ALTER TABLE lease_versions ADD COLUMN company_id uuid;
ALTER TABLE lease_events   ADD COLUMN company_id uuid;
ALTER TABLE approvals      ADD COLUMN company_id uuid REFERENCES companies(id);
ALTER TABLE payments       ADD COLUMN company_id uuid;
ALTER TABLE fx_rates       ADD COLUMN company_id uuid REFERENCES companies(id);
ALTER TABLE audit_log      ADD COLUMN company_id uuid REFERENCES companies(id);   -- null: the platform's own log

UPDATE users          SET company_id = (SELECT id FROM companies WHERE code = 'default');
UPDATE entities       SET company_id = (SELECT id FROM companies WHERE code = 'default');
UPDATE settings       SET company_id = (SELECT id FROM companies WHERE code = 'default');
UPDATE leases         SET company_id = (SELECT id FROM companies WHERE code = 'default');
UPDATE lease_versions SET company_id = (SELECT id FROM companies WHERE code = 'default');
UPDATE lease_events   SET company_id = (SELECT id FROM companies WHERE code = 'default');
UPDATE approvals      SET company_id = (SELECT id FROM companies WHERE code = 'default');
UPDATE payments       SET company_id = (SELECT id FROM companies WHERE code = 'default');
UPDATE fx_rates       SET company_id = (SELECT id FROM companies WHERE code = 'default');
-- The audit log rejects updates; company_id is not part of the hashed content, so the chain stays valid.
ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update;
UPDATE audit_log SET company_id = (SELECT id FROM companies WHERE code = 'default');
ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update;

ALTER TABLE users          ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE entities       ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE settings       ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE leases         ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE lease_versions ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE lease_events   ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE approvals      ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE payments       ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE fx_rates       ALTER COLUMN company_id SET NOT NULL;

-- Users: email unique within a company (the same person may belong to several companies).
DROP INDEX users_email_uq;
CREATE UNIQUE INDEX users_company_email_uq ON users (company_id, lower(email));
CREATE INDEX users_email_idx ON users (lower(email));
ALTER TABLE users ADD CONSTRAINT users_company_id_uq UNIQUE (company_id, id);

-- Entities: code and name unique within a company; children reference (company_id, id).
ALTER TABLE entities DROP CONSTRAINT entities_code_key, DROP CONSTRAINT entities_name_key;
ALTER TABLE entities ADD CONSTRAINT entities_company_code_uq UNIQUE (company_id, code),
                     ADD CONSTRAINT entities_company_name_uq UNIQUE (company_id, name),
                     ADD CONSTRAINT entities_company_id_uq UNIQUE (company_id, id);
ALTER TABLE entities DROP CONSTRAINT entities_parent_id_fkey;
ALTER TABLE entities ADD CONSTRAINT entities_parent_fkey FOREIGN KEY (company_id, parent_id) REFERENCES entities (company_id, id);

-- A user's entity access must be within their own company.
ALTER TABLE user_entities ADD COLUMN company_id uuid;
UPDATE user_entities ue SET company_id = u.company_id FROM users u WHERE u.id = ue.user_id;
ALTER TABLE user_entities ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE user_entities DROP CONSTRAINT user_entities_user_id_fkey, DROP CONSTRAINT user_entities_entity_id_fkey;
ALTER TABLE user_entities ADD CONSTRAINT user_entities_user_fkey FOREIGN KEY (company_id, user_id) REFERENCES users (company_id, id) ON DELETE CASCADE,
                          ADD CONSTRAINT user_entities_entity_fkey FOREIGN KEY (company_id, entity_id) REFERENCES entities (company_id, id) ON DELETE CASCADE;

-- Settings and exchange rates: one set per company.
ALTER TABLE settings DROP CONSTRAINT settings_pkey;
ALTER TABLE settings ADD PRIMARY KEY (company_id, key);
ALTER TABLE fx_rates DROP CONSTRAINT fx_rates_pkey;
ALTER TABLE fx_rates ADD PRIMARY KEY (company_id, rate_date, currency);

-- Leases: business IDs unique within a company; children reference (company_id, lease_id).
ALTER TABLE lease_versions DROP CONSTRAINT lease_versions_lease_id_fkey;
ALTER TABLE lease_events   DROP CONSTRAINT lease_events_lease_id_fkey;
ALTER TABLE payments       DROP CONSTRAINT payments_lease_id_fkey;
ALTER TABLE leases DROP CONSTRAINT leases_pkey;
ALTER TABLE leases ADD PRIMARY KEY (company_id, id);
ALTER TABLE leases DROP CONSTRAINT leases_entity_id_fkey;
ALTER TABLE leases ADD CONSTRAINT leases_entity_fkey FOREIGN KEY (company_id, entity_id) REFERENCES entities (company_id, id);
ALTER TABLE lease_versions DROP CONSTRAINT lease_versions_pkey;
ALTER TABLE lease_versions ADD PRIMARY KEY (company_id, lease_id, version);
ALTER TABLE lease_versions ADD CONSTRAINT lease_versions_lease_fkey FOREIGN KEY (company_id, lease_id) REFERENCES leases (company_id, id) ON DELETE CASCADE;
ALTER TABLE lease_events   ADD CONSTRAINT lease_events_lease_fkey FOREIGN KEY (company_id, lease_id) REFERENCES leases (company_id, id) ON DELETE CASCADE;
ALTER TABLE payments       ADD CONSTRAINT payments_lease_fkey FOREIGN KEY (company_id, lease_id) REFERENCES leases (company_id, id) ON DELETE CASCADE;
DROP INDEX leases_entity_idx, lease_events_lease_idx, payments_lease_idx;
CREATE INDEX leases_entity_idx ON leases (company_id, entity_id);
CREATE INDEX lease_events_lease_idx ON lease_events (company_id, lease_id);
CREATE INDEX payments_lease_idx ON payments (company_id, lease_id);

-- Approvals: one decision per user per item version, within a company.
ALTER TABLE approvals DROP CONSTRAINT approvals_item_type_item_id_item_version_user_id_key;
ALTER TABLE approvals ADD CONSTRAINT approvals_company_item_user_uq UNIQUE (company_id, item_type, item_id, item_version, user_id);

-- Audit log: one hash chain per company (and one for the platform, company_id null).
CREATE INDEX audit_company_idx ON audit_log (company_id, id);
DROP INDEX audit_object_idx;
CREATE INDEX audit_object_idx ON audit_log (company_id, object_type, object_id);
