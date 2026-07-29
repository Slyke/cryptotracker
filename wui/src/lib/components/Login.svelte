<script lang="ts">
  import strings from '$lib/i18n/en-CA.json';
  import { signIn } from '$lib/api';

  let username = 'admin';
  let password = '';
  let busy = false;
  let error = '';

  const submit = async () => {
    busy = true;
    error = '';
    try {
      await signIn({ username, password });
    } catch {
      error = strings['cryptotracker-auth_denied-label'];
    } finally {
      busy = false;
    }
  };
</script>

<main class="login-shell">
  <section class="panel login-panel" aria-labelledby="login-title">
    <p class="eyebrow">{strings['cryptotracker-read_only-label']}</p>
    <h1 id="login-title">{strings['cryptotracker-login-title']}</h1>
    <p class="muted">Use the single local account configured by the operator, or access this service through an allowed trusted identity proxy.</p>

    {#if error}
      <div class="alert danger" role="alert">{error}</div>
    {/if}

    <form on:submit|preventDefault={submit}>
      <div class="field">
        <label for="username">Username</label>
        <input id="username" autocomplete="username" bind:value={username} required />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" type="password" autocomplete="current-password" bind:value={password} required />
      </div>
      <button type="submit" disabled={busy}>
        {busy ? 'Signing in…' : strings['cryptotracker-login-submit-label']}
      </button>
    </form>
  </section>
</main>
