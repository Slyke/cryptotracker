<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { page } from '$app/stores';
  import Login from '$lib/components/Login.svelte';
  import strings from '$lib/i18n/en-CA.json';
  import { interpolate } from '$lib/i18n/interpolate';
  import {
    apiRequest,
    bootstrapSession,
    readCachedDocumentPreferences,
    session,
    setDocumentPreferences,
    signOut,
    type DocumentPreferences
  } from '$lib/api';
  import '$lib/styles/app.css';

  if (browser) {
    const cachedPreferences = readCachedDocumentPreferences();
    if (cachedPreferences) setDocumentPreferences(cachedPreferences);
  }

  const navigation = [
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/markets', label: 'Markets' },
    { href: '/addresses', label: 'Addresses' },
    { href: '/kraken', label: 'Kraken' },
    { href: '/settings', label: 'Settings' }
  ];

  onMount(async () => {
    if (!await bootstrapSession()) return;
    try {
      const payload = await apiRequest<{
        settings: DocumentPreferences;
      }>({ url: '/api/settings' });
      setDocumentPreferences(payload.settings);
    } catch {
      // The cached preference remains active if settings cannot be refreshed.
    }
  });

  const logout = async () => {
    await signOut();
  };
</script>

<svelte:head>
  <title>CryptoTracker</title>
  <meta name="description" content="Read-only self-hosted cryptocurrency portfolio viewer" />
</svelte:head>

{#if $session.loading}
  <main class="login-shell">
    <section class="panel login-panel" aria-live="polite">
      <h1>{strings['cryptotracker-app_name-label']}</h1>
      <p>{strings['cryptotracker-loading-label']}</p>
    </section>
  </main>
{:else if !$session.authenticated}
  <Login />
{:else}
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" href="/dashboard">CryptoTracker</a>
      <nav class="nav" aria-label="Primary">
        {#each navigation as item}
          <a
            href={item.href}
            aria-current={$page.url.pathname === item.href ? 'page' : undefined}
          >{item.label}</a>
        {/each}
      </nav>
      <span class="badge mid">{$session.user?.username}</span>
      <button class="ghost" type="button" on:click={logout}>Sign out</button>
      <span class="build-label">
        {interpolate({
          template: strings['cryptotracker-build-label'],
          values: $session.build
        })}
      </span>
    </header>
    <slot />
  </div>
{/if}
