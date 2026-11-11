# Security

Yama is a one-person project that holds real people's decks, collections and game history.
If you find a way to read or change someone else's data, sign in as someone else, or reach
anything on the server that should be private, please report it privately.

## Reporting a vulnerability

Use GitHub's private reporting:
**[Report a vulnerability](https://github.com/bryanroscoe/yama/security/advisories/new)**.
Only the maintainer sees the report.

Please do not open a public issue or pull request for a vulnerability.

Include what you found, where (a URL, route or file), and the steps to reproduce it. A proof of
concept against your own account is ideal.

## What is in scope

- The site and API at `yama.ing`, including the MCP endpoint and its OAuth server.
- The shared table relay at `relay.yama.ing`.
- The code in this repository.

Rules engine bugs (a card that plays wrongly) are not security issues; they belong in the
[yama-phase](https://github.com/bryanroscoe/yama-phase) repository's issues.

## While testing

- Use your own account and your own data. Do not read, change or delete anyone else's.
- Do not run load, flooding or denial-of-service tests against the site or the relay. Both run
  on small, free allowances.
- Do not use social engineering against other people who use Yama.

## What to expect

Reports are read by one person, as time allows. There is no bug bounty.
