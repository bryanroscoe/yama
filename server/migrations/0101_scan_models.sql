-- The scanner's model choices (docs/scanner.md, "Models you can switch"; Bryan, 20 Nov 2026):
-- each kept scan photo and diagnostic names the option each slot ran, as JSON
-- ({"art": "yama-art-20261118", "look": "off", "text": "auto", "lock": "lead"}). Null for older
-- rows and web builds from before this; `bundle` still names the art model by its file.
ALTER TABLE scan_samples ADD COLUMN models TEXT;
ALTER TABLE scan_diagnostics ADD COLUMN models TEXT;
