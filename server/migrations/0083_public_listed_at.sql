-- Public by default (Bryan, 12 Nov 2026). Until now a "public" deck was on its owner's profile
-- and nowhere else, and the privacy page said shared pages are not indexed. From now on a public
-- deck is also listed: in Browse, on its commander's and precon's pages, in the sitemap, and
-- open to search engines. People who made decks public under the old meaning keep it until they
-- say yes to the new one, so the account records when it took the new meaning on:
--   NULL      the old meaning: public decks are on the profile only and stay noindex
--   a UTC timestamp   the account was made after the change, or its owner answered the prompt
-- Every account that exists when this runs starts NULL.
ALTER TABLE users ADD COLUMN public_listed_at TEXT;
