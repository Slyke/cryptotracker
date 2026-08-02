type QueuedLoad = {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

export const createLoadQueue = ({ maximumConcurrent }: { maximumConcurrent: number }) => {
  const concurrency = Math.max(1, Math.floor(maximumConcurrent));
  const pending: QueuedLoad[] = [];
  let active = 0;

  const startNext = () => {
    while (active < concurrency && pending.length > 0) {
      const next = pending.shift()!;
      active += 1;
      void next.run()
        .then(next.resolve, next.reject)
        .finally(() => {
          active -= 1;
          startNext();
        });
    }
  };

  return <T>(run: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    pending.push({
      run,
      resolve: (value) => resolve(value as T),
      reject
    });
    startNext();
  });
};

// PostgreSQL is commonly deployed with one CPU for this single-tenant app.
// Two graph loads keep it busy without letting a large dashboard saturate the
// connection pool with overlapping history scans.
export const queueDashboardGraphLoad = createLoadQueue({ maximumConcurrent: 2 });
