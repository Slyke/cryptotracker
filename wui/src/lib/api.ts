import { writable } from 'svelte/store';

export interface SessionUser {
  username: string;
  groups: string[];
  authMethod: 'local' | 'header';
}

export interface SessionState {
  loading: boolean;
  authenticated: boolean;
  user: SessionUser | null;
  csrfToken: string | null;
  build: {
    version: string;
    buildHash: string;
  };
  error: string | null;
}

export const session = writable<SessionState>({
  loading: true,
  authenticated: false,
  user: null,
  csrfToken: null,
  build: {
    version: '0.1.0',
    buildHash: 'unknown'
  },
  error: null
});

let csrfToken: string | null = null;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const apiRequest = async <T>({
  url,
  method = 'GET',
  body,
  headers = {}
}: {
  url: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}): Promise<T> => {
  const response = await fetch(url, {
    method,
    headers: {
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' && method !== 'HEAD' && csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  let payload: unknown = null;
  if (text && /json/i.test(contentType)) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const message = (
      payload
      && typeof payload === 'object'
      && 'error' in payload
      && payload.error
      && typeof payload.error === 'object'
      && 'message' in payload.error
    )
      ? String(payload.error.message)
      : `${response.status} ${response.statusText}`;
    throw new ApiError(message, response.status, payload ?? text);
  }
  return payload as T;
};

export const bootstrapSession = async () => {
  session.update((current) => ({ ...current, loading: true, error: null }));
  try {
    const payload = await apiRequest<{
      user: SessionUser;
      csrfToken: string;
      build: {
        version: string;
        buildHash: string;
      };
    }>({ url: '/api/me' });
    csrfToken = payload.csrfToken;
    session.set({
      loading: false,
      authenticated: true,
      user: payload.user,
      csrfToken,
      build: payload.build,
      error: null
    });
    return true;
  } catch (error) {
    csrfToken = null;
    session.set({
      loading: false,
      authenticated: false,
      user: null,
      csrfToken: null,
      build: {
        version: '0.1.0',
        buildHash: 'unknown'
      },
      error: error instanceof ApiError && error.status !== 401 ? error.message : null
    });
    return false;
  }
};

export const signIn = async ({
  username,
  password
}: {
  username: string;
  password: string;
}) => {
  await apiRequest({
    url: '/auth/local/login',
    method: 'POST',
    body: { username, password }
  });
  return bootstrapSession();
};

export const signOut = async () => {
  await apiRequest({
    url: '/auth/logout',
    method: 'POST',
    body: {}
  });
  csrfToken = null;
  session.set({
    loading: false,
    authenticated: false,
    user: null,
    csrfToken: null,
    build: {
      version: '0.1.0',
      buildHash: 'unknown'
    },
    error: null
  });
};

export interface DocumentPreferences {
  theme: string;
  font: string;
  contentWidth: string;
}

const documentPreferencesStorageKey = 'cryptotracker.document-preferences';

export const readCachedDocumentPreferences = (): DocumentPreferences | null => {
  try {
    const value = localStorage.getItem(documentPreferencesStorageKey);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<DocumentPreferences>;
    return (
      typeof parsed.theme === 'string'
      && typeof parsed.font === 'string'
      && typeof parsed.contentWidth === 'string'
    ) ? {
        theme: parsed.theme,
        font: parsed.font,
        contentWidth: parsed.contentWidth
      }
      : null;
  } catch {
    return null;
  }
};

export const setDocumentPreferences = ({
  theme,
  font,
  contentWidth
}: DocumentPreferences) => {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.font = font;
  document.documentElement.dataset.contentWidth = contentWidth;
  try {
    localStorage.setItem(documentPreferencesStorageKey, JSON.stringify({
      theme,
      font,
      contentWidth
    }));
  } catch {
    // Document attributes still apply when storage is unavailable.
  }
};
