import type { getSecretManagerClient } from "./sm";
type Client = Awaited<ReturnType<typeof getSecretManagerClient>>;

function versionId(name: string, parent: string): bigint {
  const suffix = name.startsWith(`${parent}/versions/`) ? name.slice(parent.length + 10) : "";
  if (!/^[1-9][0-9]*$/.test(suffix)) throw new Error("Invalid Secret Manager version receipt");
  return BigInt(suffix);
}
/** Finish every started mutation before a batch failure is returned. */
async function disableBatch(client: Client, names: string[]): Promise<void> {
  let index = 0,
    failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(4, names.length) }, async () => {
      while (!failed && index < names.length) {
        const name = names[index++]!;
        try {
          await client.disableSecretVersion({ name });
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
    }),
  );
  if (failed) throw failure;
}
/** Page all states so acknowledged disables do not change page membership. */
async function disableSelectedVersions(
  client: Client,
  parent: string,
  select: (id: bigint) => boolean,
): Promise<void> {
  let pageToken = "";
  while (true) {
    const [versions, , response] = await client.listSecretVersions({
      parent,
      pageSize: 100,
      pageToken,
    });
    const names: string[] = [];
    for (const version of versions) {
      const id = versionId(version.name, parent);
      if (version.state === "ENABLED" && select(id)) names.push(version.name);
    }
    await disableBatch(client, names);
    const next = response.nextPageToken;
    if (!next) return;
    if (next === pageToken) throw new Error("Secret Manager pagination did not advance");
    pageToken = next;
  }
}
/** Acknowledges observed enabled versions; list state may remain stale afterward. */
export async function disableAllSecretVersions(client: Client, parent: string): Promise<void> {
  await disableSelectedVersions(client, parent, () => true);
}
/** Best-effort cleanup preserves the acknowledged version and every newer write. */
export async function disableOlderSecretVersions(
  client: Client,
  parent: string,
  addedName: string,
): Promise<void> {
  const addedId = versionId(addedName, parent);
  await disableSelectedVersions(client, parent, (id) => id < addedId);
}
