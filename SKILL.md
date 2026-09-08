---
name: adgine-skill-bootstrap
description: Check, synchronize, update, or refresh the Adgine Skills authorized by the user's API Key in the current Agent, including requests such as 检查、同步、更新或刷新 Adgine Skills.
---

# Adgine Skill Bootstrap

Use the bundled `scripts/skillctl.mjs` when the user asks to install, check, synchronize, update, refresh, inspect, or disable Adgine Skills.

Treat `检查 Adgine Skills 更新`, `同步 Adgine Skills`, `更新 Adgine Skills`, `刷新 Adgine Skills`, and semantically equivalent requests as instructions to run `sync` immediately. A check is not manifest-only: it applies the current authorized state.

## Safety and credentials

- Never ask the user to paste an API Key into ordinary conversation text.
- Never place an API Key in a command-line argument, log, report, or lock file.
- Use the host's secret environment injection through `ADGINE_API_KEY`.
- If secret injection is unavailable, use `skillctl login` with the Key supplied on standard input; it stores the credential in a user-only file.
- Only manage Skill directories recorded in the Adgine lock file. Do not alter unrelated Skills.
- The server Manifest is authoritative. An empty `skills` list is valid and means all managed child Skills must be removed.
- Never restore, enable, or retain a managed child Skill that is absent from the latest Manifest. Authorization must be restored on the server before it can be installed again.

## Workflow

1. Run `node <skill-directory>/scripts/skillctl.mjs sync` directly.
2. Report which Skills were installed, upgraded, unchanged, or removed.
3. Tell the user to refresh or restart the current Agent only if synchronized Skills are not immediately visible.

The Access Center URL and universal host selector are built in. The target directory is automatically derived from the Bootstrap Skill's own installation directory. Do not ask the user to configure any of them. If synchronization reports that no API Key is configured, ask the user to set only `ADGINE_API_KEY` in the current Agent's secret/environment settings. Do not assume or name a specific Agent product. Run `doctor` and read `references/configuration.md` only when synchronization fails and troubleshooting is needed.
