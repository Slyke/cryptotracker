import { apiRequest } from '$lib/api';

export interface AccordionStateOptions {
  key: string;
  defaultOpen?: boolean;
}

let states: Record<string, boolean> | null = null;
let loadPromise: Promise<Record<string, boolean>> | null = null;
let saveTail = Promise.resolve();

const loadStates = () => {
  if (states) return Promise.resolve(states);
  if (loadPromise) return loadPromise;
  loadPromise = apiRequest<{
    settings: {
      accordionStates?: Record<string, boolean>;
    };
  }>({ url: '/api/settings' })
    .then((payload) => {
      states = payload.settings.accordionStates ?? {};
      return states;
    })
    .finally(() => {
      loadPromise = null;
    });
  return loadPromise;
};

const persist = () => {
  const snapshot = { ...(states ?? {}) };
  saveTail = saveTail
    .catch(() => undefined)
    .then(async () => {
      await apiRequest({
        url: '/api/settings',
        method: 'PATCH',
        body: {
          accordionStates: snapshot
        }
      });
    });
};

export const persistAccordionState = (
  node: HTMLDetailsElement,
  initial: AccordionStateOptions
) => {
  let options = initial;
  let applying = true;
  let destroyed = false;

  const apply = async () => {
    applying = true;
    const loaded = await loadStates();
    if (destroyed) return;
    node.open = loaded[options.key] ?? options.defaultOpen ?? false;
    queueMicrotask(() => {
      applying = false;
    });
  };

  const toggled = () => {
    if (applying || destroyed) return;
    states = {
      ...(states ?? {}),
      [options.key]: node.open
    };
    persist();
  };

  node.addEventListener('toggle', toggled);
  void apply();

  return {
    update(next: AccordionStateOptions) {
      options = next;
      void apply();
    },
    destroy() {
      destroyed = true;
      node.removeEventListener('toggle', toggled);
    }
  };
};

export const accordionStateInternals = {
  loadStates
};
