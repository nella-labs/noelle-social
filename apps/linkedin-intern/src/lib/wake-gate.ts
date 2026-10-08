/** Coalesce Postgres notifications while preserving the poll interval as fallback. */
export function createWakeGate() {
  let pending = false;
  let wakeSleeping: (() => void) | null = null;
  return {
    wake() {
      pending = true;
      wakeSleeping?.();
    },
    sleep(ms: number): Promise<void> {
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          wakeSleeping = null;
          pending = false;
          resolve();
        };
        const timer = setTimeout(finish, ms);
        wakeSleeping = finish;
      });
    },
  };
}
