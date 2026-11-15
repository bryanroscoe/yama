-- Scan photos shared with Yama's developer (Bryan, 15 Nov 2026: "I want them to send it to me").
-- Save scan photos is on by default from this change, and the switch says plainly that saved
-- photos of the card are shared with Yama's developer to improve the scanner. A photo is shared
-- only when the scanner that saved it showed that text (it sends `shared: true`). Photos saved
-- before (the switch then promised they stayed in the account, shown to no one) stay 0 and are
-- never shown to an admin.
ALTER TABLE scan_samples ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
CREATE INDEX scan_samples_shared ON scan_samples (shared, created_at);
