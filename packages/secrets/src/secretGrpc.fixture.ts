import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
export async function grpcService() {
  // Use the installed SDK's exact protocol definitions and transport dependency.
  const require = createRequire(import.meta.url);
  const sdkRequire = createRequire(require.resolve("@google-cloud/secret-manager"));
  const { GrpcClient } = sdkRequire("google-gax");
  const gax = new GrpcClient(),
    grpc = gax.grpc;
  const definition = JSON.parse(
    await readFile(
      join(dirname(require.resolve("@google-cloud/secret-manager")), "../protos/protos.json"),
      "utf8",
    ),
  );
  const protos = gax.loadProtoJSON(definition);
  const dir = await mkdtemp(join(tmpdir(), "noelle-secret-grpc-"));
  const key = join(dir, "key.pem"),
    cert = join(dir, "cert.pem"),
    config = join(dir, "request.conf");
  let server: ReturnType<typeof grpc.Server> | undefined;
  try {
    await writeFile(
      config,
      "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n",
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-nodes",
        "-newkey",
        "rsa:2048",
        "-config",
        config,
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
      ],
      { stdio: "ignore", timeout: 5000 },
    );
    server = new grpc.Server();
    const state = { mode: "healthy", size: 65536, hits: 0, cancelled: 0, authenticated: true };
    server!.addService(protos.google.cloud.secretmanager.v1.SecretManagerService.service, {
      accessSecretVersion(
        call: {
          metadata: { get(key: string): unknown[] };
          on(event: string, callback: () => void): void;
        },
        callback: (error: unknown, value?: unknown) => void,
      ) {
        state.hits++;
        state.authenticated &&= call.metadata.get("authorization")[0] === "Bearer fixture-token";
        if (state.mode === "healthy")
          callback(null, { payload: { data: Buffer.alloc(state.size, 120) } });
        else if (state.mode === "held")
          call.on("cancelled", () => {
            state.cancelled++;
          });
        else
          callback({
            code: state.mode === "denied" ? 7 : 14,
            details: "fixture-secret fixture-token",
          });
      },
    });
    const credentials = grpc.ServerCredentials.createSsl(
      null,
      [{ private_key: await readFile(key), cert_chain: await readFile(cert) }],
      false,
    );
    const port = await new Promise<number>((resolve, reject) =>
      server!.bindAsync("127.0.0.1:0", credentials, (error: unknown, port: number) =>
        error ? reject(error) : resolve(port),
      ),
    );
    return {
      cert,
      port,
      state,
      async close() {
        server!.forceShutdown();
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    server?.forceShutdown();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
