"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./styles.module.css";

interface Props {
  orgId: string;
  orgSlug: string;
}

interface PickedFile {
  /** Path relative to the vault root, e.g. `content/voice-anchors/post.md`. */
  path: string;
  body: string;
  size: number;
}

// Match the route's per-file and per-request caps so the user sees a
// clean error in the picker rather than a 413 after upload.
const MAX_BYTES_PER_FILE = 512 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 100;

function isMarkdownName(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

/**
 * Normalize a path the browser gives us into something safe for the
 * vault prefix. Strips a leading folder name (browsers prefix
 * `webkitRelativePath` with the top-level folder, e.g. `Mars/posts/a.md`
 * — we want just `posts/a.md`), removes `./`, collapses `\` to `/`, and
 * trims leading slashes. The server still re-checks for traversal, but
 * sanitising here keeps the preview readable.
 */
function normalizePath(raw: string): string {
  let p = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  while (p.startsWith("/")) p = p.slice(1);
  const firstSlash = p.indexOf("/");
  if (firstSlash > 0) {
    // Strip the top-level folder so two users importing `Mars/` and
    // `my-vault/` both end up with the same internal layout.
    p = p.slice(firstSlash + 1);
  }
  return p;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function ImportStep({ orgId, orgSlug }: Props) {
  const router = useRouter();
  const folderInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const totalBytes = useMemo(
    () => picked.reduce((n, f) => n + f.size, 0),
    [picked],
  );

  const onFiles = useCallback(async (raw: FileList | null) => {
    setError(null);
    if (!raw || raw.length === 0) return;
    const list: PickedFile[] = [];
    let skipped = 0;
    let oversize = 0;
    for (const file of Array.from(raw)) {
      if (!isMarkdownName(file.name)) {
        skipped += 1;
        continue;
      }
      if (file.size > MAX_BYTES_PER_FILE) {
        oversize += 1;
        continue;
      }
      const relRaw =
        (file as unknown as { webkitRelativePath?: string }).webkitRelativePath ||
        file.name;
      const path = normalizePath(relRaw) || file.name;
      const body = await file.text();
      list.push({ path, body, size: file.size });
    }
    if (list.length === 0) {
      setError(
        skipped
          ? `No .md files in the selection (${skipped} non-markdown skipped).`
          : "No files picked.",
      );
      return;
    }
    if (oversize > 0) {
      setError(
        `${oversize} file(s) skipped — each markdown file must be under ${MAX_BYTES_PER_FILE / 1024} KiB.`,
      );
    }
    setPicked(list);
  }, []);

  async function onUpload() {
    if (picked.length === 0) return;
    if (totalBytes > MAX_TOTAL_BYTES * 4) {
      setError("Total payload too large. Try importing fewer files at a time.");
      return;
    }
    setError(null);
    setPending(true);
    setProgress({ done: 0, total: picked.length });

    // Batch by file count and by accumulated bytes so each request stays
    // under the route's per-request caps without round-tripping the user.
    const batches: PickedFile[][] = [];
    let buf: PickedFile[] = [];
    let bufBytes = 0;
    for (const f of picked) {
      if (
        buf.length >= MAX_FILES_PER_REQUEST ||
        bufBytes + f.size > MAX_TOTAL_BYTES
      ) {
        batches.push(buf);
        buf = [];
        bufBytes = 0;
      }
      buf.push(f);
      bufBytes += f.size;
    }
    if (buf.length) batches.push(buf);

    let done = 0;
    for (let i = 0; i < batches.length; i++) {
      const isLast = i === batches.length - 1;
      const res = await fetch("/api/vault/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId,
          orgSlug,
          files: batches[i],
          // Only mark the stage on the final batch so a partial failure
          // doesn't claim "wizard done" with half the content missing.
          markStage: isLast ? "light" : undefined,
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        setError(
          `Import failed at batch ${i + 1}/${batches.length}: ${detail.error ?? res.statusText}`,
        );
        setPending(false);
        return;
      }
      done += batches[i].length;
      setProgress({ done, total: picked.length });
    }

    setPending(false);
    // Refresh the layout so the soft banner clears, then send the user
    // onward into the rest of the wizard for the optional voice steps.
    router.refresh();
    router.push(`/app/${orgSlug}/onboarding/vault?step=medium`);
  }

  return (
    <div className={styles.form}>
      <p className={styles.hint}>
        Already have a markdown vault (Obsidian, Logseq, a folder of notes)?
        Drop the folder here. We&apos;ll write every <code>.md</code> file into
        your tenant&apos;s GCS prefix; Nella indexes them on its normal sync
        cadence so your agents start pulling real anchors. The voice steps
        afterwards are optional.
      </p>

      <div className={styles.field}>
        <span className={styles.label}>Import a folder</span>
        <span className={styles.hint}>
          Picks every <code>.md</code> file under the folder, preserving the
          relative path. The top-level folder name is stripped.
        </span>
        <input
          ref={folderInputRef}
          type="file"
          multiple
          // @ts-expect-error — `webkitdirectory` is non-standard but works in
          // every browser we ship to. React strips unknown attrs unless
          // we cast, so we let the typecheck slide here.
          webkitdirectory=""
          directory=""
          accept=".md,text/markdown"
          style={{ maxWidth: "100%" }}
          onChange={(e) => onFiles(e.target.files)}
        />
      </div>

      <div className={styles.field}>
        <span className={styles.label}>…or pick individual files</span>
        <input
          ref={filesInputRef}
          type="file"
          multiple
          accept=".md,text/markdown"
          style={{ maxWidth: "100%" }}
          onChange={(e) => onFiles(e.target.files)}
        />
      </div>

      {picked.length > 0 && (
        <div className={styles.field}>
          <span className={styles.label}>
            Ready to upload — {picked.length} file(s),{" "}
            {(totalBytes / 1024).toFixed(1)} KiB total
          </span>
          <ul
            style={{
              maxHeight: 180,
              overflow: "auto",
              margin: 0,
              padding: "0.5rem 1rem",
              border: "1px solid var(--ink-line, #c9b9a8)",
              borderRadius: 6,
              fontSize: 12,
              fontFamily: "var(--font-mono, monospace)",
              wordBreak: "break-all",
            }}
          >
            {picked.slice(0, 50).map((f) => (
              <li key={f.path}>{f.path}</li>
            ))}
            {picked.length > 50 && (
              <li style={{ color: "var(--ink-muted, #6b574a)" }}>
                …and {picked.length - 50} more
              </li>
            )}
          </ul>
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}
      {progress && pending && (
        <div className={styles.hint}>
          Uploading {progress.done}/{progress.total}…
        </div>
      )}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          onClick={onUpload}
          disabled={pending || picked.length === 0}
        >
          {pending ? "Importing…" : "Import to vault"}
        </button>
        <button
          type="button"
          className={styles.skip}
          onClick={() => router.push(`/app/${orgSlug}/onboarding/vault`)}
          disabled={pending}
        >
          Back to wizard
        </button>
      </div>
    </div>
  );
}
