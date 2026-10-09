# Noelle

An open source workspace for social growth on X, LinkedIn, Reddit and video channels.

Find relevant conversations, draft replies and posts, review outreach, and measure recorded results. Noelle keeps content, contacts, platform profiles and spending in one dashboard.

## Start locally

Use Node 22, pnpm 10.28 and Docker, nerdctl or PostgreSQL 16.

```sh
git clone https://github.com/nella-labs/noelle-social.git
cd noelle-social
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@noelle/cli
node apps/cli/dist/index.js init --provider anthropic --email operator@example.com --org team
node apps/cli/dist/index.js up
```

Open [localhost:3001](http://127.0.0.1:3001). Supply your provider credentials through the environment before `init`. Worker processes and publication require separate configuration. See [self hosting](docs/self-host.md) for provider options, native PostgreSQL and platform setup.

## Explore

- [Product and supported workflows](docs/product.md)
- [Social growth guide](docs/social-growth.md)
- [Architecture](docs/architecture.md)
- [Developer setup and tests](docs/testing.md)
- [FAQ](docs/faq.md) and [roadmap](docs/roadmap.md)

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and [SECURITY.md](SECURITY.md) before reporting a vulnerability.

Licensed under [MIT](LICENSE). Provider usage and social account access are configured by each installation.
