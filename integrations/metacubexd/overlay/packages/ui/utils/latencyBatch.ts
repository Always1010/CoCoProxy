export const LATENCY_TEST_CONCURRENCY = 10

export function latencyProbeKey(generation: string | null, identity: string, name: string, url: string, timeout: number): string {
  return JSON.stringify([generation, identity, name, url, timeout])
}

/** Deduplicate within one run; never reuse results from a previous generation. */
export async function runLatencyBatch<T extends { key: string }>(
  input: T[],
  signal: AbortSignal,
  run: (job: T) => Promise<void>,
  current = () => !signal.aborted,
): Promise<void> {
  const jobs = [...new Map(input.map(job => [job.key, job])).values()]
  let index = 0
  await Promise.all(Array.from({ length: Math.min(LATENCY_TEST_CONCURRENCY, jobs.length) }, async () => {
    while (!signal.aborted && current()) {
      const job = jobs[index++]
      if (!job) break
      await run(job)
    }
  }))
}
