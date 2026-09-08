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

If the current Agent cannot inject a secret environment variable, store the Key locally without putting it in command arguments:

```bash
node scripts/skillctl.mjs login
```

Enter the Key through standard input when requested by the surrounding host. The credential file is written with user-only permissions. `skillctl` output never includes the Key.

Use `node scripts/skillctl.mjs doctor` only to diagnose a failed synchronization.
