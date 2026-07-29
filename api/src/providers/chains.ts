import { Decimal } from 'decimal.js';
import type { RuntimeConfig, RuntimeSecrets } from '../config/schema.js';
import type { AddressNetwork } from '../domain/addresses.js';
import { AppError } from '../errors.js';
import { createProviderHttpClient } from './http.js';
import { ProviderRateLimiter } from './rate-limiter.js';

export interface ChainTransactionRecord {
  transactionId: string;
  blockReference: string | null;
  transactionPosition: number | null;
  occurredAtMs: number;
  confirmationState: 'unconfirmed' | 'confirmed' | 'finalized';
  rawSummary: Record<string, unknown>;
  warning: Record<string, unknown> | null;
}

export interface ChainBalanceEvent {
  transactionId: string;
  canonicalAssetId: string;
  occurredAtMs: number;
  orderingKey: string;
  quantityDelta: string;
  feeQuantity: string | null;
  eventType: string;
  finalized: boolean;
  provenance: Record<string, unknown>;
}

export interface ChainHistoryResult {
  transactions: ChainTransactionRecord[];
  events: ChainBalanceEvent[];
  cursor: Record<string, unknown>;
  completeness: 'complete' | 'partial';
  providerBoundary: Record<string, unknown>;
  warnings: Array<Record<string, unknown>>;
}

export interface ChainBalanceObservation {
  canonicalAssetId: string;
  observedAtMs: number;
  quantity: string;
  blockReference: string | null;
  provenance: Record<string, unknown>;
}

export interface ChainCurrentBalanceResult {
  observations: ChainBalanceObservation[];
  providerBoundary: Record<string, unknown>;
  warnings: Array<Record<string, unknown>>;
}

export interface SelectedChainAsset {
  canonicalAssetId: string;
  contractOrMint: string | null;
}

export interface ChainAdapter {
  network: AddressNetwork;
  fetchHistory({
    address,
    selectedAssets,
    cursor
  }: {
    address: string;
    selectedAssets: SelectedChainAsset[];
    cursor: Record<string, unknown>;
  }): Promise<ChainHistoryResult>;
  fetchCurrentBalances?({
    address,
    selectedAssets
  }: {
    address: string;
    selectedAssets: SelectedChainAsset[];
  }): Promise<ChainCurrentBalanceResult>;
  status(): ReturnType<ProviderRateLimiter['getStatus']>;
}

const satsToBtc = ({ satoshis }: { satoshis: number | string }) => new Decimal(satoshis).dividedBy(100_000_000).toString();
const koinuToDoge = ({ koinu }: { koinu: number | string }) => new Decimal(koinu).dividedBy(100_000_000).toString();
const weiToEth = ({ wei }: { wei: number | string }) => new Decimal(wei).dividedBy('1000000000000000000').toString();
const lamportsToSol = ({ lamports }: { lamports: number | string }) => new Decimal(lamports).dividedBy(1_000_000_000).toString();
const hexQuantityToDecimal = ({
  value,
  decimals
}: {
  value: string;
  decimals: number;
}) => new Decimal(BigInt(value).toString()).dividedBy(new Decimal(10).pow(decimals)).toString();

const createBitcoinAdapter = ({
  config
}: {
  config: RuntimeConfig['providers']['chains']['bitcoin'];
}): ChainAdapter => {
  const limiter = new ProviderRateLimiter('bitcoin-esplora', config.rate);
  const client = createProviderHttpClient({
    provider: 'bitcoin-esplora',
    baseUrl: config.baseUrl!,
    limiter,
    allowedPaths: [
      /^\/address\/[^/]+\/txs$/,
      /^\/address\/[^/]+\/txs\/chain\/[^/]+$/,
      /^\/blocks\/tip\/height$/
    ]
  });
  return {
    network: 'bitcoin',
    fetchHistory: async ({ address, cursor }) => {
      const lastSeenTxid = typeof cursor.lastSeenTxid === 'string' ? cursor.lastSeenTxid : null;
      const backfillComplete = cursor.backfillComplete === true;
      const transactionRequest = async ({ path }: { path: string }) => client.json<Array<{
        txid: string;
        status: {
          confirmed: boolean;
          block_height?: number;
          block_time?: number;
        };
        vin: Array<{
          prevout?: {
            scriptpubkey_address?: string;
            value?: number;
          };
        }>;
        vout: Array<{
          scriptpubkey_address?: string;
          value?: number;
        }>;
        fee?: number;
      }>>({ path });
      const [latest, older, tipHeightText] = await Promise.all([
        transactionRequest({ path: `/address/${encodeURIComponent(address)}/txs` }),
        lastSeenTxid && !backfillComplete
          ? transactionRequest({
              path: `/address/${encodeURIComponent(address)}/txs/chain/${encodeURIComponent(lastSeenTxid)}`
            })
          : Promise.resolve([]),
        client.text({ path: '/blocks/tip/height' })
      ]);
      const data = [...new Map([...latest, ...older].map((transaction) => [transaction.txid, transaction])).values()];
      const backfillPage = lastSeenTxid && !backfillComplete ? older : latest;
      const tipHeight = Number(tipHeightText);
      const ordered = data.slice().reverse();
      const transactions: ChainTransactionRecord[] = [];
      const events: ChainBalanceEvent[] = [];
      for (const transaction of ordered) {
        const received = Decimal.sum(0, ...transaction.vout
          .filter((output) => output.scriptpubkey_address === address)
          .map((output) => output.value ?? 0));
        const spent = Decimal.sum(0, ...transaction.vin
          .filter((input) => input.prevout?.scriptpubkey_address === address)
          .map((input) => input.prevout?.value ?? 0));
        const delta = received.minus(spent);
        const occurredAtMs = (transaction.status.block_time ?? Math.floor(Date.now() / 1_000)) * 1_000;
        const confirmations = transaction.status.confirmed && transaction.status.block_height !== undefined
          ? Math.max(0, tipHeight - transaction.status.block_height + 1)
          : 0;
        const finalized = transaction.status.confirmed && confirmations >= config.confirmations;
        transactions.push({
          transactionId: transaction.txid,
          blockReference: transaction.status.block_height ? String(transaction.status.block_height) : null,
          transactionPosition: null,
          occurredAtMs,
          confirmationState: finalized ? 'finalized' : transaction.status.confirmed ? 'confirmed' : 'unconfirmed',
          rawSummary: {
            receivedSats: received.toString(),
            spentSats: spent.toString()
          },
          warning: null
        });
        if (!delta.isZero()) {
          events.push({
            transactionId: transaction.txid,
            canonicalAssetId: 'bitcoin',
            occurredAtMs,
            orderingKey: `${transaction.status.block_height ?? 'unconfirmed'}:${transaction.txid}`,
            quantityDelta: satsToBtc({ satoshis: delta.toString() }),
            feeQuantity: spent.greaterThan(0) && transaction.fee !== undefined
              ? satsToBtc({ satoshis: transaction.fee })
              : null,
            eventType: delta.isPositive() ? 'receive' : 'send',
            finalized,
            provenance: {
              provider: 'esplora',
              transactionId: transaction.txid
            }
          });
        }
      }
      return {
        transactions,
        events,
        cursor: {
          lastSeenTxid: backfillPage.at(-1)?.txid ?? lastSeenTxid,
          backfillComplete: backfillComplete || backfillPage.length < 25
        },
        completeness: backfillComplete || backfillPage.length < 25 ? 'complete' : 'partial',
        providerBoundary: {
          latestPageSize: latest.length,
          backfillPageSize: backfillPage.length,
          tipHeight,
          reachedOldest: backfillComplete || backfillPage.length < 25
        },
        warnings: []
      };
    },
    status: () => limiter.getStatus()
  };
};

const createDogecoinAdapter = ({
  config,
  secrets
}: {
  config: RuntimeConfig['providers']['chains']['dogecoin'];
  secrets: RuntimeSecrets;
}): ChainAdapter => {
  const limiter = new ProviderRateLimiter('dogecoin-blockcypher', config.rate);
  const client = createProviderHttpClient({
    provider: 'dogecoin-blockcypher',
    baseUrl: config.baseUrl!,
    limiter,
    allowedPaths: [/^\/addrs\/[^/]+\/full$/]
  });
  return {
    network: 'dogecoin',
    fetchHistory: async ({ address, cursor }) => {
      const beforeBlock = cursor.backfillComplete === true
        ? undefined
        : typeof cursor.beforeBlock === 'number'
          ? cursor.beforeBlock
          : undefined;
      const response = await client.json<{
        hasMore?: boolean;
        txs?: Array<{
          hash: string;
          block_hash?: string;
          block_height?: number;
          block_index?: number;
          confirmed?: string;
          received?: string;
          confirmations?: number;
          fees?: number;
          inputs?: Array<{ output_value?: number; addresses?: string[] }>;
          outputs?: Array<{ value?: number; addresses?: string[] }>;
        }>;
      }>({
        path: `/addrs/${encodeURIComponent(address)}/full`,
        query: {
          before: beforeBlock,
          limit: 50,
          txlimit: 1_000,
          token: secrets.providers.blockCypherApiToken ?? undefined
        }
      });
      const page = response.txs ?? [];
      const transactions: ChainTransactionRecord[] = [];
      const events: ChainBalanceEvent[] = [];
      for (const transaction of page.slice().reverse()) {
        const received = Decimal.sum(0, ...(transaction.outputs ?? [])
          .filter((output) => output.addresses?.includes(address))
          .map((output) => output.value ?? 0));
        const spent = Decimal.sum(0, ...(transaction.inputs ?? [])
          .filter((input) => input.addresses?.includes(address))
          .map((input) => input.output_value ?? 0));
        const delta = received.minus(spent);
        const occurredAtMs = Date.parse(transaction.confirmed ?? transaction.received ?? '') || Date.now();
        const confirmations = transaction.confirmations ?? 0;
        const finalized = confirmations >= config.confirmations;
        transactions.push({
          transactionId: transaction.hash,
          blockReference: transaction.block_height === undefined ? null : String(transaction.block_height),
          transactionPosition: transaction.block_index ?? null,
          occurredAtMs,
          confirmationState: finalized ? 'finalized' : confirmations > 0 ? 'confirmed' : 'unconfirmed',
          rawSummary: {
            receivedKoinu: received.toString(),
            spentKoinu: spent.toString()
          },
          warning: null
        });
        if (!delta.isZero()) {
          events.push({
            transactionId: transaction.hash,
            canonicalAssetId: 'dogecoin',
            occurredAtMs,
            orderingKey: `${transaction.block_height ?? 'unconfirmed'}:${transaction.block_index ?? 0}:${transaction.hash}`,
            quantityDelta: koinuToDoge({ koinu: delta.toString() }),
            feeQuantity: spent.greaterThan(0) && transaction.fees !== undefined
              ? koinuToDoge({ koinu: transaction.fees })
              : null,
            eventType: delta.isPositive() ? 'receive' : 'send',
            finalized,
            provenance: {
              provider: 'blockcypher',
              transactionId: transaction.hash
            }
          });
        }
      }
      const oldestBlock = page
        .map((transaction) => transaction.block_height)
        .filter((height): height is number => height !== undefined)
        .reduce<number | null>((oldest, height) => oldest === null ? height : Math.min(oldest, height), null);
      const reachedOldest = response.hasMore !== true || oldestBlock === null;
      return {
        transactions,
        events,
        cursor: {
          beforeBlock: oldestBlock,
          backfillComplete: reachedOldest
        },
        completeness: reachedOldest ? 'complete' : 'partial',
        providerBoundary: {
          pageSize: page.length,
          oldestBlock,
          reachedOldest
        },
        warnings: response.hasMore === true && oldestBlock === null
          ? [{ code: 'DOGE_PROVIDER_PAGINATION_BOUNDARY_MISSING' }]
          : []
      };
    },
    status: () => limiter.getStatus()
  };
};

interface EtherscanResponse<T> {
  status: string;
  message: string;
  result: T | string;
}

const createEthereumAdapter = ({
  config,
  secrets
}: {
  config: RuntimeConfig['providers']['chains']['ethereum'];
  secrets: RuntimeSecrets;
}): ChainAdapter => {
  const historyLimiter = new ProviderRateLimiter('ethereum-etherscan', config.rate);
  const historyClient = createProviderHttpClient({
    provider: 'ethereum-etherscan',
    baseUrl: config.baseUrl!,
    limiter: historyLimiter,
    allowedPaths: [new RegExp('^/v2/api$')]
  });
  const rpcLimiter = new ProviderRateLimiter('ethereum-json-rpc', config.rate);
  const rpcClient = config.rpcBaseUrl
    ? createProviderHttpClient({
        provider: 'ethereum-json-rpc',
        baseUrl: config.rpcBaseUrl,
        limiter: rpcLimiter,
        allowedPaths: [/^\/$/]
      })
    : null;
  const historyQuery = async <T>({
    action,
    address,
    page,
    startBlock,
    contractAddress
  }: {
    action: string;
    address: string;
    page: number;
    startBlock: number;
    contractAddress?: string;
  }) => {
    const response = await historyClient.json<EtherscanResponse<T>>({
      path: '/v2/api',
      query: {
        chainid: config.chainId ?? 1,
        module: 'account',
        action,
        address,
        startblock: startBlock,
        endblock: 99_999_999,
        page,
        offset: 1_000,
        sort: 'asc',
        contractaddress: contractAddress,
        apikey: secrets.providers.etherscanApiKey ?? ''
      }
    });
    const noTransactions = response.status === '0'
      && /no transactions found/i.test(`${response.message} ${String(response.result)}`);
    if (response.status !== '1' && !noTransactions) {
      throw new AppError({
        errorKey: 'PROVIDER_RESPONSE_INVALID',
        reason: `Etherscan rejected the read-only ${action} request: ${response.message}.`,
        status: 502,
        context: {
          provider: 'ethereum-etherscan',
          action
        }
      });
    }
    return Array.isArray(response.result) ? response.result : [];
  };
  const rpcQuery = async <T>({
    method,
    parameters
  }: {
    method: 'eth_blockNumber' | 'eth_getBalance' | 'eth_call';
    parameters: unknown[];
  }) => {
    if (!rpcClient) {
      throw new AppError({
        errorKey: 'PROVIDER_REQUEST_FAILED',
        reason: 'Ethereum current-balance JSON-RPC is not configured.',
        status: 503
      });
    }
    const response = await rpcClient.json<{
      jsonrpc?: string;
      result?: T;
      error?: {
        code?: number;
        message?: string;
      };
    }>({
      path: '/',
      method: 'POST',
      jsonBody: {
        jsonrpc: '2.0',
        id: 1,
        method,
        params: parameters
      }
    });
    if (response.error || response.result === undefined) {
      throw new AppError({
        errorKey: 'PROVIDER_RESPONSE_INVALID',
        reason: `Ethereum JSON-RPC rejected the read-only ${method} request.`,
        status: 502,
        context: {
          provider: 'ethereum-json-rpc',
          method,
          rpcCode: response.error?.code,
          rpcMessage: response.error?.message
        }
      });
    }
    return response.result;
  };
  const validatedHexQuantity = ({
    value,
    method
  }: {
    value: string;
    method: string;
  }) => {
    if (!/^0x[0-9a-f]+$/i.test(value)) {
      throw new AppError({
        errorKey: 'PROVIDER_RESPONSE_INVALID',
        reason: `Ethereum JSON-RPC returned an invalid ${method} quantity.`,
        status: 502,
        context: {
          provider: 'ethereum-json-rpc',
          method
        }
      });
    }
    return value;
  };
  return {
    network: 'ethereum',
    fetchCurrentBalances: async ({ address, selectedAssets }) => {
      const blockReference = validatedHexQuantity({
        value: await rpcQuery<string>({
          method: 'eth_blockNumber',
          parameters: []
        }),
        method: 'eth_blockNumber'
      });
      const observedAtMs = Date.now();
      const observations: ChainBalanceObservation[] = [];
      const warnings: Array<Record<string, unknown>> = [];
      for (const asset of selectedAssets) {
        if (!asset.contractOrMint) {
          const balance = validatedHexQuantity({
            value: await rpcQuery<string>({
              method: 'eth_getBalance',
              parameters: [address, blockReference]
            }),
            method: 'eth_getBalance'
          });
          observations.push({
            canonicalAssetId: asset.canonicalAssetId,
            observedAtMs,
            quantity: hexQuantityToDecimal({ value: balance, decimals: 18 }),
            blockReference,
            provenance: {
              provider: 'ethereum-json-rpc',
              method: 'eth_getBalance',
              blockReference
            }
          });
          continue;
        }
        try {
          const contract = asset.contractOrMint.toLowerCase();
          const decimalsHex = validatedHexQuantity({
            value: await rpcQuery<string>({
              method: 'eth_call',
              parameters: [{
                to: contract,
                data: '0x313ce567'
              }, blockReference]
            }),
            method: 'erc20.decimals'
          });
          const decimals = Number(BigInt(decimalsHex));
          if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
            throw new AppError({
              errorKey: 'PROVIDER_RESPONSE_INVALID',
              reason: 'ERC-20 decimals are outside the valid uint8 range.',
              status: 502,
              context: {
                provider: 'ethereum-json-rpc',
                canonicalAssetId: asset.canonicalAssetId
              }
            });
          }
          const balanceHex = validatedHexQuantity({
            value: await rpcQuery<string>({
              method: 'eth_call',
              parameters: [{
                to: contract,
                data: `0x70a08231000000000000000000000000${address.slice(2).toLowerCase()}`
              }, blockReference]
            }),
            method: 'erc20.balanceOf'
          });
          observations.push({
            canonicalAssetId: asset.canonicalAssetId,
            observedAtMs,
            quantity: hexQuantityToDecimal({ value: balanceHex, decimals }),
            blockReference,
            provenance: {
              provider: 'ethereum-json-rpc',
              method: 'eth_call',
              contract,
              decimals,
              blockReference
            }
          });
        } catch (error) {
          warnings.push({
            code: 'ERC20_CURRENT_BALANCE_UNAVAILABLE',
            canonicalAssetId: asset.canonicalAssetId,
            reason: error instanceof Error ? error.message : String(error)
          });
        }
      }
      return {
        observations,
        providerBoundary: {
          currentBalanceProvider: 'ethereum-json-rpc',
          blockReference,
          observedAssetCount: observations.length,
          requestedAssetCount: selectedAssets.length
        },
        warnings
      };
    },
    fetchHistory: async ({ address, selectedAssets, cursor }) => {
      if (!secrets.providers.etherscanApiKey) {
        return {
          transactions: [],
          events: [],
          cursor: {
            ...cursor,
            historyProviderConfigured: false
          },
          completeness: 'partial',
          providerBoundary: {
            historyProvider: 'etherscan',
            historyAvailable: false
          },
          warnings: [{
            code: 'ETHEREUM_HISTORY_PROVIDER_UNAVAILABLE',
            reason: 'Current balances are available, but Etherscan history requires a configured API key.'
          }]
        };
      }
      const page = Number(cursor.page ?? 1);
      const startBlock = Number(cursor.startBlock ?? (cursor.backfillComplete === true ? cursor.newestBlock ?? 0 : 0));
      const selectedTokenAssets = selectedAssets.filter((asset) => asset.contractOrMint);
      const [normal, internal, tokenPages] = await Promise.all([
        historyQuery<Array<Record<string, string>>>({ action: 'txlist', address, page, startBlock }),
        historyQuery<Array<Record<string, string>>>({ action: 'txlistinternal', address, page, startBlock }),
        Promise.all(selectedTokenAssets.map((asset) => historyQuery<Array<Record<string, string>>>({
          action: 'tokentx',
          address,
          page,
          startBlock,
          contractAddress: asset.contractOrMint!
        })))
      ]);
      const tokens = tokenPages.flat();
      const normalized = address.toLowerCase();
      const transactionMap = new Map<string, ChainTransactionRecord>();
      const events: ChainBalanceEvent[] = [];
      const selectedContracts = new Map(
        selectedAssets.filter((asset) => asset.contractOrMint).map((asset) => [
          asset.contractOrMint!.toLowerCase(),
          asset.canonicalAssetId
        ])
      );
      for (const item of normal) {
        const occurredAtMs = Number(item.timeStamp) * 1_000;
        const incoming = item.to?.toLowerCase() === normalized;
        const outgoing = item.from?.toLowerCase() === normalized;
        const value = new Decimal(item.value ?? '0');
        const gasFee = outgoing
          ? new Decimal(item.gasUsed ?? item.gas ?? '0').times(item.gasPrice ?? '0')
          : new Decimal(0);
        const delta = (incoming ? value : new Decimal(0)).minus(outgoing ? value.plus(gasFee) : 0);
        const finalized = item.isError !== '1';
        transactionMap.set(item.hash!, {
          transactionId: item.hash!,
          blockReference: item.blockNumber ?? null,
          transactionPosition: Number(item.transactionIndex ?? 0),
          occurredAtMs,
          confirmationState: finalized ? 'finalized' : 'confirmed',
          rawSummary: {
            from: item.from,
            to: item.to,
            gasUsed: item.gasUsed,
            status: item.txreceipt_status
          },
          warning: item.isError === '1' ? { reason: 'execution_failed' } : null
        });
        if (!delta.isZero()) {
          events.push({
            transactionId: item.hash!,
            canonicalAssetId: 'ethereum',
            occurredAtMs,
            orderingKey: `${item.blockNumber}:${item.transactionIndex}:normal`,
            quantityDelta: weiToEth({ wei: delta.toString() }),
            feeQuantity: outgoing ? weiToEth({ wei: gasFee.toString() }) : null,
            eventType: incoming ? 'receive' : 'send',
            finalized,
            provenance: { provider: 'etherscan', transferType: 'normal' }
          });
        }
      }
      for (const item of internal) {
        const occurredAtMs = Number(item.timeStamp) * 1_000;
        const incoming = item.to?.toLowerCase() === normalized;
        const outgoing = item.from?.toLowerCase() === normalized;
        const value = new Decimal(item.value ?? '0');
        const delta = (incoming ? value : new Decimal(0)).minus(outgoing ? value : 0);
        if (!delta.isZero()) {
          events.push({
            transactionId: item.hash!,
            canonicalAssetId: 'ethereum',
            occurredAtMs,
            orderingKey: `${item.blockNumber}:${item.traceId ?? '0'}:internal`,
            quantityDelta: weiToEth({ wei: delta.toString() }),
            feeQuantity: null,
            eventType: incoming ? 'internal_receive' : 'internal_send',
            finalized: item.isError !== '1',
            provenance: { provider: 'etherscan', transferType: 'internal' }
          });
        }
      }
      for (const item of tokens) {
        const canonicalAssetId = selectedContracts.get((item.contractAddress ?? '').toLowerCase());
        if (!canonicalAssetId) continue;
        const decimals = Number(item.tokenDecimal ?? 0);
        const quantity = new Decimal(item.value ?? '0').dividedBy(new Decimal(10).pow(decimals));
        const incoming = item.to?.toLowerCase() === normalized;
        events.push({
          transactionId: item.hash!,
          canonicalAssetId,
          occurredAtMs: Number(item.timeStamp) * 1_000,
          orderingKey: `${item.blockNumber}:${item.transactionIndex}:${item.logIndex ?? '0'}:erc20`,
          quantityDelta: (incoming ? quantity : quantity.negated()).toString(),
          feeQuantity: null,
          eventType: incoming ? 'token_receive' : 'token_send',
          finalized: true,
          provenance: {
            provider: 'etherscan',
            transferType: 'erc20',
            contract: item.contractAddress,
            tokenSymbol: item.tokenSymbol
          }
        });
      }
      const allRowsAtLimit = [normal, internal, ...tokenPages].some((rows) => rows.length >= 1_000);
      const newestBlock = Math.max(
        Number(cursor.newestBlock ?? 0),
        0,
        ...[...transactionMap.values()].map((transaction) => Number(transaction.blockReference ?? 0))
      );
      return {
        transactions: [...transactionMap.values()],
        events,
        cursor: {
          page: allRowsAtLimit ? page + 1 : 1,
          startBlock: allRowsAtLimit ? startBlock : newestBlock,
          backfillComplete: allRowsAtLimit ? cursor.backfillComplete === true : true,
          newestBlock
        },
        completeness: allRowsAtLimit ? 'partial' : 'complete',
        providerBoundary: {
          pageLimit: 1_000,
          normalCount: normal.length,
          internalCount: internal.length,
          tokenCount: tokens.length,
          selectedTokenCount: selectedTokenAssets.length
        },
        warnings: allRowsAtLimit ? [{ reason: 'provider_page_limit_reached' }] : []
      };
    },
    status: () => rpcClient ? rpcLimiter.getStatus() : historyLimiter.getStatus()
  };
};

const createPolkadotAdapter = ({
  config,
  secrets
}: {
  config: RuntimeConfig['providers']['chains']['polkadot'];
  secrets: RuntimeSecrets;
}): ChainAdapter => {
  const limiter = new ProviderRateLimiter('polkadot-subscan', config.rate);
  const client = createProviderHttpClient({
    provider: 'polkadot-subscan',
    baseUrl: config.baseUrl!,
    limiter,
    allowedPaths: [/^\/api\/v2\/scan\/transfers$/]
  });
  return {
    network: 'polkadot',
    fetchHistory: async ({ address, cursor }) => {
      const page = cursor.backfillComplete === true ? 0 : Number(cursor.page ?? 0);
      const response = await client.json<{
        code?: number;
        message?: string;
        data?: {
          count?: number;
          transfers?: Array<Record<string, unknown>>;
          list?: Array<Record<string, unknown>>;
        };
      }>({
        path: '/api/v2/scan/transfers',
        method: 'POST',
        headers: {
          'X-API-Key': secrets.providers.subscanApiKey!
        },
        jsonBody: {
          address,
          asset_symbol: 'DOT',
          currency: 'token',
          direction: 'all',
          include_total: true,
          order: 'desc',
          page,
          row: 100,
          success: true
        }
      });
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(`Subscan returned ${response.code}: ${response.message ?? 'unknown error'}`);
      }
      const rows = response.data?.transfers ?? response.data?.list ?? [];
      const transactions: ChainTransactionRecord[] = [];
      const events: ChainBalanceEvent[] = [];
      for (const item of rows.slice().reverse()) {
        const sender = String(item.from ?? item.sender ?? '');
        const receiver = String(item.to ?? item.receiver ?? '');
        const asset = String(
          item.asset_symbol
          ?? (typeof item.asset === 'object' && item.asset !== null
            ? (item.asset as Record<string, unknown>).symbol
            : '')
          ?? ''
        ).toUpperCase();
        if (asset && asset !== 'DOT') continue;
        const amount = new Decimal(String(
          item.amount
          ?? (typeof item.asset === 'object' && item.asset !== null
            ? (item.asset as Record<string, unknown>).amount
            : '0')
          ?? '0'
        ));
        const incoming = receiver === address;
        const outgoing = sender === address;
        if (!incoming && !outgoing) continue;
        const transactionId = String(
          item.hash
          ?? item.extrinsic_hash
          ?? item.event_index
          ?? item.extrinsic_index
          ?? ''
        );
        if (!transactionId) continue;
        const blockNumber = Number(item.block_num ?? item.block_number ?? 0);
        const timestampSeconds = Number(item.block_timestamp ?? item.timestamp ?? 0);
        const occurredAtMs = timestampSeconds > 0 ? timestampSeconds * 1_000 : Date.now();
        const finalized = item.finalized !== false;
        transactions.push({
          transactionId,
          blockReference: blockNumber > 0 ? String(blockNumber) : null,
          transactionPosition: null,
          occurredAtMs,
          confirmationState: finalized ? 'finalized' : 'confirmed',
          rawSummary: {
            sender,
            receiver,
            amount: amount.toString(),
            asset: asset || 'DOT'
          },
          warning: null
        });
        events.push({
          transactionId,
          canonicalAssetId: 'polkadot',
          occurredAtMs,
          orderingKey: `${blockNumber}:${String(item.event_index ?? item.extrinsic_index ?? transactionId)}`,
          quantityDelta: (incoming ? amount : amount.negated()).toString(),
          feeQuantity: null,
          eventType: incoming ? 'receive' : 'send',
          finalized,
          provenance: {
            provider: 'subscan',
            eventIndex: item.event_index,
            extrinsicIndex: item.extrinsic_index
          }
        });
      }
      const reachedOldest = rows.length < 100;
      return {
        transactions,
        events,
        cursor: {
          page: reachedOldest ? 0 : page + 1,
          backfillComplete: reachedOldest
        },
        completeness: reachedOldest ? 'complete' : 'partial',
        providerBoundary: {
          page,
          pageSize: rows.length,
          total: response.data?.count ?? null,
          reachedOldest
        },
        warnings: []
      };
    },
    status: () => limiter.getStatus()
  };
};

const createSolanaAdapter = ({
  config,
  secrets
}: {
  config: RuntimeConfig['providers']['chains']['solana'];
  secrets: RuntimeSecrets;
}): ChainAdapter => {
  const limiter = new ProviderRateLimiter('solana-helius', config.rate);
  const client = createProviderHttpClient({
    provider: 'solana-helius',
    baseUrl: config.baseUrl!,
    limiter,
    allowedPaths: [/^\/v0\/addresses\/[^/]+\/transactions$/]
  });
  return {
    network: 'solana',
    fetchHistory: async ({ address, selectedAssets, cursor }) => {
      const before = typeof cursor.before === 'string' ? cursor.before : null;
      const backfillComplete = cursor.backfillComplete === true;
      const requestPage = async ({ before }: { before?: string }) => client.json<Array<Record<string, unknown>>>({
        path: `/v0/addresses/${encodeURIComponent(address)}/transactions`,
        query: {
          'api-key': secrets.providers.heliusApiKey ?? '',
          before,
          limit: 100
        }
      });
      const [latest, older] = await Promise.all([
        requestPage({}),
        before && !backfillComplete ? requestPage({ before }) : Promise.resolve([])
      ]);
      const data = [...new Map([...latest, ...older].map((transaction) => [String(transaction.signature ?? ''), transaction])).values()];
      const backfillPage = before && !backfillComplete ? older : latest;
      const selectedMints = new Map(
        selectedAssets.filter((asset) => asset.contractOrMint).map((asset) => [
          asset.contractOrMint!,
          asset.canonicalAssetId
        ])
      );
      const transactions: ChainTransactionRecord[] = [];
      const events: ChainBalanceEvent[] = [];
      for (const item of data.slice().reverse()) {
        const signature = String(item.signature ?? '');
        const timestamp = Number(item.timestamp ?? Math.floor(Date.now() / 1_000)) * 1_000;
        transactions.push({
          transactionId: signature,
          blockReference: item.slot === undefined ? null : String(item.slot),
          transactionPosition: null,
          occurredAtMs: timestamp,
          confirmationState: 'finalized',
          rawSummary: {
            type: item.type,
            source: item.source,
            description: item.description
          },
          warning: item.transactionError ? { transactionError: item.transactionError } : null
        });
        const accountData = Array.isArray(item.accountData) ? item.accountData as Array<Record<string, unknown>> : [];
        const walletData = accountData.find((entry) => entry.account === address);
        const nativeDelta = Number(walletData?.nativeBalanceChange ?? 0);
        if (nativeDelta !== 0) {
          events.push({
            transactionId: signature,
            canonicalAssetId: 'solana',
            occurredAtMs: timestamp,
            orderingKey: `${item.slot ?? 0}:${signature}:native`,
            quantityDelta: lamportsToSol({ lamports: nativeDelta }),
            feeQuantity: null,
            eventType: nativeDelta > 0 ? 'receive' : 'send',
            finalized: true,
            provenance: { provider: 'helius', transferType: 'native' }
          });
        }
        const tokenTransfers = Array.isArray(item.tokenTransfers) ? item.tokenTransfers as Array<Record<string, unknown>> : [];
        for (const [index, transfer] of tokenTransfers.entries()) {
          const mint = String(transfer.mint ?? '');
          const canonicalAssetId = selectedMints.get(mint);
          if (!canonicalAssetId) continue;
          const incoming = transfer.toUserAccount === address;
          const outgoing = transfer.fromUserAccount === address;
          if (!incoming && !outgoing) continue;
          const quantity = new Decimal(String(transfer.tokenAmount ?? '0'));
          events.push({
            transactionId: signature,
            canonicalAssetId,
            occurredAtMs: timestamp,
            orderingKey: `${item.slot ?? 0}:${signature}:${index}:spl`,
            quantityDelta: (incoming ? quantity : quantity.negated()).toString(),
            feeQuantity: null,
            eventType: incoming ? 'token_receive' : 'token_send',
            finalized: true,
            provenance: {
              provider: 'helius',
              transferType: 'spl',
              mint
            }
          });
        }
      }
      return {
        transactions,
        events,
        cursor: {
          before: backfillPage.at(-1)?.signature ?? before,
          backfillComplete: backfillComplete || backfillPage.length < 100
        },
        completeness: backfillComplete || backfillPage.length < 100 ? 'complete' : 'partial',
        providerBoundary: {
          latestPageSize: latest.length,
          backfillPageSize: backfillPage.length,
          walletLevelHistory: true
        },
        warnings: []
      };
    },
    status: () => limiter.getStatus()
  };
};

export const createChainAdapters = ({
  config,
  secrets
}: {
  config: RuntimeConfig;
  secrets: RuntimeSecrets;
}) => {
  const adapters = new Map<AddressNetwork, ChainAdapter>();
  if (config.providers.chains.bitcoin.enabled) {
    adapters.set('bitcoin', createBitcoinAdapter({
      config: config.providers.chains.bitcoin
    }));
  }
  if (config.providers.chains.dogecoin.enabled) {
    adapters.set('dogecoin', createDogecoinAdapter({
      config: config.providers.chains.dogecoin,
      secrets
    }));
  }
  if (
    config.providers.chains.ethereum.enabled
    && (
      config.providers.chains.ethereum.rpcBaseUrl
      || secrets.providers.etherscanApiKey
    )
  ) {
    adapters.set('ethereum', createEthereumAdapter({
      config: config.providers.chains.ethereum,
      secrets
    }));
  }
  if (config.providers.chains.polkadot.enabled && secrets.providers.subscanApiKey) {
    adapters.set('polkadot', createPolkadotAdapter({
      config: config.providers.chains.polkadot,
      secrets
    }));
  }
  if (config.providers.chains.solana.enabled && secrets.providers.heliusApiKey) {
    adapters.set('solana', createSolanaAdapter({
      config: config.providers.chains.solana,
      secrets
    }));
  }
  return adapters;
};

export const chainProviderInternals = {
  koinuToDoge,
  lamportsToSol,
  satsToBtc,
  weiToEth
};
