export type MalwareScanResult =
  | { verdict: "clean"; provider: string }
  | { verdict: "infected"; provider: string };

export interface MalwareScanner {
  assertHealthy(): Promise<void>;
  scan(bytes: Uint8Array): Promise<MalwareScanResult>;
}
