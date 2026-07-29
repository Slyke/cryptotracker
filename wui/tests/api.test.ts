import { get } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiRequest,
  bootstrapSession,
  readCachedDocumentPreferences,
  session,
  setDocumentPreferences
} from '../src/lib/api.js';
import { interpolate } from '../src/lib/i18n/interpolate.js';

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-font');
  document.documentElement.removeAttribute('data-content-width');
  localStorage.clear();
});

describe('WUI foundations', () => {
  it('interpolates namespaced localization values', () => {
    expect(interpolate({
      template: 'Showing {$count} {$asset}',
      values: {
        count: 2,
        asset: 'assets'
      }
    })).toBe('Showing 2 assets');
  });

  it('surfaces stable API errors and safely handles non-JSON failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        error: {
          message: 'Fixture failure'
        }
      }),
      {
        status: 503,
        headers: {
          'content-type': 'application/json'
        }
      }
    )));
    await expect(apiRequest({ url: '/api/fixture' })).rejects.toEqual(
      expect.objectContaining({
        name: 'ApiError',
        message: 'Fixture failure',
        status: 503
      })
    );
  });

  it('moves an unauthorized bootstrap into the local login state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', {
      status: 401,
      statusText: 'Unauthorized'
    })));
    await expect(bootstrapSession()).resolves.toBe(false);
    expect(get(session)).toMatchObject({
      loading: false,
      authenticated: false,
      user: null,
      error: null
    });
  });

  it('applies theme, font, and content width preferences at the document root', () => {
    setDocumentPreferences({
      theme: 'light',
      font: 'ui-sans',
      contentWidth: '1440'
    });
    expect(document.documentElement.dataset).toMatchObject({
      theme: 'light',
      font: 'ui-sans',
      contentWidth: '1440'
    });
    expect(readCachedDocumentPreferences()).toEqual({
      theme: 'light',
      font: 'ui-sans',
      contentWidth: '1440'
    });
  });
});
