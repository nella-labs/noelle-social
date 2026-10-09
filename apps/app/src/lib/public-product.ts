const SOURCE = "https://github.com/nella-labs/noelle-social";
const sourceFile = (path: string) => `${SOURCE}/blob/HEAD/${path}`;

export const PUBLIC_PRODUCT = {
  name: "Noelle",
  license: "MIT",
  description: "An open-source workspace for social engagement, content planning, audience relationships, and measured results.",
  source: SOURCE,
  site: "https://app.trynoelle.com",
  links: {
    selfHost: sourceFile("docs/self-host.md"),
    license: sourceFile("LICENSE"),
    documentation: `${SOURCE}/tree/HEAD/docs`,
  },
  guides: [
    { label: "Product guide", href: sourceFile("docs/product.md") },
    { label: "Technical description", href: sourceFile("docs/architecture.md") },
    { label: "Contribute", href: sourceFile("CONTRIBUTING.md") },
    { label: "Common questions", href: sourceFile("docs/faq.md") },
  ],
} as const;
