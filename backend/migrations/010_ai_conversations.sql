-- The AI advisor's conversations, kept for the person who had them (no one else in the company sees them).
-- context says what the conversation was about: 'portfolio', 'lease:<id>' or 'doc:<contract name>'.
CREATE TABLE ai_conversations (
    company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id             text NOT NULL,
    title          text NOT NULL,
    context        text NOT NULL DEFAULT 'portfolio',
    context_label  text NOT NULL DEFAULT '',
    turns          jsonb NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, user_id, id)
);
CREATE INDEX ai_conversations_recent_idx ON ai_conversations (company_id, user_id, updated_at DESC);
