import type { GoogleAuthOptions } from "google-auth-library";
import { BoundedProcessQueue } from "@noelle/process";
import { SecretAccessError, SecretManagerProcess, safeSecretCode } from "./secretProcess.js";
import { MAX_SECRET_BYTES, decodeSecretPayload, type SecretSdkOptions } from "./secretProtocol.js";
export { SecretAccessError, secretTimeoutMs } from "./secretProcess.js";
export { MAX_SECRET_BYTES, type SecretSdkOptions } from "./secretProtocol.js";
export type AccessFn = (req: {
  name: string;
}) => Promise<[{ payload?: { data?: Uint8Array | Buffer | string } }]>;

export function createSecretAccessor(options: {
  client?: { accessSecretVersion: AccessFn };
  authOptions?: GoogleAuthOptions;
  sdkOptions?: SecretSdkOptions;
}) {
  const admission = options.client ? new BoundedProcessQueue() : undefined;
  const native = options.client ? undefined : new SecretManagerProcess();
  const read = async (name: string, deadline: number): Promise<string> => {
    try {
      if (native) {
        const receipt = await native.request({ operation: "access", name }, options, deadline);
        return decodeSecretPayload(receipt.data).toString("utf8");
      }
      return await admission!.run(deadline, async () => {
        const [response] = await options.client!.accessSecretVersion({ name });
        const payload = response?.payload?.data;
        if (payload == null) throw new SecretAccessError("Empty secret payload", "empty_payload");
        if (
          (typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength) >
          MAX_SECRET_BYTES
        )
          throw new SecretAccessError("Secret payload too large", "body_too_large");
        return Buffer.from(payload).toString("utf8");
      });
    } catch (error) {
      const code = safeSecretCode(error);
      throw new SecretAccessError(
        code === "failed" ? "Secret access failed" : `Secret access ${code}`,
        code,
      );
    }
  };
  return {
    read,
    checkAvailable() {
      try {
        if (native) native.checkAvailable();
        else admission!.checkAvailable();
      } catch (error) {
        throw new SecretAccessError("Secret admission unavailable", safeSecretCode(error));
      }
    },
  };
}
