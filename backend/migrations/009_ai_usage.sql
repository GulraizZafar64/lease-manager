-- Each AI request a company makes through the server: the model, its tokens and what it cost, so the company's
-- monthly allowance can be kept and the spending shown.
CREATE TABLE ai_usage (
    id                  bigserial PRIMARY KEY,
    company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id             uuid REFERENCES users(id) ON DELETE SET NULL,
    at                  timestamptz NOT NULL DEFAULT now(),
    tier                text NOT NULL,
    model               text NOT NULL,
    input_tokens        integer NOT NULL DEFAULT 0,
    output_tokens       integer NOT NULL DEFAULT 0,
    cache_read_tokens   integer NOT NULL DEFAULT 0,
    cache_write_tokens  integer NOT NULL DEFAULT 0,
    cost_usd            numeric(12, 6) NOT NULL
);
CREATE INDEX ai_usage_company_at_idx ON ai_usage (company_id, at DESC);
