// US QWERTY key metadata for synthesizing realistic keystrokes over CDP.
//
// A bare Input.dispatchKeyEvent({ type: "keyDown", text: ch }) types the
// character but emits keydown/keyup with keyCode=0, code="", key="Unidentified",
// a shape no physical keyboard produces and a deterministic automation tell on
// LinkedIn/X, which both collect client-side keystroke telemetry. keyStrokeFor()
// supplies the key/code/keyCode/shift metadata a real US keyboard reports for a
// character so the dispatched events look like hardware.

export interface KeyStroke {
  /** DOM code, e.g. "KeyA", "Digit1", "Comma". */
  code: string;
  /** Windows virtual key code, e.g. 65 for A. */
  keyCode: number;
  /** KeyboardEvent.key, the produced character. */
  key: string;
  /** The character without Shift (CDP unmodifiedText). */
  unmodified: string;
  /** Whether Shift must be held to produce this character. */
  shift: boolean;
}

// [code, unshifted, shifted, keyCode]
const ROWS: ReadonlyArray<readonly [string, string, string, number]> = [
  ["Backquote", "`", "~", 192],
  ["Digit1", "1", "!", 49],
  ["Digit2", "2", "@", 50],
  ["Digit3", "3", "#", 51],
  ["Digit4", "4", "$", 52],
  ["Digit5", "5", "%", 53],
  ["Digit6", "6", "^", 54],
  ["Digit7", "7", "&", 55],
  ["Digit8", "8", "*", 56],
  ["Digit9", "9", "(", 57],
  ["Digit0", "0", ")", 48],
  ["Minus", "-", "_", 189],
  ["Equal", "=", "+", 187],
  ["BracketLeft", "[", "{", 219],
  ["BracketRight", "]", "}", 221],
  ["Backslash", "\\", "|", 220],
  ["Semicolon", ";", ":", 186],
  ["Quote", "'", '"', 222],
  ["Comma", ",", "<", 188],
  ["Period", ".", ">", 190],
  ["Slash", "/", "?", 191],
];

const CHAR_MAP = new Map<string, KeyStroke>();

for (const [code, un, sh, keyCode] of ROWS) {
  CHAR_MAP.set(un, { code, keyCode, key: un, unmodified: un, shift: false });
  CHAR_MAP.set(sh, { code, keyCode, key: sh, unmodified: un, shift: true });
}

// Letters: unshifted lowercase, shifted uppercase, keyCode = ASCII of uppercase.
for (let c = 0; c < 26; c++) {
  const lower = String.fromCharCode(97 + c);
  const upper = String.fromCharCode(65 + c);
  const code = `Key${upper}`;
  const keyCode = 65 + c;
  CHAR_MAP.set(lower, { code, keyCode, key: lower, unmodified: lower, shift: false });
  CHAR_MAP.set(upper, { code, keyCode, key: upper, unmodified: lower, shift: true });
}

CHAR_MAP.set(" ", { code: "Space", keyCode: 32, key: " ", unmodified: " ", shift: false });

/**
 * Metadata for a US-keyboard keystroke that produces `ch`, or undefined for
 * characters with no single-key US mapping (emoji, accented letters, newlines);
 * callers should insert those via Input.insertText rather than a synthetic key.
 */
export function keyStrokeFor(ch: string): KeyStroke | undefined {
  return CHAR_MAP.get(ch);
}
