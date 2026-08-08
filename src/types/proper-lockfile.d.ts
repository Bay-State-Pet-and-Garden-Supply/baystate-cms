/**
 * Minimal ambient declarations for proper-lockfile (CJS, no bundled types).
 * Only the API surface used by the classification config-store is declared.
 */
declare module 'proper-lockfile' {
  export interface LockOptions {
    realpath?: boolean;
    stale?: number;
    retries?: number | {
      retries: number;
      factor?: number;
      minTimeout?: number;
      maxTimeout?: number;
      randomize?: boolean;
    };
    lockfilePath?: string;
  }

  export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
  export function unlock(file: string, options?: LockOptions): Promise<void>;
  export function check(file: string, options?: LockOptions): Promise<boolean>;

  const lockfile: {
    lock: typeof lock;
    unlock: typeof unlock;
    check: typeof check;
  };
  export default lockfile;
}
