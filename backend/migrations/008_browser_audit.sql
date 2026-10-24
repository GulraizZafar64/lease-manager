-- Audit entries a company recorded while it used the browser-only app, kept as an archive when its data is
-- brought to the server. They are not part of the server's hash chain (they happened before it); each batch
-- brought in is recorded in the chain with a SHA-256 of its entries, so later changes to the archive show.
CREATE TABLE browser_audit (
    company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    entry_id     text NOT NULL,
    at           timestamptz NOT NULL,
    actor        text,
    actor_name   text,
    role         text,
    action       text NOT NULL,
    detail       text NOT NULL DEFAULT '',
    lease_id     text,
    entity       text,
    source       text NOT NULL,
    imported_by  uuid NOT NULL REFERENCES users(id),
    imported_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, entry_id)
);
CREATE INDEX browser_audit_at_idx ON browser_audit (company_id, at DESC);
