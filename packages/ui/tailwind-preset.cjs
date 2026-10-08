/**
 * @noelle/ui — Tailwind v3 preset
 *
 * Constellation design system. Cream + warm clay (rust), Instrument Serif
 * headings, Inter body, JetBrains Mono code.
 *
 * Usage in a consumer (apps/www, apps/app):
 *   // tailwind.config.cjs
 *   const preset = require('@noelle/ui/tailwind-preset');
 *   module.exports = {
 *     presets: [preset],
 *     content: ['./src/**\/*.{astro,html,js,jsx,ts,tsx,md,mdx}'],
 *   };
 *
 * IMPORTANT: keep palette values in sync with `src/tokens.ts`. Both are the
 * source of truth (CSS via preset, TS via tokens).
 */

/** @type {import('tailwindcss').Config} */
module.exports = {
  // Consumers MUST set their own `content` array. We leave it empty so that
  // the preset is a pure theme layer and JIT scans only the consumer's
  // source files.
  content: [],
  theme: {
    extend: {
      colors: {
        // Cream — page background family. Anchor 50 = #F5EFE6.
        cream: {
          50: '#F5EFE6',
          100: '#F2EDE0',
          200: '#EFE7D2',
          300: '#E6DECB',
          400: '#D9CDB1',
          500: '#C9B98F',
          600: '#A89868',
          700: '#7C6F4B',
          800: '#4F4632',
          900: '#2A2519',
        },
        // Rust — clay accent. Anchor 600 = #B5532A (close cousin of the
        // marketing site's #B04A3A; slightly warmer + more saturated for
        // dashboard UI where it competes against more chrome).
        rust: {
          50: '#FBF1EB',
          100: '#F4DDCB',
          200: '#E8B89A',
          300: '#DC9269',
          400: '#CC6E3E',
          500: '#BD5C30',
          600: '#B5532A',
          700: '#964322',
          800: '#71321A',
          900: '#4A2011',
        },
        // Ink — text + dark surfaces. Anchor 900 ~ #131110 (matches the
        // marketing site's #13110C).
        ink: {
          50: '#F4F2EE',
          100: '#E0DCD3',
          200: '#BBB4A4',
          300: '#948B78',
          400: '#6E6552',
          500: '#4D4636',
          600: '#3A352B',
          700: '#272420',
          800: '#1A1816',
          900: '#13110C',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        serif: ['"Instrument Serif"', 'Georgia', 'ui-serif', 'serif'],
        mono: [
          '"JetBrains Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
      },
      borderRadius: {
        // shadcn-compatible scale, driven by --radius.
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      boxShadow: {
        // Soft clay-ish shadows. Slight warm tint so they sit on cream
        // without looking like a generic gray drop.
        clay: '0 1px 2px rgba(74, 32, 17, 0.06), 0 2px 6px rgba(74, 32, 17, 0.05)',
        'clay-lg':
          '0 4px 10px rgba(74, 32, 17, 0.08), 0 12px 28px rgba(74, 32, 17, 0.10)',
        'glow-rust':
          '0 0 0 1px rgba(181, 83, 42, 0.35), 0 8px 24px rgba(181, 83, 42, 0.25)',
      },
      keyframes: {
        'grain-shift': {
          '0%, 100%': { transform: 'translate(0, 0)' },
          '10%': { transform: 'translate(-2%, -3%)' },
          '20%': { transform: 'translate(-4%, 2%)' },
          '30%': { transform: 'translate(2%, -4%)' },
          '40%': { transform: 'translate(-2%, 5%)' },
          '50%': { transform: 'translate(-4%, 2%)' },
          '60%': { transform: 'translate(3%, 0%)' },
          '70%': { transform: 'translate(0%, 3%)' },
          '80%': { transform: 'translate(-3%, 1%)' },
          '90%': { transform: 'translate(2%, 4%)' },
        },
        'orbit-spin': {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
      },
      animation: {
        'grain-shift': 'grain-shift 8s steps(10) infinite',
        'orbit-spin': 'orbit-spin 120s linear infinite',
        'orbit-spin-reverse': 'orbit-spin 180s linear infinite reverse',
      },
    },
  },
  plugins: [],
};
