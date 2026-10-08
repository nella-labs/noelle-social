# Credential provisioning helpers

These optional helpers support GCP Secret Manager installations. Native installations can keep provider credentials in their private runtime environment. See [the secrets guide](../../docs/secrets.md).

`wire-pushover-keys.sh` reads `PUSHOVER_USER_KEY` and `PUSHOVER_APP_TOKEN` from macOS Keychain and writes new Secret Manager versions. Configure the target project explicitly. The default Keychain service is `nervous-system`; `NOELLE_KEYCHAIN_SERVICE` selects another service.

```sh
./infra/secrets/wire-pushover-keys.sh --project <project-id> --org-id <workspace-uuid>
```

The helper writes the notifier's installation-wide fallback names and, when supplied, per-organization names. Use per-organization entries for tenant-owned notifications. Secret values pass through stdin and stay out of argv, logs and repository files.

The command requires authenticated GCP access and permission to manage the selected secrets. It changes external state. Do not run it as a connection test or copy another installation's credentials.
