---
name: adgine-skill-bootstrap
description: Check, synchronize, update, or refresh the Adgine Skills authorized by the user's API Key, and detect Bootstrap updates in the current Agent, including requests such as 检查、同步、更新或刷新 Adgine Skills.
---

# Adgine Skill Bootstrap

Use the bundled `scripts/skillctl.mjs` when the user asks to install, check, synchronize, update, refresh, inspect, or disable Adgine Skills.

Treat `检查 Adgine Skills 更新`, `同步 Adgine Skills`, `更新 Adgine Skills`, `刷新 Adgine Skills`, and semantically equivalent requests as instructions to run `sync` immediately. A check is not manifest-only: it applies the current authorized state.

## Bootstrap version check

Before a Bootstrap workflow, run `node <skill-directory>/scripts/check_version.mjs --human`. A failure or empty output must not block synchronization. If it prints an update message, finish the current operation and include that message once at the end of the user response.

The same update state may appear as `bootstrap_update` in `skillctl` output. Surface its `message` once; do not claim that an installation completed. When the user explicitly asks to update a git installation, obtain and run the `update_command` from `check-update`. Package installations require the user to download the GitHub Release ZIP and reinstall it through the current Agent. Do not name or assume a specific Agent product.

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

The release channel, Access Center URL and universal host selector are built in. The target directory is automatically derived from the Bootstrap Skill's own installation directory. Do not ask the user to configure any of them. `GEO_API_BASE_URL` is a developer-only override, not an installation setting. If synchronization reports that no API Key is configured, ask the user to set only `ADGINE_API_KEY` in the current Agent's secret/environment settings. Do not assume or name a specific Agent product. Run `doctor` and read `references/configuration.md` only when synchronization fails and troubleshooting is needed.
