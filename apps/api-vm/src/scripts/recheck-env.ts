import { homedir } from "node:os";
import { join } from "node:path";

/** Load the same generated env file as `noelle up`, before runtime imports. */
export async function importAfterOperatorEnv<T>(
  importRuntime: () => Promise<T>,
  filePath = process.env.NOELLE_ENV_FILE ?? join(homedir(), ".noelle", ".env"),
): Promise<T> {
  try {
    // Node does not override variables already supplied by the caller/PM2.
    process.loadEnvFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return importRuntime();
}
