"use client";

import { useEffect, useMemo, useState } from "react";
import { useMounted } from "@/lib/use-mounted";
import { timeAgoShort } from "@/lib/agent-activity-copy";
import type { VaultFile, VaultNode } from "@/lib/vault-types";

interface VaultBrowserProps {
  tree: VaultNode[];
  initialSelected: string;
  orgId: string;
  workspaceLabel: string;
}

function flattenFiles(nodes: VaultNode[]): VaultFile[] {
  const out: VaultFile[] = [];
  for (const node of nodes) {
    if (node.type === "file") out.push(node);
    else out.push(...flattenFiles(node.children));
  }
  return out;
}

export function VaultBrowser({ tree, initialSelected, orgId, workspaceLabel }: VaultBrowserProps) {
  const allFiles = useMemo(() => flattenFiles(tree), [tree]);
  const [selected, setSelected] = useState<string>(initialSelected);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [body, setBody] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [loadingBody, setLoadingBody] = useState(false);

  const selectedFile: VaultFile | null = useMemo(
    () => allFiles.find((f) => f.path === selected) ?? null,
    [allFiles, selected],
  );

  useEffect(() => {
    setBodyError(null);
    if (!selectedFile) {
      setBody(null);
      setLoadingBody(false);
      return;
    }
    // Fixtures carry an inline body; live GCS files fetch on demand.
    if (typeof selectedFile.body === "string") {
      setBody(selectedFile.body);
      setLoadingBody(false);
      return;
    }
    let cancelled = false;
    setLoadingBody(true);
    setBody(null);
    fetch(
      `/api/vault/file?orgId=${encodeURIComponent(orgId)}&path=${encodeURIComponent(selectedFile.path)}`,
    )
      .then(async (r) => {
        if (!r.ok) {
          const payload = await r.json().catch(() => null);
          if (!cancelled) setBodyError(typeof payload?.message === "string" ? payload.message : "Could not load this file.");
          return null;
        }
        return r.json();
      })
      .then((j: { body: string } | null) => {
        if (!j) return;
        if (!cancelled) setBody(j.body);
      })
      .catch(() => {
        if (!cancelled) setBodyError("Could not load this file.");
      })
      .finally(() => {
        if (!cancelled) setLoadingBody(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFile, orgId]);

  return (
    <div
      className="stack-phone"
      style={{
        display: "grid",
        gridTemplateColumns: "280px 1fr",
        gap: 20,
        alignItems: "start",
      }}
    >
      {/* Folder tree */}
      <div
        className="card vault-tree"
        style={{
          padding: 0,
          overflow: "hidden",
          position: "sticky",
          top: 16,
          maxHeight: "calc(100vh - 220px)",
          display: "flex",
          flexDirection: "column",
          ["--pad" as string]: "0px",
        }}
      >
        <div
          style={{
            padding: "12px 14px",
            borderBottom: "1px solid var(--rule-soft)",
          }}
        >
          <div className="eyebrow">Workspace</div>
          <div
            className="mono"
            style={{ fontSize: 12, color: "var(--ink)", marginTop: 4 }}
          >
            {workspaceLabel}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
          <Tree
            nodes={tree}
            depth={0}
            selected={selected}
            onSelect={setSelected}
            collapsed={collapsed}
            setCollapsed={setCollapsed}
          />
        </div>
      </div>

      {/* File viewer */}
      <div>
        {selectedFile ? (
          <FileViewer
            file={selectedFile}
            body={body}
            error={bodyError}
            loadingBody={loadingBody}
          />
        ) : (
          <div
            className="card"
            style={{
              padding: 32,
              textAlign: "center",
              color: "var(--ink-muted)",
            }}
          >
            Pick a file from the tree to preview.
          </div>
        )}
      </div>
    </div>
  );
}

interface TreeProps {
  nodes: VaultNode[];
  depth: number;
  selected: string;
  onSelect: (path: string) => void;
  collapsed: Record<string, boolean>;
  setCollapsed: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
}

function Tree({ nodes, depth, selected, onSelect, collapsed, setCollapsed }: TreeProps) {
  const sorted = [...nodes].sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === "folder" ? -1 : 1;
  });

  return (
    <div>
      {sorted.map((node) => {
        if (node.type === "folder") {
          const open = !collapsed[node.path];
          return (
            <div key={node.path}>
              <button
                onClick={() =>
                  setCollapsed((c) => ({ ...c, [node.path]: open }))
                }
                style={{
                  width: "100%",
                  textAlign: "left",
                  border: 0,
                  cursor: "pointer",
                  background: "transparent",
                  padding: `5px 8px 5px ${12 + depth * 14}px`,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12.5,
                  color: "var(--ink)",
                  fontFamily: "var(--body)",
                  fontWeight: 500,
                }}
              >
                <span
                  style={{
                    width: 12,
                    color: "var(--ink-soft)",
                    fontFamily: "var(--mono)",
                    fontSize: 10,
                  }}
                >
                  {open ? "▾" : "▸"}
                </span>
                <span style={{ color: "var(--accent)", fontFamily: "var(--mono)" }}>
                  ▤
                </span>
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {node.name}
                </span>
              </button>
              {open && (
                <Tree
                  nodes={node.children}
                  depth={depth + 1}
                  selected={selected}
                  onSelect={onSelect}
                  collapsed={collapsed}
                  setCollapsed={setCollapsed}
                />
              )}
            </div>
          );
        }

        const isSelected = selected === node.path;
        return (
          <div
            key={node.path}
            style={{
              background: isSelected ? "var(--paper-2)" : "transparent",
              borderLeft: isSelected
                ? "2px solid var(--accent)"
                : "2px solid transparent",
            }}
          >
            <button
              onClick={() => onSelect(node.path)}
              style={{
                width: "100%",
                textAlign: "left",
                border: 0,
                cursor: "pointer",
                background: "transparent",
                padding: `5px 8px 5px ${12 + depth * 14}px`,
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12.5,
                color: isSelected ? "var(--ink)" : "var(--ink-2)",
                fontFamily: "var(--mono)",
              }}
            >
              <span style={{ width: 12 }} />
              <span style={{ color: "var(--ink-soft)", fontFamily: "var(--mono)" }}>
                ·
              </span>
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {node.name}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

interface FileViewerProps {
  file: VaultFile;
  body: string | null;
  error: string | null;
  loadingBody: boolean;
}

function FileViewer({ file, body, error, loadingBody }: FileViewerProps) {
  // Relative "Xs ago" depends on the current clock — defer past hydration.
  const mounted = useMounted();
  const parts = file.path.split("/");
  const parentTrail = parts.slice(0, -1).join(" / ") || "root";
  const displayName = file.name.replace(/\.md$/, "");
  const searchable = file.name.toLowerCase().endsWith(".md");
  const anchoredBy = file.anchoredBy ?? [];

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden", ["--pad" as string]: "0px" }}>
      <div
        style={{
          padding: "16px 22px",
          borderBottom: "1px solid var(--rule-soft)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="mono"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.08em",
              color: "var(--ink-muted)",
              textTransform: "uppercase",
            }}
          >
            {parentTrail}
          </div>
          <div
            className="serif"
            style={{ fontSize: 24, lineHeight: 1.1, marginTop: 4 }}
          >
            {displayName}
          </div>
        </div>
        {searchable ? (
          <span className="tag tag-ok">
            <span className="dot dot-ok" /> searchable
          </span>
        ) : (
          <span className="tag">stored</span>
        )}
        {typeof file.wordCount === "number" && (
          <span className="tag">{file.wordCount} words</span>
        )}
      </div>

      {error ? <div role="alert" style={{ padding: "20px 24px", color: "var(--ink-muted)", fontSize: 13 }}>{error}</div> : <pre
        style={{
          margin: 0,
          padding: "20px 24px",
          background: "var(--paper)",
          color: "var(--ink-2)",
          fontFamily: "var(--mono)",
          fontSize: 13,
          lineHeight: 1.7,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {loadingBody ? "loading…" : (body ?? file.body ?? "")}
      </pre>}

      <div
        style={{
          padding: "14px 22px",
          background: "var(--paper-2)",
          borderTop: "1px solid var(--rule-soft)",
        }}
      >
        <div className="kv">
          <span className="k">Last modified</span>
          <span className="v">{mounted ? timeAgoShort(file.lastModifiedISO) : "—"}</span>
        </div>
        <div className="kv">
          <span className="k">Path</span>
          <span className="v">{file.path}</span>
        </div>
        <div className="kv">
          <span className="k">Anchored by</span>
          <span
            className="v"
            style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}
          >
            {anchoredBy.length === 0 ? (
              <span style={{ color: "var(--ink-soft)" }}>— no draft has pulled this yet</span>
            ) : (
              anchoredBy.map((slug) => (
                <span key={slug} className="tag tag-acc">
                  {slug}
                </span>
              ))
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
