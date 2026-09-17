export function injectedResult(value) {
    return { outcome: "return", value };
}
export function injectedFailure(error) {
    return { outcome: "throw", error };
}
export function createAsyncFailureInjector(injections, fallback) {
    const pending = [...injections];
    const calls = [];
    return {
        calls,
        get remaining() {
            return pending.length;
        },
        async invoke(...args) {
            calls.push(args);
            const injection = pending.shift();
            if (!injection) {
                if (fallback)
                    return fallback(...args);
                throw new Error("Failure injector has no remaining scripted outcome");
            }
            if (injection.outcome === "throw")
                throw injection.error;
            return injection.value;
        },
    };
}
