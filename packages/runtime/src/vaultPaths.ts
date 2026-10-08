/** A tenant cloud prefix must be nonempty, relative and end at a directory boundary. */
export function assertSafeVaultPrefix(prefix: string): void {
  if (!prefix || prefix.startsWith("/") || prefix.includes("..") || prefix.includes("\0") || !prefix.endsWith("/") ||
      Buffer.byteLength(prefix) > 1024) throw new Error("unsafe vault prefix");
}

export function assertSafeVaultFilename(filename: string): void {
  if (!filename || filename.startsWith("/") || filename.includes("..") || filename.includes("\0") ||
      Buffer.byteLength(filename) > 1024) throw new Error("path traversal blocked");
}
