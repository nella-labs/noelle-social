import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

export const nativeBedrock = async () => import(new URL("../dist/bedrockBackend.js", import.meta.url).href) as Promise<typeof import("./bedrockBackend.js")>;
export const modelCall = { system: "Fixture system", prompt: "Fixture prompt", model: "claude-sonnet-4-6" };
export function reply(response: ServerResponse) {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ id: "msg-fixture", type: "message", role: "assistant", model: "fixture",
    content: [{ type: "text", text: "Native fixture response" }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 } }));
}
export async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture listen failed");
  return { url: `http://127.0.0.1:${address.port}`, sockets,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
export async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!await check()) { if (Date.now() >= deadline) throw new Error("fixture admission deadline"); await delay(10); }
}
export async function jsonFile<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return undefined; }
}
export function live(pid: number): boolean {
  try { const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 }).trim();
    return !!state && !state.startsWith("Z"); }
  catch (error) { if ((error as { status?: number }).status === 1) return false; throw error; }
}
