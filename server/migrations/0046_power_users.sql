-- Power users (2026-10-31): accounts an admin trusts with the heavy and AI features (starting
-- simulations, watched AI games and Ask Claude). Admins always count as power users. No one is
-- granted by this migration; admins grant it in Admin, People.
ALTER TABLE users ADD COLUMN power_user INTEGER NOT NULL DEFAULT 0;
