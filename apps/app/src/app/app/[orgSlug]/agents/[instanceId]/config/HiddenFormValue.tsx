"use client";

import { useEffect, useRef, type RefObject } from "react";

/** Keep controlled values in sync with the containing form's native reset. */
export function useFormReset(ref: RefObject<HTMLInputElement | null>, onReset?: () => void) {
  useEffect(() => {
    const form = ref.current?.form;
    if (!form || !onReset) return;
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [ref, onReset]);
}

/**
 * Hidden form field driven by React state from a custom control (preset
 * chips, +/- steppers, percent pickers).
 *
 * Native form elements (`<input>`, `<select>`) dispatch a bubbling `input`
 * event whenever their value changes, which is what the SaveBar listens for
 * to flip the form to "dirty". A React-controlled `<input type="hidden">`
 * updates its value silently — React sets the DOM property directly and no
 * event is dispatched — so a button that only calls `setState` would never
 * mark the form dirty and the Save bar would never appear (clicking the
 * "$100" budget preset did nothing, while typing into the native number
 * input worked).
 *
 * This component re-dispatches a bubbling `input` event whenever `value`
 * changes, so button-driven controls participate in dirty detection exactly
 * like native inputs. The initial mount is skipped so a freshly-rendered
 * form isn't reported dirty before the user touches anything.
 */
export function HiddenFormValue({
  name,
  value,
  onReset,
}: {
  name: string;
  value: string | number;
  onReset?: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const mounted = useRef(false);
  useFormReset(ref, onReset);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    // React has already committed the new value to the DOM before effects
    // run, so the bubbling event lets the SaveBar re-read fresh FormData.
    ref.current?.dispatchEvent(new Event("input", { bubbles: true }));
  }, [value]);

  return <input ref={ref} type="hidden" name={name} value={value} readOnly />;
}
