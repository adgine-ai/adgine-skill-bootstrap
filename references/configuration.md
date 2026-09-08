# Bootstrap configuration

The only user setting is `ADGINE_API_KEY`. Supply it through the current Agent's secret/environment configuration.

Bootstrap already uses:

- Access Center: `https://access-center.afrgame.dev:31000`
- Skill directory: the parent directory of the installed Bootstrap Skill
- Host: `universal`

Run synchronization directly:

```bash
node scripts/skillctl.mjs sync
```

Requests to check, synchronize, update, or refresh Adgine Skills all run this same command and apply the server Manifest. An empty Manifest is a normal authorization result: every managed child Skill is removed from the local Skill directory and lock file.

Child Skills run the cached preflight command before doing their work:

```bash
node scripts/skillctl.mjs preflight
```

`preflight` contacts the Access Center only when at least 10 minutes have elapsed since the last successful Manifest check. Explicit synchronization always contacts the server. A permission response with error code `skill_forbidden` or `capability_forbidden` requires one immediate recovery synchronization:

```bash
node scripts/skillctl.mjs permission-denied skill_forbidden
```

This command does not retry the denied API operation. Other 401/403 errors must not be converted into a Skill synchronization without a recognized error code.

Bootstrap update checks compare the installed `VERSION` with `adgine-ai/adgine-skill-bootstrap` on GitHub. They are advisory, cached, and never block Skill synchronization:

```bash
node scripts/check_version.mjs --human
```

If the current Agent cannot inject a secret environment variable, store the Key locally without putting it in command arguments:

```bash
node scripts/skillctl.mjs login
```

Enter the Key through standard input when requested by the surrounding host. The credential file is written with user-only permissions. `skillctl` output never includes the Key.

Use `node scripts/skillctl.mjs doctor` only to diagnose a failed synchronization.
