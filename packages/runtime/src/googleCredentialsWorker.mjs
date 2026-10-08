// Fixed credential program keeps SDK keys inside one owned process group.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
process.on("disconnect", () => {
  try { process.kill(-process.pid, "SIGKILL"); }
  catch { process.exit(1); }
});
process.once("message", ({ authModule, authOptions, compute }) => {
  const { GoogleAuth, Compute } = require(authModule);
  const auth = new GoogleAuth(compute ? { ...authOptions, authClient: new Compute(authOptions.clientOptions) } : authOptions);
  const text = (value, limit) => typeof value === "string" && value.trim() && value.length <= limit;
  process.on("message", async ({ id, operation, args }) => {
    try {
      let value;
      if (operation === "token") {
        value = await auth.getAccessToken();
        if (!text(value, 65536)) throw { code: "invalid_response" };
      } else if (operation === "metadata") {
        const credentials = await auth.getCredentials();
        value = {};
        for (const key of ["client_email", "universe_domain"]) {
          const field = credentials[key];
          if (field !== undefined) {
            if (!text(field, 1024)) throw { code: "invalid_response" };
            value[key] = field;
          }
        }
      } else if (operation === "sign") {
        value = await auth.sign(args[0], args[1]);
        if (!text(value, 131072)) throw { code: "invalid_response" };
      } else throw { code: "invalid_request" };
      process.send({ id, value });
    } catch (error) {
      process.send({ id, code: ["invalid_response", "invalid_request"].includes(error?.code) ? error.code : "failed" });
    }
  });
});
