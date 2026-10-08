/**
 * @noelle/ui — design tokens (TS mirror of tailwind-preset.cjs)
 *
 * Keep these values in sync with `../tailwind-preset.cjs`. CSS goes through
 * the Tailwind preset; TS / runtime code goes through this module.
 *
 * Anchors:
 *   color.cream[50]  = #F5EFE6  (page background)
 *   color.rust[600]  = #B5532A  (primary clay accent)
 *   color.ink[900]   = #13110C  (text on cream)
 */

export const color = {
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
} as const;

export const font = {
  sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
  serif: ['"Instrument Serif"', 'Georgia', 'ui-serif', 'serif'],
  mono: [
    '"JetBrains Mono"',
    'ui-monospace',
    'SFMono-Regular',
    'Menlo',
    'monospace',
  ],
} as const;

export const radius = {
  sm: '0.25rem',
  md: '0.375rem',
  lg: '0.5rem',
} as const;

export const shadow = {
  clay:
    '0 1px 2px rgba(74, 32, 17, 0.06), 0 2px 6px rgba(74, 32, 17, 0.05)',
  clayLg:
    '0 4px 10px rgba(74, 32, 17, 0.08), 0 12px 28px rgba(74, 32, 17, 0.10)',
  glowRust:
    '0 0 0 1px rgba(181, 83, 42, 0.35), 0 8px 24px rgba(181, 83, 42, 0.25)',
} as const;

export const tokens = {
  color,
  font,
  radius,
  shadow,
} as const;

export type Tokens = typeof tokens;
export default tokens;
