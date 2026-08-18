export const AIRPORT_RELEASE_LOCK_KEYS = [734625193, 150879443] as const;

export class AirportReleaseWriteBarrierError extends Error {
  constructor() {
    super("Persisted data is temporarily read-only during a controlled release.");
    this.name = "AirportReleaseWriteBarrierError";
  }
}
