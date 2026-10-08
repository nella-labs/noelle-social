/**
 * @noelle/ui — package entry
 *
 * Currently only re-exports design tokens. Components will live under
 * `./components/*` once apps/app installs shadcn/ui and lucide-react.
 *
 * Also exports a deliberately tiny `cn` helper so consumers can start using
 * it today without a clsx/tailwind-merge dependency. Once apps/app pulls in
 * shadcn, swap this implementation to `clsx(...args)` + `twMerge(...)`.
 */

export * from './tokens';
export { default as tokens } from './tokens';

/**
 * Tiny classname joiner. Accepts strings, undefined, false, null, and
 * record-style `{ 'class': boolean }` maps. NOT a tailwind-merge replacement
 * — last-wins conflict resolution is the consumer's responsibility until we
 * swap this for `clsx` + `tailwind-merge`.
 */
export type ClassValue =
  | string
  | number
  | null
  | false
  | undefined
  | Record<string, unknown>
  | ClassValue[];

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  const walk = (value: ClassValue): void => {
    if (!value) return;
    if (typeof value === 'string' || typeof value === 'number') {
      out.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    if (typeof value === 'object') {
      for (const [key, enabled] of Object.entries(value)) {
        if (enabled) out.push(key);
      }
    }
  };
  for (const input of inputs) walk(input);
  return out.join(' ');
}
