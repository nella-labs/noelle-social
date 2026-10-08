# Security

Report vulnerabilities privately before sharing reproduction details in an issue or pull request.

Use [GitHub's private vulnerability reporting form](https://github.com/nella-labs/noelle-social/security/advisories/new) when it is available. If the form is unavailable, open an issue requesting a private security contact without including the exploit, credentials or account data.

Include the affected version or commit, installation mode, minimal reproduction, expected boundary and observed result. Use a test account and redact secrets. Do not access another person's account or data to demonstrate a report.

## Installation boundaries

Local operator authentication trusts the configured installation. Keep that mode on a private host or network. An organization selector is not a substitute for authentication. Hosted multi user access needs verified sessions and organization membership checks.

Provider keys, session cookies, signing keys, database credentials, backups and runtime state belong outside the repository. Use environment variables or the installation's secret store. Never paste them into issue bodies, screenshots or logs.

Social publishing and messaging use the configured account. Enable publication deliberately, keep budgets and sender gates configured, and read delivery receipts before treating an action as complete.

If a credential becomes exposed, revoke or rotate it first. Removing a file or comment does not invalidate copies. Contact the affected provider and review its access history.

Only the current development branch is maintained. Security fixes are published through reviewed changes and release notes; there is no separate long term support branch.
