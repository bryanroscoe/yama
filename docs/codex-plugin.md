# Yama plugin for Codex and ChatGPT

The private plugin packages the existing OAuth MCP endpoint,
`https://yama.ing/mcp`, with setup, deck-building, collection-planning and
Commander-research skills. Source is in `plugins/yama/`. Hosting, Google login,
owner checks, staged execution writes and research-note storage remain in Yama.
The package contains Yama's approved two-peak artwork, instructions and connection metadata; no user
data, tokens, card art, rules documents or application source.

This is a private testing package, not a published directory listing. Yama's
repository remains private. Public submission and publication are separate work.

## Build and save a private plugin

From the repository root, choose an output path outside the plugin directory:

```sh
python3 scripts/test_package_yama_plugin.py
python3 scripts/package_yama_plugin.py /absolute/task-directory/yama-0.1.4.zip
```

The packager uses an explicit component allowlist, rejects symlinked sources,
does not overwrite an existing archive, and produces reproducible ZIP bytes.
When adding a component, add its path to `FILES` in the packager. Inspect the
final ZIP after every change. Increment `plugins/yama/plugin.json`'s semantic
version for subsequent releases.

Use Plugin Creator's `create_plugin` with the absolute archive path to save the
package privately to the active account/workspace. Record its returned plugin
URL, plugin ID and release ID in private task notes. Inspect the returned
component diagnostics and saved source. For a later release, use `update_plugin`
with that exact ID; do not create another plugin of the same name.

Open the returned plugin page, install/enable Yama, and use the host's Connect
action. Sign in to Yama with Google and approve the connection you started.
Enable Yama in a new conversation if the current conversation cannot load its
new tools. An upload is not proof of installation, authentication or tool access.

## Authentication

`mcp.json` declares only the Streamable HTTP transport and hosted endpoint.
OAuth discovery supplies dynamic client registration (DCR), the S256 PKCE flow
and `mcp offline_access` scopes. Never embed tokens or client secrets in the
package. Yama already advertises refresh rotation and issuer identification.

Codex 0.166.0's portable MCP parser rejects server fields other than the transport,
URL and headers. Although newer OpenAI documentation describes server auth
extensions, including those fields silently omits the server in this client.
Keep the server declaration minimal and let its normal 401/discovery flow drive
OAuth. The inline OpenAI presentation and onboarding metadata remain supported.
Verify actual plugin tool discovery, not just the four skills or an installed
badge; a separately configured direct MCP connection can mask this failure.

The default redirect-host allowlist includes `chatgpt.com`, `claude.ai` and
`claude.com`; native clients can use HTTP loopback callbacks. Registration still
rejects lookalike domains, other remote hosts, credentials and fragments;
authorization and code exchange still match the exact registered HTTPS URI.
`YAMA_OAUTH_REDIRECT_HOSTS`, when set, replaces those defaults, including when
empty. If production overrides it, preserve its current approved hosts and add
only the host required by the connection's actual callback.

OpenAI currently documents the stable callback as
`https://chatgpt.com/connector_platform_oauth_redirect` for authorization servers
that support issuer identification, with a connection-specific callback on
`chatgpt.com` otherwise. Copy the actual URI shown by the host's connection page;
do not guess one or allow arbitrary domains. This is Yama's MCP authorization
server configuration, not the Google OAuth client's JavaScript-origin list.

## Verify the experience

1. Install/enable the private plugin, sign in, and call `overview`. Check that the
   expected account is connected; do not paste private deck lists into logs.
   An existing standalone `mcp_servers.yama` declaration takes precedence over
   the plugin's same-named server, even if the standalone entry is disabled.
   Once the package is installed and its server declaration is discoverable,
   remove the redundant entry with `codex mcp remove yama`, then verify the
   runtime reports a plugin ID and `overview` still succeeds. This removes the
   configuration only; it does not revoke the account's connection. If the
   plugin cannot connect, restore the canonical standalone connection with
   `codex mcp add yama --url https://yama.ing/mcp` while investigating.
2. Ask for a deck review using owned cards. Confirm that the skills read current
   Yama state, validate cards/lists, and distinguish real copies, proxies and needs.
3. When the person requests saving a plan, save and read back a research note.
   Research refreshes can update a tracked plan's derived advice; they do not
   install cards, record purchases or save a playable deck.
4. Only on a requested specific edit, stage it, inspect its review link, and
   apply after explicit approval of that exact change. Do not mutate a live
   account merely to smoke-test the plugin. Integration tests cover applying,
   stale writes, account isolation and token refresh/revocation locally.
5. Check reconnect after expiry/revocation using supported host actions. Report
   package creation, server tests and actual host behavior as separate evidence.

Removing the plugin and revoking its Yama connection are separate actions.
Connections can be revoked under Decks, Plans, Settings, Connected apps.
Existing direct MCP clients continue to use the [MCP guide](https://yama.ing/docs/mcp/).

Packaging follows the [OpenAI plugin guide](https://developers.openai.com/plugins/build/plugins)
and [OAuth guidance](https://developers.openai.com/plugins/build/auth). A future
public release additionally needs the listing, publisher verification, review
materials and submission described in the
[publication guide](https://developers.openai.com/plugins/deploy/submission).

## Branding

The listing logo and composer icon are unmodified copies of
`design/logo/yama-logo-512.png` and `yama-logo-120.png`. Both have the existing
near-black ground, white near peak and grey far peak and remain legible on light
and dark host backgrounds. The manifest declares both theme variants explicitly
and uses the existing Night table colors. Each skill's `agents/openai.yaml`
references the same packaged assets and supplies a readable display name. No
card art, Wizards marks, new logo or generated branding is included.

Check the actual saved listing and skill icons after upload. Valid relative
paths and archived images establish package correctness; they do not prove the
web directory rendered the assets. Record any host rendering limitation honestly.
