import { cloneConfigJson, type Candidate, type JsonObject, type JsonValue } from '../config/index.ts';

/** Share only unfinished work. No observation or failure survives completion. */
export function singleFlight<T>(operation: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (!pending) pending = Promise.resolve().then(operation).finally(() => { pending = undefined; });
    return pending;
  };
}

/** One bounded immutable entry; the key covers every policy byte, not revision alone. */
export function memoizePolicyCompiler(compile: (policy: JsonObject) => Candidate): (policy: JsonObject) => Candidate {
  let previous: { key: string; value: Candidate } | undefined;
  const freeze = (value: JsonValue): void => {
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  return policy => {
    // Validate before any cache hit: NaN/Infinity serialize like null, and
    // normal JSON serialization would otherwise invoke getters or toJSON.
    const key = JSON.stringify(cloneConfigJson(policy));
    if (previous?.key === key) return previous.value;
    const value = compile(policy);
    freeze(value.config);
    Object.freeze(value);
    previous = { key, value };
    return value;
  };
}
