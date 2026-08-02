export class SingleFlight {
  private readonly active = new Map<string, Promise<unknown>>();

  run<T>({ key, load }: { key: string; load: () => Promise<T> }): Promise<T> {
    const existing = this.active.get(key);
    if (existing) return existing as Promise<T>;
    const pending = Promise.resolve()
      .then(load)
      .finally(() => {
        if (this.active.get(key) === pending) this.active.delete(key);
      });
    this.active.set(key, pending);
    return pending;
  }
}
