---
name: yama-setup
description: Connect the Yama plugin to a Yama account and verify access to private Commander decks and plans. Use for first-time setup, missing Yama tools, expired sign-in, or reconnecting the plugin.
---

# Connect Yama

Yama is a free Magic: The Gathering Commander app at https://yama.ing. It uses
Google sign-in. Its hosted MCP endpoint is https://yama.ing/mcp.

1. Discover the Yama tools available in this conversation. Reuse an existing
   authenticated Yama connection; avoid creating a duplicate connection.
2. If sign-in is needed, use the host's Yama plugin Connect or authentication
   action. Have the person sign in to Yama and approve the connection in the
   provider page. Never request a password or token in chat, read credential
   files, or put credentials in plugin files.
3. Once connected, call `overview` without arguments. Report whether it succeeded
   and the number of decks/plans found, without dumping their private contents.
   An empty account is a valid connection, not an authentication failure.
4. If the host cannot load newly installed tools in this conversation, tell the
   person to enable Yama in a new conversation and retry there. Installation and
   authentication are separate; do not claim success until a harmless read works.

If a token expires or a connection is revoked, use the supported reconnect flow.
Connection and revocation instructions are at https://yama.ing/docs/mcp/.

After setup, offer deck review, collection-aware upgrades, or saved research.
Setup never stages or applies changes. Keep decks, inventory, purchases, prints,
installation, sharing and games unchanged unless the person requests the action.

Yama is unofficial fan software, not affiliated with or endorsed by Wizards of
the Coast. Card images load from Scryfall at runtime; no card art is in this plugin.
