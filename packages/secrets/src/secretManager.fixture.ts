import { serve } from "./secretProcess.fixture.js";
export const fixtureName = "projects/fixture/secrets/one";
export async function managedFixture() {
  const state = {
    hold: "",
    auth: 0,
    iam: 0,
    rpc: 0,
    adds: 0,
    writeBytes: 0,
    status: 200,
    coherent: true,
    authenticated: true,
    requests: [] as string[],
    disabled: [] as string[],
    versionState: "ENABLED",
    versionPathSuffix: "",
  };
  const server = await serve((req, res) => {
    if (req.url === "/sts") {
      state.auth++;
      if (state.hold !== "sts")
        res.end(
          JSON.stringify({
            access_token: "fixture-federated",
            expires_in: 3600,
            token_type: "Bearer",
          }),
        );
    } else if (req.url?.includes(":generateAccessToken")) {
      state.iam++;
      if (state.hold !== "iam")
        res.end(
          JSON.stringify({
            accessToken: "fixture-access",
            expireTime: new Date(Date.now() + 3600000).toISOString(),
          }),
        );
    } else {
      state.rpc++;
      state.requests.push(req.url ?? "");
      state.authenticated &&= req.headers.authorization === "Bearer fixture-access";
      const url = new URL(req.url!, "http://127.0.0.1");
      if (url.pathname.endsWith(":addVersion")) {
        state.adds++;
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          state.writeBytes = Buffer.from(body.payload.data, "base64").byteLength;
          if (state.hold === "write") return;
          res.statusCode = state.status;
          res.end(
            JSON.stringify(
              state.status === 200
                ? { name: `${fixtureName}/versions/3`, state: "ENABLED" }
                : { error: { code: state.status, message: "fixture-secret fixture-token" } },
            ),
          );
        });
      } else if (url.pathname.endsWith(":access"))
        res.end(
          JSON.stringify({ payload: { data: Buffer.from("fixture-value").toString("base64") } }),
        );
      else if (url.pathname.endsWith(":disable")) {
        const name = url.pathname.slice(4, -8);
        state.disabled.push(name);
        res.end(JSON.stringify({ name, state: "DISABLED" }));
      } else if (url.pathname.endsWith("/versions")) {
        const ids = url.searchParams.get("pageToken") ? [3] : [2, 1];
        res.end(
          JSON.stringify({
            versions: ids.map((id) => ({
              name: `${fixtureName}/versions/${id}${state.versionPathSuffix}`,
              state: state.versionState,
              createTime: "2023-11-14T22:13:20Z",
            })),
            nextPageToken: ids.length === 1 ? "" : "next",
          }),
        );
      } else
        res.end(
          JSON.stringify({ name: state.coherent ? fixtureName : "projects/foreign/secrets/other" }),
        );
    }
  });
  return {
    ...server,
    state,
    config: {
      sdkOptions: {
        projectId: "fixture",
        fallback: true,
        protocol: "http" as const,
        apiEndpoint: "127.0.0.1",
        port: server.port,
      },
      wif: {
        audience:
          "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/fixture/providers/fixture",
        subjectToken: "fixture-subject",
        tokenUrl: `${server.url}/sts`,
        serviceAccountImpersonationUrl: `${server.url}/v1/projects/-/serviceAccounts/fixture@example.com:generateAccessToken`,
      },
    },
  };
}
