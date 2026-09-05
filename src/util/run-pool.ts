/** Run async tasks with bounded concurrency, preserving input order.
 * Tasks must not reject — wrap errors inside each task (callers here use
 * per-task try/catch and encode failures in the result value). */
export async function runPool<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, tasks.length)) },
    async () => {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await tasks[index]();
      }
    },
  );
  await Promise.all(workers);
  return results;
}
