ALTER TABLE users ADD COLUMN username text;
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD CONSTRAINT username_format CHECK (username ~ '^[a-z][a-z0-9_]{2,29}$');
CREATE UNIQUE INDEX users_username_unique ON users(username);
