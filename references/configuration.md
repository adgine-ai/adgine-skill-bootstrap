# Bootstrap configuration

## Personal installation versus host management

The generated `bootstrap-profile.json` declares `skill_lifecycle_mode: bootstrap`.
Old valid profiles without this optional field are still personal installations.
Users do not need to set a lifecycle environment variable or edit the profile.
Trusted host context / `ADGINE_SKILL_LIFECYCLE_MODE=host-managed` takes precedence;
`ADGINE_CREDENTIAL_MODE=request` also blocks personal lifecycle operations, even
if a personal Bootstrap is present. In those environments, use the host's catalog
sync and sender identity resolution, never Bootstrap login or synchronization.
These commands return `host_managed_lifecycle` before loading personal settings.
An unrecognized lifecycle variable returns `invalid_lifecycle_mode` instead of guessing.

The remaining instructions apply only to personal installations.

The only user credential is an `adg_sk_live_*` Key. Use the Agent's secure secret
configuration through `ADGINE_API_KEY`, or the private standard-input login below
if environment injection is unavailable. Never supply the Key in ordinary chat.
Legacy `geo_sk_live_*`, `abi_*`, and POC `agk_*` Keys are not accepted by Bootstrap.

This generated Bootstrap package is locked to:

- Channel: `production`
- Environment: `production`
- Access Center: `https://access-center.adgine.ai`
- Skill directory: the parent directory of the installed Bootstrap Skill
- Host: `universal`

Do not edit `bootstrap-profile.json` or use one environment's API Key with another environment's Bootstrap. The authenticated Manifest must report the same environment as the package before any Skill is installed.

Run synchronization directly:

```bash
node scripts/skillctl.mjs sync
```

Requests to check, synchronize, update, or refresh Adgine Skills all run this same command and apply the server Manifest. An empty Manifest is a normal authorization result: every managed child Skill is removed from the local Skill directory and lock file.

The server returns a v2 personalized Manifest. `permission_revision` changes when the Key's effective permissions change, `catalog_revision` changes when active Skill releases change, and `manifest_etag` identifies permissions, Catalog, runtime endpoints and host. A successful synchronization writes the verified runtime settings to `.adgine-runtime.json` in the managed Skills directory.

Child Skills run the cached preflight command before doing their work:

```bash
node scripts/skillctl.mjs preflight
```

`preflight` contacts the Access Center only when at least 10 minutes have elapsed since the last successful Manifest check. Explicit synchronization always contacts the server. A permission response with error code `skill_forbidden` or `capability_forbidden` requires one immediate recovery synchronization:

```bash
node scripts/skillctl.mjs permission-denied skill_forbidden
```

This command does not retry the denied API operation. Other 401/403 errors must not be converted into a Skill synchronization without a recognized error code.

Bootstrap update checks follow this package's own test or production channel. The China mirror is checked first and GitHub remains the permanent fallback. Checks are advisory, cached, and never block Skill synchronization:

```bash
node scripts/check_version.mjs --human
```

Package downloads are available from both routes:

- China mirror: `https://download.adgine.cn/adgine/bootstrap/production/latest/adgine-skill-bootstrap.zip`
- GitHub fallback: `https://github.com/adgine-ai/adgine-skill-bootstrap/releases/latest`

If the current Agent cannot inject a secret environment variable, store the Key locally without putting it in command arguments:

```bash
node scripts/skillctl.mjs login
```

Enter the Key through standard input when requested by the surrounding host. The credential file is written with user-only permissions. `skillctl` output never includes the Key.

Use `node scripts/skillctl.mjs doctor` only to diagnose a failed synchronization.

`GEO_API_BASE_URL` remains available only as an explicit developer override. Normal managed installations obtain the GEO API URL from the authenticated Manifest and fail closed if the runtime file is missing.
