import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { Socket } from "node:net";
import type { createSecretsClient as Factory } from "./index.js";
export async function nativeSecrets(): Promise<typeof Factory> {
  return (await import(new URL("../dist/index.js", import.meta.url).href)).createSecretsClient;
}
export async function nativeManager() {
  return (await import(new URL("../dist/index.js", import.meta.url).href))
    .createSecretManagerClient as typeof import("./index.js").createSecretManagerClient;
}
export async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    handler(req, res);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    sockets,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
export async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await delay(10);
  if (!check()) throw new Error("Local SDK fixture not reached");
}
export function options(server: { url: string; port: number }) {
  return {
    project: "fixture",
    source: "gcp" as const,
    timeoutMs: 30_000,
    sdkOptions: {
      projectId: "fixture",
      fallback: true,
      protocol: "http" as const,
      apiEndpoint: "127.0.0.1",
      port: server.port,
    },
    authOptions: {
      projectId: "fixture",
      credentials: {
        type: "authorized_user",
        client_id: "fixture-client",
        client_secret: "fixture-secret",
        refresh_token: "fixture-refresh",
      },
      clientOptions: { endpoints: { oauth2TokenUrl: `${server.url}/token` } },
    },
  };
}
export function token(res: ServerResponse) {
  res.end(
    JSON.stringify({ access_token: "fixture-token", expires_in: 3600, token_type: "Bearer" }),
  );
}
export function secret(res: ServerResponse, value = "fixture-value") {
  res.end(JSON.stringify({ payload: { data: Buffer.from(value).toString("base64") } }));
}
