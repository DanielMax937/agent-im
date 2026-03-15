/**
 * Type declarations for the redis module (optional dependency).
 * This avoids compile errors when redis is not installed.
 */

declare module 'redis' {
  export interface RedisClientOptions {
    url?: string;
  }

  export interface RedisClient {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    lPush(key: string, value: string): Promise<number>;
    rPop(key: string): Promise<string | null>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<string>;
    incr(key: string): Promise<number>;
    on(event: string, callback: (err: Error) => void): void;
  }

  export function createClient(options?: RedisClientOptions): RedisClient;
}
