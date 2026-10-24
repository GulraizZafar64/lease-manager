-- Who approved or rejected a lease change (the approvals table holds each approval; this is the final decision).
ALTER TABLE lease_events ADD COLUMN decided_by uuid REFERENCES users(id);
