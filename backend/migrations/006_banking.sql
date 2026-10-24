-- Bank statements with their lines (reconciliation), and payment batches (maker-checker, bank files).
-- Ids are the ones the web app gives them, so payments keep their link to the bank line they were matched to.
CREATE TABLE bank_statements (
    company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    id           text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$'),
    name         text NOT NULL,
    format       text NOT NULL,
    account      text NOT NULL DEFAULT '',
    imported_by  uuid NOT NULL REFERENCES users(id),
    imported_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, id)
);

CREATE TABLE bank_lines (
    company_id    uuid NOT NULL,
    statement_id  text NOT NULL,
    id            text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$'),
    pos           int NOT NULL,
    line_date     date NOT NULL,
    amount        numeric NOT NULL,
    reference     text NOT NULL DEFAULT '',
    description   text NOT NULL DEFAULT '',
    hash          text NOT NULL,
    duplicate     boolean NOT NULL DEFAULT false,
    status        text NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched','suggested','matched','ignored')),
    suggest       jsonb,
    match         jsonb,
    PRIMARY KEY (company_id, id),
    FOREIGN KEY (company_id, statement_id) REFERENCES bank_statements (company_id, id) ON DELETE CASCADE
);
CREATE INDEX bank_lines_statement_idx ON bank_lines (company_id, statement_id, pos);
CREATE INDEX bank_lines_hash_idx ON bank_lines (company_id, hash);

CREATE TABLE payment_batches (
    company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    id            text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$'),
    name          text NOT NULL,
    currency      char(3) NOT NULL,
    value_date    date NOT NULL,
    account       text NOT NULL DEFAULT '',
    status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','approved','released','rejected')),
    lines         jsonb NOT NULL,
    total         numeric(20,2) NOT NULL,
    created_by    uuid NOT NULL REFERENCES users(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    submitted_at  timestamptz,
    decided_by    uuid REFERENCES users(id),
    decided_at    timestamptz,
    released_by   uuid REFERENCES users(id),
    released_at   timestamptz,
    PRIMARY KEY (company_id, id)
);
