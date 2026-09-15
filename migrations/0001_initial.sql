PRAGMA foreign_keys=ON;
CREATE TABLE inboxes (
 address TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at INTEGER NOT NULL,
 expires_at INTEGER, retention_seconds INTEGER NOT NULL CHECK(retention_seconds BETWEEN 3600 AND 604800),
 message_count INTEGER NOT NULL DEFAULT 0, stored_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX inbox_expiry ON inboxes(expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE messages (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 inbox TEXT NOT NULL REFERENCES inboxes(address) ON DELETE CASCADE,
 envelope_from TEXT NOT NULL, sender TEXT NOT NULL, subject TEXT NOT NULL,
 received_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 text TEXT NOT NULL, candidates TEXT NOT NULL, truncated INTEGER NOT NULL,
 attachments_removed INTEGER NOT NULL, stored_bytes INTEGER NOT NULL,
 fingerprint TEXT NOT NULL, UNIQUE(inbox,fingerprint)
);
CREATE INDEX messages_inbox_seq ON messages(inbox,seq);
CREATE INDEX messages_expiry ON messages(expires_at);
CREATE INDEX messages_sender_seq ON messages(inbox,sender,seq);
CREATE INDEX messages_arrival ON messages(inbox,received_at,seq);
CREATE TABLE nonces (owner TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(owner,nonce));
CREATE INDEX nonce_expiry ON nonces(expires_at);
CREATE TABLE limits (key TEXT PRIMARY KEY, value INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX limits_expiry ON limits(expires_at);
CREATE TABLE usage (id INTEGER PRIMARY KEY CHECK(id=1), inboxes INTEGER NOT NULL DEFAULT 0, messages INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0);
INSERT INTO usage(id) VALUES(1);
CREATE TRIGGER inbox_capacity BEFORE INSERT ON inboxes BEGIN
 SELECT CASE WHEN (SELECT inboxes FROM usage WHERE id=1)>=1000 THEN RAISE(ABORT,'inbox_capacity') END;
END;
CREATE TRIGGER inbox_added AFTER INSERT ON inboxes BEGIN UPDATE usage SET inboxes=inboxes+1 WHERE id=1; END;
CREATE TRIGGER inbox_removed AFTER DELETE ON inboxes BEGIN UPDATE usage SET inboxes=inboxes-1 WHERE id=1; END;
CREATE TRIGGER message_capacity BEFORE INSERT ON messages BEGIN
 SELECT CASE WHEN (SELECT message_count FROM inboxes WHERE address=NEW.inbox)>=100 OR (SELECT stored_bytes FROM inboxes WHERE address=NEW.inbox)+NEW.stored_bytes>2097152 THEN RAISE(ABORT,'mailbox_capacity') END;
 SELECT CASE WHEN (SELECT messages FROM usage WHERE id=1)>=10000 OR (SELECT bytes FROM usage WHERE id=1)+NEW.stored_bytes>67108864 THEN RAISE(ABORT,'storage_capacity') END;
END;
CREATE TRIGGER message_added AFTER INSERT ON messages BEGIN
 UPDATE inboxes SET message_count=message_count+1,stored_bytes=stored_bytes+NEW.stored_bytes WHERE address=NEW.inbox;
 UPDATE usage SET messages=messages+1,bytes=bytes+NEW.stored_bytes WHERE id=1;
END;
CREATE TRIGGER message_removed AFTER DELETE ON messages BEGIN
 UPDATE inboxes SET message_count=message_count-1,stored_bytes=stored_bytes-OLD.stored_bytes WHERE address=OLD.inbox;
 UPDATE usage SET messages=messages-1,bytes=bytes-OLD.stored_bytes WHERE id=1;
END;
