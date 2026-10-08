import { SecretAccessError, SecretManagerProcess, secretTimeoutMs } from "./secretProcess.js";
import {
  MAX_SECRET_BYTES,
  decodeSecretPayload,
  type SecretProcessConfig,
  type SecretOperationRequest,
} from "./secretProtocol.js";
type CallOptions = { timeout?: number; retry?: unknown; autoPaginate?: false };

/** A request-bound, single-page interface; its sequence shares one work deadline. */
export function createSecretManagerClient(
  options: SecretProcessConfig & {
    owner?: SecretManagerProcess;
    deadline?: number;
    timeoutMs?: number;
  },
) {
  const owner = options.owner ?? new SecretManagerProcess();
  const deadline = options.deadline ?? performance.now() + secretTimeoutMs(options.timeoutMs);
  const config: SecretProcessConfig = {
    authOptions: options.authOptions,
    wif: options.wif,
    sdkOptions: options.sdkOptions,
  };
  const request = (operation: SecretOperationRequest, opts?: CallOptions) =>
    owner.request(
      operation,
      config,
      opts?.timeout == null
        ? deadline
        : Math.min(deadline, performance.now() + secretTimeoutMs(opts.timeout)),
    );
  return {
    async accessSecretVersion(args: { name: string }, opts?: CallOptions) {
      const receipt = await request({ operation: "access", name: args.name }, opts);
      return [{ payload: { data: decodeSecretPayload(receipt.data) } }] as const;
    },
    async getSecret(args: { name: string }, opts?: CallOptions) {
      return [(await request({ operation: "get", name: args.name }, opts)).value!] as const;
    },
    async listSecretVersions(
      args: { parent: string; filter?: string; pageSize: number; pageToken?: string },
      opts?: CallOptions,
    ) {
      const receipt = await request(
        {
          operation: "list",
          name: args.parent,
          filter: args.filter,
          pageSize: args.pageSize,
          pageToken: args.pageToken,
        },
        opts,
      );
      return [
        receipt.versions!,
        undefined,
        { nextPageToken: receipt.nextPageToken ?? "" },
      ] as const;
    },
    async createSecret(
      args: {
        parent: string;
        secretId: string;
        secret: {
          name?: string;
          replication: { automatic: object };
          labels?: Record<string, string>;
        };
      },
      opts?: CallOptions,
    ) {
      return [
        (
          await request(
            {
              operation: "create",
              name: args.parent,
              secretId: args.secretId,
              labels: args.secret.labels,
            },
            opts,
          )
        ).value!,
      ] as const;
    },
    async addSecretVersion(
      args: { parent: string; payload: { data: Uint8Array } },
      opts?: CallOptions,
    ) {
      owner.checkAvailable();
      if (args.payload.data.byteLength > MAX_SECRET_BYTES)
        throw new SecretAccessError("Secret payload too large", "body_too_large");
      return [
        (
          await request(
            {
              operation: "add",
              name: args.parent,
              payloadBase64: Buffer.from(args.payload.data).toString("base64"),
            },
            opts,
          )
        ).value!,
      ] as const;
    },
    async disableSecretVersion(args: { name: string }, opts?: CallOptions) {
      return [(await request({ operation: "disable", name: args.name }, opts)).value!] as const;
    },
  };
}
