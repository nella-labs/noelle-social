import { makeSerialQueue } from "./serial-queue.js";

export interface SessionStateStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Pre-upgrade runs without an epoch belong to generation zero. */
export function tickIsCurrent(loadedEpoch: number | undefined, currentEpoch: number): boolean {
  return (loadedEpoch ?? 0) === currentEpoch;
}

/** One store per service worker serializes its cooperating storage operations. */
export function createSessionRunStateStore<T extends { epoch?: number }>(
  getSessionStorage: () => SessionStateStorage,
) {
  const stateKey = "actuator.runstate";
  const epochKey = "actuator.epoch";
  const serialize = makeSerialQueue();
  const readEpoch = async (session: SessionStateStorage): Promise<number> => {
    const result = await session.get(epochKey);
    return (result[epochKey] as number | undefined) ?? 0;
  };

  return {
    saveState: (state: T): Promise<void> => serialize(async () => {
      await getSessionStorage().set({ [stateKey]: state });
    }),
    loadState: (): Promise<T | null> => serialize(async () => {
      const result = await getSessionStorage().get(stateKey);
      return (result[stateKey] as T | undefined) ?? null;
    }),
    clearState: (): Promise<void> => serialize(async () => {
      await getSessionStorage().remove(stateKey);
    }),
    currentEpoch: (): Promise<number> => serialize(() => readEpoch(getSessionStorage())),
    bumpEpoch: (): Promise<number> => serialize(async () => {
      const session = getSessionStorage();
      const next = await readEpoch(session) + 1;
      await session.set({ [epochKey]: next });
      return next;
    }),
    /** Reserve a start only if its asynchronous preparation still belongs to this generation. */
    claimEpoch: (expectedEpoch?: number): Promise<number | null> => serialize(async () => {
      const session = getSessionStorage();
      const current = await readEpoch(session);
      if (expectedEpoch !== undefined && expectedEpoch !== current) return null;
      const next = current + 1;
      await session.set({ [epochKey]: next });
      return next;
    }),
    /** Short storage/alarm metadata only; no network, CDP or nested store operations. */
    runIfCurrent: (epoch: number, operation: () => Promise<void>): Promise<boolean> => serialize(async () => {
      if (!tickIsCurrent(epoch, await readEpoch(getSessionStorage()))) return false;
      await operation();
      return true;
    }),
    saveIfCurrent: (state: T): Promise<boolean> => serialize(async () => {
      const session = getSessionStorage();
      if (!tickIsCurrent(state.epoch, await readEpoch(session))) return false;
      await session.set({ [stateKey]: state });
      return true;
    }),
  };
}
