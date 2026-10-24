-- User management on the server: profile, extra permissions, last sign-in, and deletion that keeps history.
ALTER TABLE users ADD COLUMN title         text;
ALTER TABLE users ADD COLUMN extra_perms   text[] NOT NULL DEFAULT '{}';  -- on top of the role (rbac.js PERMS)
ALTER TABLE users ADD COLUMN last_login_at timestamptz;
-- Deleted users keep their row, so approvals, versions and the audit log still name them; they cannot sign in.
ALTER TABLE users ADD COLUMN deleted_at    timestamptz;
ALTER TABLE users ADD COLUMN deleted_by    uuid;

-- An email can be used again once its user is deleted
DROP INDEX users_company_email_uq;
CREATE UNIQUE INDEX users_company_email_uq ON users (company_id, lower(email)) WHERE deleted_at IS NULL;
