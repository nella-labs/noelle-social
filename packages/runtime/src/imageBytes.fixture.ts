const png = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64",
));
const gif = Uint8Array.from(Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64",
));

/** Encoded one-pixel PNG, optionally padded to exercise a request byte bound. */
export function pngImageBytes(byteLength = png.length): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(byteLength);
  bytes.set(png.subarray(0, byteLength));
  return bytes;
}

export function gifImageBytes(): Uint8Array<ArrayBuffer> { return new Uint8Array(gif); }
