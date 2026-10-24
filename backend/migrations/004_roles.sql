-- Each company's roles: built-in roles whose permissions were changed, and custom roles.
-- A built-in role without a row has its default permissions (rbac.js ROLE_PERMS); the super
-- administrator always has every permission and has no row.
CREATE TABLE roles (
    company_id   uuid NOT NULL REFERENCES companies(id),
    id           text NOT NULL CHECK (id ~ '^[a-z][a-z0-9-]{0,39}$'),
    label        text NOT NULL,
    description  text NOT NULL DEFAULT '',
    perms        text[] NOT NULL,
    custom       boolean NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    updated_by   uuid,
    PRIMARY KEY (company_id, id),
    CHECK (id <> 'superadmin')
);
CREATE UNIQUE INDEX roles_company_label_uq ON roles (company_id, lower(label));

-- Users may now hold a custom role; the application checks the role exists in the company.
ALTER TABLE users DROP CONSTRAINT users_role_check;
