-- IFRS 16 Lease Manager: initial schema
-- Conventions: UUID keys, timestamptz in UTC, JSONB for lease terms (validated in the application),
-- every financial record versioned, audit log append-only and hash-chained.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE settings (
    key         text PRIMARY KEY,
    value       jsonb NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid
);

CREATE TABLE entities (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code                 text NOT NULL UNIQUE,
    name                 text NOT NULL UNIQUE,
    functional_currency  char(3) NOT NULL,
    parent_id            uuid REFERENCES entities(id),
    country              text,
    active               boolean NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email                 text NOT NULL,
    name                  text NOT NULL,
    role                  text NOT NULL CHECK (role IN ('superadmin','admin','controller','preparer','treasury','auditor','viewer')),
    status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    password_hash         text NOT NULL,
    must_change_password  boolean NOT NULL DEFAULT true,
    password_changed_at   timestamptz NOT NULL DEFAULT now(),
    mfa_secret_enc        text,            -- AES-256-GCM, key from MASTER_KEY
    mfa_enabled           boolean NOT NULL DEFAULT false,
    mfa_last_step         bigint,          -- last accepted TOTP time step (prevents code reuse)
    approval_limit        numeric(20,2),   -- null = no limit, in base currency
    failed_logins         int NOT NULL DEFAULT 0,
    locked_until          timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    created_by            uuid
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE user_entities (
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_id  uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, entity_id)
);

CREATE TABLE sessions (
    token_hash   text PRIMARY KEY,           -- SHA-256 of the cookie token; the token itself is never stored
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mfa_passed   boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen    timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    ip           inet,
    user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE leases (
    id           text PRIMARY KEY,           -- business ID, e.g. WH-KHI-01
    entity_id    uuid NOT NULL REFERENCES entities(id),
    role         text NOT NULL CHECK (role IN ('lessee','lessor')),
    status       text NOT NULL CHECK (status IN ('draft','pending','active','rejected')),
    data         jsonb NOT NULL,             -- description, counterparty, currency, terms
    version      int NOT NULL DEFAULT 1,
    created_by   uuid NOT NULL REFERENCES users(id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_by   uuid REFERENCES users(id),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    submitted_by uuid REFERENCES users(id),
    submitted_at timestamptz
);
CREATE INDEX leases_entity_idx ON leases (entity_id);

-- Every saved state of a lease, for audit and point-in-time reporting
CREATE TABLE lease_versions (
    lease_id    text NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
    version     int NOT NULL,
    status      text NOT NULL,
    data        jsonb NOT NULL,
    changed_by  uuid NOT NULL REFERENCES users(id),
    changed_at  timestamptz NOT NULL DEFAULT now(),
    reason      text,
    PRIMARY KEY (lease_id, version)
);

CREATE TABLE lease_events (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lease_id      text NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
    type          text NOT NULL,
    effective     date NOT NULL,
    params        jsonb NOT NULL DEFAULT '{}',
    reason        text NOT NULL,
    status        text NOT NULL CHECK (status IN ('pending','approved','rejected')),
    submitted_by  uuid NOT NULL REFERENCES users(id),
    submitted_at  timestamptz NOT NULL DEFAULT now(),
    decided_at    timestamptz
);
CREATE INDEX lease_events_lease_idx ON lease_events (lease_id);

CREATE TABLE approvals (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    item_type   text NOT NULL CHECK (item_type IN ('lease','change','batch','draft')),
    item_id     text NOT NULL,
    item_version int,
    user_id     uuid NOT NULL REFERENCES users(id),
    role        text NOT NULL,
    amount      numeric(20,2) NOT NULL,
    decision    text NOT NULL CHECK (decision IN ('approve','reject')),
    comment     text,
    at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (item_type, item_id, item_version, user_id)
);

CREATE TABLE payments (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lease_id      text NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
    kind          text NOT NULL CHECK (kind IN ('scheduled','variable')),
    due_date      date,
    for_type      text,
    amount        numeric(20,2) NOT NULL CHECK (amount > 0),
    paid_date     date NOT NULL,
    reference     text,
    bank_line_id  text,
    created_by    uuid NOT NULL REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_lease_idx ON payments (lease_id);

CREATE TABLE fx_rates (
    rate_date  date NOT NULL,
    currency   char(3) NOT NULL,
    rate       numeric(20,8) NOT NULL CHECK (rate > 0),   -- units of base currency per 1 unit
    source     text,
    PRIMARY KEY (rate_date, currency)
);

-- Append-only, hash-chained audit log. Each row's hash covers its content and the previous row's hash,
-- so deleting or editing a row breaks the chain (checked by `npm run audit:verify`).
CREATE TABLE audit_log (
    id           bigserial PRIMARY KEY,
    at           timestamptz NOT NULL DEFAULT now(),
    user_id      uuid,
    user_name    text,
    role         text,
    action       text NOT NULL,
    object_type  text,
    object_id    text,
    entity_id    uuid,
    detail       jsonb NOT NULL DEFAULT '{}',
    ip           inet,
    prev_hash    text NOT NULL,
    hash         text NOT NULL
);
CREATE INDEX audit_at_idx ON audit_log (at);
CREATE INDEX audit_object_idx ON audit_log (object_type, object_id);

CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
    -- Deletion is allowed only for retention purges, which set this session flag and are themselves audited.
    IF TG_OP = 'DELETE' AND current_setting('app.retention_purge', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'audit_log is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
