export type AsyncInjection<TResult> =
  { outcome: "return"; value: TResult } | { outcome: "throw"; error: unknown };

export interface AsyncFailureInjector<TArgs extends unknown[], TResult> {
  readonly calls: TArgs[];
  readonly remaining: number;
  invoke(...args: TArgs): Promise<TResult>;
}

export function injectedResult<TResult>(
  value: TResult,
): AsyncInjection<TResult> {
  return { outcome: "return", value };
}

export function injectedFailure<TResult = never>(
  error: unknown,
): AsyncInjection<TResult> {
  return { outcome: "throw", error };
}

export function createAsyncFailureInjector<TArgs extends unknown[], TResult>(
  injections: AsyncInjection<TResult>[],
  fallback?: (...args: TArgs) => Promise<TResult> | TResult,
): AsyncFailureInjector<TArgs, TResult> {
  const pending = [...injections];
  const calls: TArgs[] = [];

  return {
    calls,
    get remaining() {
      return pending.length;
    },
    async invoke(...args: TArgs) {
      calls.push(args);
      const injection = pending.shift();
      if (!injection) {
        if (fallback) return fallback(...args);
        throw new Error("Failure injector has no remaining scripted outcome");
      }
      if (injection.outcome === "throw") throw injection.error;
      return injection.value;
    },
  };
}
