export interface SandboxEnv {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  toObject(): Promise<Record<string, string>>;
  delete(key: string): Promise<void>;
}
