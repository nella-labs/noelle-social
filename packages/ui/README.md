# @noelle/ui

Noelle's **Constellation** design system. Shared Tailwind preset, CSS
utilities, and design tokens for every Noelle frontend.

Consumed by:

- `apps/www` — marketing site (`trynoelle.com`, Astro)
- `apps/app` — dashboard (`app.trynoelle.com`, Next.js 15)

This package is **CSS + tokens first**. Components will land under
`src/components/` once `apps/app` finishes its shadcn/ui install.

---

## Palette (anchors)

| Token              | Hex       | Use                                  |
| ------------------ | --------- | ------------------------------------ |
| `cream-50`         | `#F5EFE6` | Lightest cream — cards on cream-100  |
| `cream-100`        | `#F2EDE0` | Default page background              |
| `rust-600`         | `#B5532A` | Primary clay accent / CTA            |
| `ink-900`          | `#13110C` | Body text on cream                   |

Full scales (50–900) live in `tailwind-preset.cjs` and mirrored in
`src/tokens.ts`. **Keep them in sync** — see "Extending tokens" below.

Typography: `Instrument Serif` (headings) · `Inter` (body) ·
`JetBrains Mono` (code). Loaded per-app; see `src/fonts.css`.

---

## Usage

### 1. Tailwind preset

```js
// apps/<app>/tailwind.config.cjs
const preset = require('@noelle/ui/tailwind-preset');

module.exports = {
  presets: [preset],
  content: ['./src/**/*.{astro,html,js,jsx,ts,tsx,md,mdx}'],
};
```

### 2. Global styles

```ts
// apps/app/app/layout.tsx (Next.js)
import '@noelle/ui/globals.css';
```

```astro
---
// apps/www/src/layouts/Base.astro (Astro)
import '@noelle/ui/globals.css';
---
```

### 3. Tokens in TS

```ts
import { tokens } from '@noelle/ui';
// or: import { color } from '@noelle/ui/tokens';

const cta = tokens.color.rust[600]; // '#B5532A'
```

### 4. `cn()` helper

```ts
import { cn } from '@noelle/ui';

<button className={cn('btn', isActive && 'btn--active', extraClass)} />
```

> The current `cn` is a zero-dep stub. It will be replaced by
> `clsx` + `tailwind-merge` once `apps/app` adds shadcn/ui. The signature
> won't change.

---

## Utility classes

Defined in `src/globals.css`:

| Class                  | What it does                                                       |
| ---------------------- | ------------------------------------------------------------------ |
| `.clay-glow`           | Faint warm radial glow — sit behind hero headings or CTAs.         |
| `.grain-overlay`       | Inline-SVG fractal-noise grain (multiply blend, ~35% opacity).     |
| `.grain-overlay-fixed` | Same, but `position: fixed; inset: 0` for full-page atmosphere.    |
| `.scanlines`           | CRT-style horizontal scanlines via repeating-linear-gradient.      |

All decorative utilities respect `prefers-contrast: more` (hidden) and
`prefers-reduced-motion: reduce` (animation suppressed).

Tailwind extras shipped by the preset:

- `shadow-clay`, `shadow-clay-lg`, `shadow-glow-rust`
- `animate-grain-shift`, `animate-orbit-spin`, `animate-orbit-spin-reverse`
- `font-serif` / `font-sans` / `font-mono` mapped to the three families

---

## Extending tokens

Tokens live in **two** places that MUST stay in sync:

1. `tailwind-preset.cjs` — drives CSS / Tailwind class generation.
2. `src/tokens.ts` — drives TS / runtime token access.

When adding a new shade or family:

1. Add it to the `theme.extend.colors` block in `tailwind-preset.cjs`.
2. Add the matching entry to `src/tokens.ts`.
3. If it also needs to be a CSS variable (shadcn theming), add the
   `--color-<name>-<shade>` declaration to `src/globals.css`.

CI should grow a check that diffs these three files. Until then: human
discipline.

---

## Versioning

`0.0.0`, private. We don't publish to npm — consumers depend on
`workspace:*`.
