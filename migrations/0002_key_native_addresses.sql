ALTER TABLE inboxes ADD COLUMN configured INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inboxes ADD COLUMN last_activity INTEGER;

UPDATE inboxes
SET expires_at=NULL,
    configured=1,
    last_activity=created_at;

CREATE INDEX inbox_unconfigured_cleanup
ON inboxes(configured,last_activity)
WHERE configured=0 AND message_count=0;
