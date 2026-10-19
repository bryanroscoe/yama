-- Local accounts: a password set from the command line (`yama-server user add`), for local
-- debugging, extra test players, or signing in when Google isn't available.
ALTER TABLE users ADD COLUMN password_hash TEXT;              -- argon2id PHC string; NULL = no password sign-in
-- Admin given from the command line. Admin also comes from YAMA_ADMIN_EMAILS, which is
-- re-applied at every Google or dev sign-in; this flag survives that.
ALTER TABLE users ADD COLUMN admin_granted INTEGER NOT NULL DEFAULT 0;
