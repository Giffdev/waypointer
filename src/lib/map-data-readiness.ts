export type MapDataReadiness<T> = {
  setLatest: (value: T) => void;
  markReady: () => T;
  currentIfReady: () => T | undefined;
};

export function createMapDataReadiness<T>(initial: T): MapDataReadiness<T> {
  let latest = initial;
  let ready = false;
  return {
    setLatest(value) {
      latest = value;
    },
    markReady() {
      ready = true;
      return latest;
    },
    currentIfReady() {
      return ready ? latest : undefined;
    },
  };
}
