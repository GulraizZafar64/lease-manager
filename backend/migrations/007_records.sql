-- ERP export files (tracked until confirmed posted) and AI-drafted disclosures (final after approval).
-- Ids are the ones the web app gives them. Draft approvals are in `approvals` (item_type 'draft', item_version = version),
-- so editing a draft (a new version) needs its approvals again.
CREATE TABLE erp_exports (
    company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    id           text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$'),
    target       text NOT NULL,
    period_from  date NOT NULL,
    period_to    date NOT NULL,
    entries      int NOT NULL,
    debits       numeric NOT NULL,
    keys         jsonb NOT NULL DEFAULT '[]',
    status       text NOT NULL DEFAULT 'generated' CHECK (status IN ('generated','posted','failed')),
    notes        text,
    created_by   uuid NOT NULL REFERENCES users(id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    marked_by    uuid REFERENCES users(id),
    marked_at    timestamptz,
    PRIMARY KEY (company_id, id)
);

CREATE TABLE ai_drafts (
    company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    id           text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$'),
    title        text NOT NULL,
    period_from  date NOT NULL,
    period_to    date NOT NULL,
    text         text NOT NULL,
    source       text NOT NULL DEFAULT '',
    status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
    version      int NOT NULL DEFAULT 1,
    created_by   uuid NOT NULL REFERENCES users(id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    edited_by    uuid REFERENCES users(id),
    edited_at    timestamptz,
    PRIMARY KEY (company_id, id)
);

-- Batches brought back from a backup keep their history but cannot produce a bank file again
ALTER TABLE payment_batches ADD COLUMN restored boolean NOT NULL DEFAULT false;
