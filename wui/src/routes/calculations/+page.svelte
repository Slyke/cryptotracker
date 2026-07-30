<script lang="ts">
  import { onMount } from 'svelte';
  import PortfolioChart from '../../lib/components/PortfolioChart.svelte';
  import type { ChartSeries } from '../../lib/components/chart-types';
  import { apiRequest } from '$lib/api';
  import { formatDisplayNumber } from '$lib/preferences';

  type SavedCalculation = {
    id: string;
    name: string;
    startDate: string;
    currency: string;
    principal: number;
    ratePercent: number;
    rateKind: 'apy' | 'apr';
    periodsPerYear: 1 | 12 | 52 | 365;
    durationValue: number;
    durationUnit: 'days' | 'months' | 'years';
    contributionPerPeriod: number;
    targetAmount: number | null;
  };

  type Projection = {
    valid: boolean;
    periods: number;
    endingBalance: number | null;
    totalContributed: number | null;
    earnings: number | null;
    requiredContribution: number | null;
    series: ChartSeries[];
  };

  let savedCalculations: SavedCalculation[] = [];
  let primaryCurrency = 'CAD';
  let timezone = 'America/Vancouver';
  let loading = true;
  let saving = false;
  let error = '';
  let message = '';

  const createId = () => globalThis.crypto?.randomUUID?.()
    ?? `calculation-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const blankScenario = (): SavedCalculation => ({
    id: createId(),
    name: 'New projection',
    startDate: new Date().toISOString().slice(0, 10),
    currency: primaryCurrency,
    principal: 10_000,
    ratePercent: 5,
    rateKind: 'apy',
    periodsPerYear: 12,
    durationValue: 10,
    durationUnit: 'years',
    contributionPerPeriod: 250,
    targetAmount: 100_000
  });

  let scenario = blankScenario();
  let projection: Projection;

  const durationYears = (value: SavedCalculation) => (
    value.durationUnit === 'days'
      ? value.durationValue / 365.25
      : value.durationUnit === 'months'
        ? value.durationValue / 12
        : value.durationValue
  );

  const project = (value: SavedCalculation): Projection => {
    const years = durationYears(value);
    const annualRate = value.ratePercent / 100;
    const valid = [
      years,
      annualRate,
      value.principal,
      value.contributionPerPeriod,
      value.periodsPerYear
    ].every(Number.isFinite)
      && years > 0
      && value.principal >= 0
      && value.contributionPerPeriod >= 0
      && annualRate > -1;
    if (!valid) {
      return {
        valid: false,
        periods: 0,
        endingBalance: null,
        totalContributed: null,
        earnings: null,
        requiredContribution: null,
        series: []
      };
    }
    const ratePerPeriod = value.rateKind === 'apy'
      ? Math.pow(1 + annualRate, 1 / value.periodsPerYear) - 1
      : annualRate / value.periodsPerYear;
    const elapsedPeriods = years * value.periodsPerYear;
    const fullPeriods = Math.floor(elapsedPeriods);
    const fractionalPeriod = elapsedPeriods - fullPeriods;
    const fullGrowth = Math.pow(1 + ratePerPeriod, fullPeriods);
    const fractionalGrowth = Math.pow(1 + ratePerPeriod, fractionalPeriod);
    const annuityFactor = ratePerPeriod === 0
      ? fullPeriods
      : (fullGrowth - 1) / ratePerPeriod;
    const contributionFactor = annuityFactor * fractionalGrowth;
    const endingBalance = (
      (value.principal * fullGrowth)
      + (value.contributionPerPeriod * annuityFactor)
    ) * fractionalGrowth;
    const totalContributed = value.principal + (value.contributionPerPeriod * fullPeriods);
    const earnings = endingBalance - totalContributed;
    const requiredContribution = (
      value.targetAmount !== null
      && contributionFactor > 0
    )
      ? Math.max(
          0,
          (value.targetAmount - (value.principal * fullGrowth * fractionalGrowth))
          / contributionFactor
        )
      : null;
    const sampleCount = Math.min(600, Math.max(12, Math.ceil(years * 12)));
    const startMs = new Date(`${value.startDate}T00:00:00.000Z`).getTime();
    const balancePoints: ChartSeries['points'] = [];
    const contributionPoints: ChartSeries['points'] = [];
    for (let sample = 0; sample <= sampleCount; sample += 1) {
      const samplePeriods = elapsedPeriods * (sample / sampleCount);
      const completed = Math.floor(samplePeriods);
      const fraction = samplePeriods - completed;
      const growth = Math.pow(1 + ratePerPeriod, completed);
      const partialGrowth = Math.pow(1 + ratePerPeriod, fraction);
      const sampleAnnuity = ratePerPeriod === 0
        ? completed
        : (growth - 1) / ratePerPeriod;
      const balance = (
        (value.principal * growth)
        + (value.contributionPerPeriod * sampleAnnuity)
      ) * partialGrowth;
      const contributed = value.principal + (value.contributionPerPeriod * completed);
      const timestampMs = startMs + ((years * sample / sampleCount) * 365.25 * 86_400_000);
      balancePoints.push({
        timestampMs,
        value: Number.isFinite(balance) ? String(balance) : null,
        status: 'projection'
      });
      contributionPoints.push({
        timestampMs,
        value: String(contributed),
        status: 'projection'
      });
    }
    return {
      valid: Number.isFinite(endingBalance),
      periods: fullPeriods,
      endingBalance: Number.isFinite(endingBalance) ? endingBalance : null,
      totalContributed,
      earnings: Number.isFinite(earnings) ? earnings : null,
      requiredContribution: Number.isFinite(requiredContribution) ? requiredContribution : null,
      series: [{
        id: 'projected-balance',
        label: 'Projected balance',
        points: balancePoints
      }, {
        id: 'total-contributed',
        label: 'Total contributed',
        points: contributionPoints
      }]
    };
  };

  const formatMoney = (value: number | null) => value === null
    ? 'unavailable'
    : formatDisplayNumber({
        value,
        currency: scenario.currency
      });

  const contributionInterval = () => ({
    1: 'year',
    12: 'month',
    52: 'week',
    365: 'day'
  })[scenario.periodsPerYear];

  const load = async () => {
    loading = true;
    error = '';
    try {
      const payload = await apiRequest<{
        settings: {
          primaryCurrency: string;
          timezone: string;
          savedCalculations: SavedCalculation[];
        };
      }>({ url: '/api/settings' });
      primaryCurrency = payload.settings.primaryCurrency;
      timezone = payload.settings.timezone;
      savedCalculations = payload.settings.savedCalculations ?? [];
      scenario = savedCalculations[0]
        ? { ...savedCalculations[0] }
        : { ...scenario, currency: primaryCurrency };
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Calculation settings could not be loaded.';
    } finally {
      loading = false;
    }
  };

  const patchSaved = async (next: SavedCalculation[]) => {
    const payload = await apiRequest<{ settings: { savedCalculations: SavedCalculation[] } }>({
      url: '/api/settings',
      method: 'PATCH',
      body: { savedCalculations: next }
    });
    savedCalculations = payload.settings.savedCalculations;
  };

  const saveScenario = async () => {
    error = '';
    message = '';
    if (!scenario.name.trim()) {
      error = 'Give this calculation a name before saving it.';
      return;
    }
    if (!projection.valid) {
      error = 'Fix the projection inputs before saving it.';
      return;
    }
    const duplicate = savedCalculations.find((item) => (
      item.id !== scenario.id
      && item.name.trim().toLocaleLowerCase() === scenario.name.trim().toLocaleLowerCase()
    ));
    if (duplicate) {
      error = 'A saved calculation already uses that name.';
      return;
    }
    saving = true;
    try {
      const saved = {
        ...scenario,
        name: scenario.name.trim(),
        currency: scenario.currency.trim().toUpperCase()
      };
      await patchSaved([
        ...savedCalculations.filter((item) => item.id !== saved.id),
        saved
      ]);
      scenario = { ...saved };
      message = `Saved “${saved.name}”.`;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Calculation could not be saved.';
    } finally {
      saving = false;
    }
  };

  const loadScenario = (saved: SavedCalculation) => {
    scenario = { ...saved };
    error = '';
    message = `Loaded “${saved.name}”.`;
  };

  const newScenario = () => {
    scenario = blankScenario();
    error = '';
    message = '';
  };

  const deleteScenario = async (saved: SavedCalculation) => {
    if (!confirm(`Delete the saved calculation “${saved.name}”?`)) return;
    error = '';
    try {
      await patchSaved(savedCalculations.filter((item) => item.id !== saved.id));
      if (scenario.id === saved.id) newScenario();
      message = `Deleted “${saved.name}”.`;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Calculation could not be deleted.';
    }
  };

  const setTarget = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    scenario = {
      ...scenario,
      targetAmount: input.value === '' ? null : Number(input.value)
    };
  };

  $: projection = project(scenario);

  onMount(() => {
    void load();
  });
</script>

<main class="page">
  <header>
    <p class="eyebrow">What-if tools</p>
    <h1>Calculations</h1>
    <p class="muted">Project compound growth, recurring contributions, earnings, and the contribution needed to reach a target. Calculations are local planning estimates and never place orders.</p>
  </header>

  {#if error}<div class="alert danger" role="alert">{error}</div>{/if}
  {#if message}<div class="alert mid" role="status">{message}</div>{/if}

  <div class="calculation-layout">
    <section class="panel inputs-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Scenario</p>
          <h2>Growth projection</h2>
        </div>
        <button class="ghost compact" type="button" on:click={newScenario}>New</button>
      </div>

      <div class="input-grid">
        <div class="field span-two">
          <label for="scenario-name">Name</label>
          <input id="scenario-name" maxlength="120" bind:value={scenario.name} />
        </div>
        <div class="field">
          <label for="scenario-start">Start date</label>
          <input id="scenario-start" type="date" bind:value={scenario.startDate} />
        </div>
        <div class="field">
          <label for="scenario-currency">Currency</label>
          <input id="scenario-currency" maxlength="3" pattern="[A-Za-z]{3}" bind:value={scenario.currency} />
        </div>
        <div class="field">
          <label for="scenario-principal">Starting balance</label>
          <input id="scenario-principal" type="number" min="0" step="any" bind:value={scenario.principal} />
        </div>
        <div class="field">
          <label for="scenario-rate">Annual rate (%)</label>
          <input id="scenario-rate" type="number" min="-99.99" max="10000" step="0.01" bind:value={scenario.ratePercent} />
        </div>
        <div class="field">
          <label for="scenario-rate-kind">Rate type</label>
          <select id="scenario-rate-kind" bind:value={scenario.rateKind}>
            <option value="apy">APY · effective annual yield</option>
            <option value="apr">APR · nominal annual rate</option>
          </select>
        </div>
        <div class="field">
          <label for="scenario-frequency">Compounding and contribution frequency</label>
          <select id="scenario-frequency" bind:value={scenario.periodsPerYear}>
            <option value={1}>Yearly</option>
            <option value={12}>Monthly</option>
            <option value={52}>Weekly</option>
            <option value={365}>Daily</option>
          </select>
        </div>
        <div class="field">
          <label for="scenario-duration">Duration</label>
          <input id="scenario-duration" type="number" min="0.01" max="200" step="any" bind:value={scenario.durationValue} />
        </div>
        <div class="field">
          <label for="scenario-duration-unit">Duration unit</label>
          <select id="scenario-duration-unit" bind:value={scenario.durationUnit}>
            <option value="days">Days</option>
            <option value="months">Months</option>
            <option value="years">Years</option>
          </select>
        </div>
        <div class="field">
          <label for="scenario-contribution">Contribution per {contributionInterval()}</label>
          <input id="scenario-contribution" type="number" min="0" step="any" bind:value={scenario.contributionPerPeriod} />
        </div>
        <div class="field">
          <label for="scenario-target">Optional target</label>
          <input
            id="scenario-target"
            type="number"
            min="0"
            step="any"
            value={scenario.targetAmount ?? ''}
            on:input={setTarget}
          />
        </div>
      </div>
      <button type="button" disabled={saving || loading} on:click={saveScenario}>
        {saving ? 'Saving…' : 'Save named calculation'}
      </button>
    </section>

    <section class="panel saved-panel">
      <p class="eyebrow">Saved</p>
      <h2>Named calculations</h2>
      {#if loading}
        <p class="muted">Loading…</p>
      {:else if savedCalculations.length === 0}
        <p class="muted">No saved calculations yet.</p>
      {:else}
        <div class="saved-list">
          {#each savedCalculations as saved (saved.id)}
            <article class="card saved-item">
              <div>
                <strong>{saved.name}</strong>
                <small>{saved.ratePercent}% {saved.rateKind.toUpperCase()} · {saved.durationValue} {saved.durationUnit}</small>
              </div>
              <div class="saved-actions">
                <button class="secondary compact" type="button" on:click={() => loadScenario(saved)}>Load</button>
                <button class="danger compact" type="button" on:click={() => deleteScenario(saved)}>Delete</button>
              </div>
            </article>
          {/each}
        </div>
      {/if}
    </section>
  </div>

  <section class="card-grid result-grid" aria-label="Projection result">
    <article class="card">
      <span class="label">Ending balance</span>
      <strong>{formatMoney(projection.endingBalance)}</strong>
    </article>
    <article class="card">
      <span class="label">Total contributed</span>
      <strong>{formatMoney(projection.totalContributed)}</strong>
    </article>
    <article class="card">
      <span class="label">Projected earnings</span>
      <strong>{formatMoney(projection.earnings)}</strong>
    </article>
    <article class="card">
      <span class="label">Contribution periods</span>
      <strong>{projection.periods.toLocaleString()}</strong>
    </article>
    {#if scenario.targetAmount !== null}
      <article class="card">
        <span class="label">Needed per {contributionInterval()} for target</span>
        <strong>{formatMoney(projection.requiredContribution)}</strong>
      </article>
    {/if}
  </section>

  <PortfolioChart
    title={`${scenario.name || 'Projection'} growth`}
    series={projection.series}
    chartMode="line"
    currency={scenario.currency || primaryCurrency}
    tooltipCurrencies={[scenario.currency || primaryCurrency]}
    source="local calculation"
    {timezone}
    granularity={2_592_000}
    compact
    minimalChrome
    initialRange="all"
    emptyMessage="Enter valid projection values to display the calculation."
  />

  <div class="alert start">
    This calculator assumes a constant rate and contributions at the end of each complete compounding period. It does not model taxes, fees, inflation, rate changes, or market volatility.
  </div>
</main>

<style>
  .calculation-layout {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(17rem, 1fr);
    gap: 1rem;
  }

  .inputs-panel,
  .saved-panel,
  .saved-list {
    display: grid;
    gap: 1rem;
  }

  .section-heading,
  .saved-item,
  .saved-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.7rem;
  }

  .section-heading h2,
  .section-heading p,
  .saved-panel h2,
  .saved-panel p {
    margin: 0;
  }

  .input-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.8rem;
  }

  .span-two {
    grid-column: span 2;
  }

  .saved-item {
    align-items: flex-start;
  }

  .saved-item > div:first-child {
    display: grid;
    gap: 0.2rem;
  }

  .saved-item small {
    color: var(--color-muted);
  }

  .result-grid strong {
    display: block;
    margin-top: 0.35rem;
    font-size: 1.2rem;
  }

  @media (max-width: 55rem) {
    .calculation-layout {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 36rem) {
    .input-grid {
      grid-template-columns: 1fr;
    }

    .span-two {
      grid-column: auto;
    }
  }
</style>
