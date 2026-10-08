---
name: adgine-skill-bootstrap
description: Install, check, synchronize, update, or refresh a personal Adgine Skill installation authorized by the user's API Key. Not for host-managed server inventories such as the Adgine AstrBot plugin.
---

# Adgine Skill Bootstrap

## Installation mode — check before any workflow

If trusted host context declares `host-managed`, or execution uses
`ADGINE_SKILL_LIFECYCLE_MODE=host-managed` / `ADGINE_CREDENTIAL_MODE=request`,
do not run this Skill's login, sync, preflight, version check or upgrade commands.
The host manages the server inventory; report credential failures as host identity
resolution problems. Never request a user's Key, persist a request credential, or
remove server Skills based on one user's Manifest.

Without a host declaration, a valid installed `bootstrap-profile.json` identifies
a personal installation. Its `skill_lifecycle_mode` is `bootstrap`; old valid
profiles without that field remain compatible. Users need not set a mode variable.
An invalid/missing profile is an installation error, not a reason to repeatedly
login/sync or guess the mode from the Agent's product name.

The following workflows apply only to that personal installation.

Use the bundled `scripts/skillctl.mjs` when the user asks to install, check, synchronize, update, refresh, inspect, or disable Adgine Skills.

Treat `检查 Adgine Skills 更新`, `同步 Adgine Skills`, `更新 Adgine Skills`, `刷新 Adgine Skills`, and semantically equivalent requests as instructions to run `sync` immediately. A check is not manifest-only: it applies the current authorized state.

## Bootstrap version check

Before a Bootstrap workflow, run `node <skill-directory>/scripts/check_version.mjs --human`. A failure or empty output must not block synchronization. If it prints an update message, finish the current operation and include that message once at the end of the user response.

The same update state may appear as `bootstrap_update` in `skillctl` output. Surface its `message` once; do not claim that an installation completed. When the user explicitly asks to update a git installation, obtain and run the `update_command` from `check-update`. Package installations require the user to download the release ZIP from the reported China mirror or permanent GitHub fallback and reinstall it through the current Agent. Do not name or assume a specific Agent product.

## Safety and credentials

- The installed `bootstrap-profile.json` fixes this package to one release channel and Access Center. Never change or override that environment on the user's behalf.
- Require the authenticated Manifest environment to match the installed Bootstrap profile. A mismatch is a hard failure; never try another environment automatically.
- Never ask the user to paste an API Key into ordinary conversation text.
- Accept only the new `adg_sk_live_*` Key format. Legacy `geo_sk_live_*` and `abi_*` Keys continue through their existing product flows, and POC `agk_*` Keys are unsupported.
- Never place an API Key in a command-line argument, log, report, or lock file.
- Use the host's secret environment injection through `ADGINE_API_KEY`.
- If secret injection is unavailable, use `skillctl login` with the Key supplied on standard input; it stores the credential in a user-only file.
- Only manage Skill directories recorded in the Adgine lock file. Do not alter unrelated Skills.
- The server Manifest is authoritative. An empty `skills` list is valid and means all managed child Skills must be removed.
- Treat the v2 Manifest's `permission_revision`, `catalog_revision`, and `manifest_etag` as server-owned synchronization identity; never synthesize or edit them locally.
- Treat the Manifest's runtime service endpoints as server-owned configuration. Successful synchronization writes them to the managed Skills directory for child Skills; never invent or substitute service URLs.
- Never restore, enable, or retain a managed child Skill that is absent from the latest Manifest. Authorization must be restored on the server before it can be installed again.

## Workflow

1. Run `node <skill-directory>/scripts/skillctl.mjs sync` directly.
2. Report the verified channel, environment and service endpoints, then which Skills were installed, upgraded, unchanged, or removed.
3. Tell the user to refresh or restart the current Agent only if synchronized Skills are not immediately visible.

`sync` is always a forced check. Child Skills use `preflight`, which accesses the Access Center only when the last successful Manifest check is at least 10 minutes old. If an Adgine API returns `skill_forbidden` or `capability_forbidden`, run `permission-denied <error-code>` once immediately, bypassing the 10-minute interval. Stop the denied operation, do not retry it automatically, and report `user_message` plus the resulting authorization change. An invalid or revoked Key requires Key remediation instead of repeated synchronization.

The release channel, Access Center URL and universal host selector are built in. The target directory is automatically derived from the Bootstrap Skill's own installation directory. Do not ask the user to configure any of them. `GEO_API_BASE_URL` is a developer-only override, not an installation setting. If synchronization reports no API Key, use the Agent's secure secret settings when available; otherwise use `skillctl login` through a private standard-input channel. Never ask for a Key in ordinary chat or as a command argument. If the host offers neither secure input method, stop and explain that limitation. Run `doctor` and read `references/configuration.md` only when personal synchronization fails.
