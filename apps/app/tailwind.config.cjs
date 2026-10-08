/** Dashboard utilities resolve through the same tokens as shared controls. */
const preset = require("@noelle/ui/tailwind-preset");

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [preset],
  content: ["./src/**/*.{ts,tsx,js,jsx,mdx}"],
  theme: {
    extend: {
      colors: {
        cream: { 50: "var(--paper)", 100: "var(--paper)", 200: "var(--paper-2)", 300: "var(--paper-deep)", 400: "var(--rule)", 500: "var(--ink-soft)" },
        rust: { 50: "var(--accent-soft)", 100: "var(--accent-soft)", 200: "var(--accent-soft)", 300: "var(--accent)", 400: "var(--accent)", 500: "var(--accent)", 600: "var(--accent-deep)", 700: "var(--accent-deep)" },
        ink: { 100: "var(--rule-soft)", 200: "var(--rule)", 300: "var(--ink-soft)", 400: "var(--ink-muted)", 500: "var(--ink-muted)", 600: "var(--ink-2)", 700: "var(--ink-2)", 800: "var(--ink)", 900: "var(--ink)" },
        mist: { 200: "var(--rule-soft)", 300: "var(--rule)", 500: "var(--ink-muted)" },
      },
      fontFamily: { serif: ["var(--display)"], mono: ["var(--mono)"], sans: ["var(--body)"] },
      boxShadow: { clay: "var(--surface-shadow)", "clay-lg": "var(--surface-shadow)" },
    },
  },
};
