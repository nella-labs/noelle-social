# Frequently asked questions

## Can I run Noelle locally?

Yes. The CLI manages the dashboard, API and local PostgreSQL. Worker processes are optional. Follow [self hosting](self-host.md).

## Do I need a cloud database?

A local installation uses its own PostgreSQL database and operator identity. Hosted installations can use configured remote database and session providers.

## Does installing Noelle send messages?

Fresh installations keep worker execution and publication separately configured. Review platform permissions and sender gates before enabling a sending lane. Existing installations retain their configured settings.

## Which platforms work?

The registry supports X, LinkedIn, Reddit and video profiles. Original post generation currently supports X and LinkedIn. Other capabilities depend on the enabled worker and platform integration. See [the product guide](product.md).

## Are model calls free?

Use your own provider credentials or a supported CLI provider session. Usage is subject to that provider's terms and charges. Noelle records calls and budget admission, including unresolved estimates.

## Can several people use the same installation?

The local operator mode uses one configured identity. Hosted session mode checks organization membership. Shared hosting and role behavior require their own session, membership and account setup; exposing a local operator endpoint does not add multi user authentication.

## Where is my data?

Content, contacts, approvals and recorded usage live in the configured database. Files and saved context use the installation's configured storage. External providers receive the inputs needed for the selected workflow.

## How do I contribute?

Open an issue or a focused pull request after reading [CONTRIBUTING.md](../CONTRIBUTING.md). The project uses [Apache 2.0](../LICENSE).
