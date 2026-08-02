import { z } from 'zod';

const urlSchema = z.string().url();
const nullableSecretSchema = z.string().nullable().default(null);
const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
const logFormatSchema = z.enum(['text', 'json']);
const providerRateSchema = z.object({
  minimumSpacingMs: z.number().int().min(0).default(1_250),
  concurrency: z.number().int().min(1).max(16).default(1),
  burst: z.number().int().min(1).max(100).default(2),
  refillPerSecond: z.number().positive().max(100).default(0.8),
  requestTimeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
  maxRetries: z.number().int().min(0).max(10).default(3),
  baseBackoffMs: z.number().int().positive().default(1_000),
  cooldownThreshold: z.number().int().positive().default(3),
  cooldownMs: z.number().int().positive().default(60_000)
});

const logSinkBaseSchema = z.object({
  enabled: z.boolean().default(false),
  format: logFormatSchema.default('json'),
  levels: z.array(logLevelSchema).default([])
});

const loggingSchema = z.object({
  logTextFormat: z.string().default('[{$timestamp}] {$level} {$caller} {$message}'),
  sinks: z.object({
    console: logSinkBaseSchema.extend({
      enabled: z.boolean().default(true),
      format: logFormatSchema.default('text')
    }).prefault({
      enabled: true,
      format: 'text',
      levels: []
    }),
    file: logSinkBaseSchema.extend({
      path: z.string().min(1).nullable().default(null)
    }).prefault({
      enabled: false,
      format: 'json',
      levels: ['warn', 'error'],
      path: null
    }),
    http: logSinkBaseSchema.extend({
      url: urlSchema.nullable().default(null),
      method: z.string().min(1).default('POST'),
      timeoutMs: z.number().int().positive().default(2_500),
      headers: z.record(z.string(), z.string()).default({})
    }).prefault({
      enabled: false,
      format: 'json',
      levels: ['error'],
      url: null,
      method: 'POST',
      timeoutMs: 2_500,
      headers: {}
    }),
    syslog: logSinkBaseSchema.extend({
      protocol: z.enum(['udp', 'tcp', 'tls']).default('udp'),
      host: z.string().min(1).default('localhost'),
      port: z.number().int().positive().default(514),
      facility: z.string().min(1).default('local0'),
      appName: z.string().min(1).default('cryptotracker'),
      hostname: z.string().default(''),
      timeoutMs: z.number().int().positive().default(2_500)
    }).prefault({
      enabled: false,
      format: 'json',
      levels: ['warn', 'error'],
      protocol: 'udp',
      host: 'localhost',
      port: 514,
      facility: 'local0',
      appName: 'cryptotracker',
      hostname: '',
      timeoutMs: 2_500
    })
  }).prefault({
    console: {
      enabled: true,
      format: 'text',
      levels: []
    },
    file: {
      enabled: false,
      format: 'json',
      levels: ['warn', 'error'],
      path: null
    },
    http: {
      enabled: false,
      format: 'json',
      levels: ['error'],
      url: null,
      method: 'POST',
      timeoutMs: 2_500,
      headers: {}
    },
    syslog: {
      enabled: false,
      format: 'json',
      levels: ['warn', 'error'],
      protocol: 'udp',
      host: 'localhost',
      port: 514,
      facility: 'local0',
      appName: 'cryptotracker',
      hostname: '',
      timeoutMs: 2_500
    }
  }),
  gates: z.record(z.string(), z.object({
    enabled: z.boolean().default(true),
    level: logLevelSchema.optional(),
    console: z.boolean().optional(),
    file: z.boolean().optional(),
    http: z.boolean().optional(),
    syslog: z.boolean().optional()
  })).default({}),
  kubernetes: z.object({
    enabled: z.boolean().default(false)
  }).prefault({
    enabled: false
  })
}).superRefine((value, context) => {
  if (value.sinks.file.enabled && !value.sinks.file.path) {
    context.addIssue({
      code: 'custom',
      path: ['sinks', 'file', 'path'],
      message: 'logging.sinks.file.path is required when the file sink is enabled.'
    });
  }

  if (value.sinks.http.enabled && !value.sinks.http.url) {
    context.addIssue({
      code: 'custom',
      path: ['sinks', 'http', 'url'],
      message: 'logging.sinks.http.url is required when the HTTP sink is enabled.'
    });
  }
});

const marketProviderSchema = z.object({
  enabled: z.boolean().default(true),
  baseUrl: urlSchema,
  rate: providerRateSchema.prefault({})
});

const coinGeckoRateSchema = providerRateSchema.extend({
  minimumSpacingMs: z.number().int().min(0).default(6_000),
  burst: z.number().int().min(1).max(100).default(1),
  refillPerSecond: z.number().positive().max(100).default(1 / 6)
});

const coinGeckoProviderSchema = marketProviderSchema.extend({
  rate: coinGeckoRateSchema.prefault({})
});

const chainProviderSchema = z.object({
  enabled: z.boolean().default(true),
  provider: z.string().min(1),
  baseUrl: urlSchema.nullable().default(null),
  chainId: z.number().int().positive().optional(),
  cluster: z.string().min(1).optional(),
  confirmations: z.number().int().min(0).default(6),
  rate: providerRateSchema.prefault({})
});

const ethereumProviderSchema = chainProviderSchema.extend({
  rpcBaseUrl: urlSchema.nullable().default('https://ethereum-rpc.publicnode.com')
});

const configBaseSchema = z.object({
  appName: z.string().min(1).default('CryptoTracker'),
  publicBaseUrl: urlSchema.default('http://localhost:8192'),
  api: z.object({
    host: z.string().min(1).default('0.0.0.0'),
    port: z.number().int().positive().max(65_535).default(8_192),
    trustProxy: z.boolean().default(false),
    bodyLimit: z.string().min(1).default('256kb'),
    https: z.object({
      enabled: z.boolean().default(false),
      port: z.number().int().positive().max(65_535).default(8_194),
      certPath: z.string().min(1).default('./data/certs/server.crt'),
      keyPath: z.string().min(1).default('./data/certs/server.key'),
      generateSelfSigned: z.boolean().default(true)
    }).prefault({
      enabled: false,
      port: 8_194,
      certPath: './data/certs/server.crt',
      keyPath: './data/certs/server.key',
      generateSelfSigned: true
    })
  }).prefault({
    host: '0.0.0.0',
    port: 8_192,
    trustProxy: false,
    bodyLimit: '256kb',
    https: {
      enabled: false,
      port: 8_194,
      certPath: './data/certs/server.crt',
      keyPath: './data/certs/server.key',
      generateSelfSigned: true
    }
  }),
  wui: z.object({
    upstreamBaseUrl: urlSchema.default('http://127.0.0.1:3000'),
    healthPath: z.string().startsWith('/').default('/wui-health'),
    timeoutMs: z.number().int().positive().default(10_000)
  }).prefault({
    upstreamBaseUrl: 'http://127.0.0.1:3000',
    healthPath: '/wui-health',
    timeoutMs: 10_000
  }),
  ui: z.object({
    locale: z.string().min(2).default('en-CA'),
    timezone: z.string().min(1).default('America/Vancouver'),
    defaultTheme: z.enum(['dark', 'light']).default('dark'),
    defaultFont: z.string().min(1).default('ui-mono'),
    defaultContentWidth: z.enum(['min', '1080', 'standard', '1440', '1920', 'full']).default('standard'),
    defaultPrimaryCurrency: z.string().length(3).transform((value) => value.toUpperCase()).default('CAD'),
    defaultTooltipCurrencies: z.array(z.string().length(3).transform((value) => value.toUpperCase())).min(1).max(5).default(['CAD']),
    defaultMarketSource: z.enum(['combined', 'coingecko', 'coinbase', 'kraken']).default('combined'),
    defaultProviderDisagreementThresholdPercent: z.number().min(0).max(1_000).default(5),
    defaultWatchedAssets: z.array(z.string().min(1)).default(['bitcoin']),
    defaultCostBasisMethod: z.enum(['acb', 'fifo', 'lifo']).default('acb')
  }).prefault({
    locale: 'en-CA',
    timezone: 'America/Vancouver',
    defaultTheme: 'dark',
    defaultFont: 'ui-mono',
    defaultContentWidth: 'standard',
    defaultPrimaryCurrency: 'CAD',
    defaultTooltipCurrencies: ['CAD'],
    defaultMarketSource: 'combined',
    defaultProviderDisagreementThresholdPercent: 5,
    defaultWatchedAssets: ['bitcoin'],
    defaultCostBasisMethod: 'acb'
  }),
  auth: z.object({
    apiKey: z.object({
      enabled: z.boolean().default(false),
      headerName: z.string()
        .regex(/^[A-Za-z0-9-]+$/, 'API key header name must be a valid HTTP header token.')
        .refine(
          (name) => !['authorization', 'cookie', 'set-cookie'].includes(name.toLowerCase()),
          'Use a dedicated API key header name; Authorization remains reserved for Bearer authentication.'
        )
        .default('X-API-Key')
    }).prefault({
      enabled: false,
      headerName: 'X-API-Key'
    }),
    local: z.object({
      enabled: z.boolean().default(true),
      username: z.string().min(1).default('admin'),
      sessionTtlMinutes: z.number().int().positive().default(1_440)
    }).prefault({
      enabled: true,
      username: 'admin',
      sessionTtlMinutes: 1_440
    }),
    header: z.object({
      enabled: z.boolean().default(false),
      trustedCidrs: z.array(z.string().min(1)).default(['127.0.0.1/32', '::1/128']),
      usernameHeader: z.string().min(1).default('Remote-User'),
      groupsHeader: z.string().min(1).default('Remote-Groups'),
      groupsSeparator: z.string().min(1).default(','),
      allowedUsers: z.array(z.string().min(1)).default([]),
      allowedGroups: z.array(z.string().min(1)).default([]),
      signedIdentity: z.object({
        enabled: z.boolean().default(false),
        headerName: z.string().min(1).default('X-Oauth-Identity'),
        issuer: z.string().min(1).nullable().default(null),
        audience: z.string().min(1).nullable().default(null),
        clockSkewSeconds: z.number().int().min(0).max(300).default(30),
        maxTokenTtlSeconds: z.number().int().min(60).max(31_536_000).default(31_536_000)
      }).prefault({
        enabled: false,
        headerName: 'X-Oauth-Identity',
        issuer: null,
        audience: null,
        clockSkewSeconds: 30,
        maxTokenTtlSeconds: 31_536_000
      })
    }).prefault({
      enabled: false,
      trustedCidrs: ['127.0.0.1/32', '::1/128'],
      usernameHeader: 'Remote-User',
      groupsHeader: 'Remote-Groups',
      groupsSeparator: ',',
      allowedUsers: [],
      allowedGroups: [],
      signedIdentity: {
        enabled: false,
        headerName: 'X-Oauth-Identity',
        issuer: null,
        audience: null,
        clockSkewSeconds: 30,
        maxTokenTtlSeconds: 31_536_000
      }
    })
  }).prefault({
    apiKey: {
      enabled: false,
      headerName: 'X-API-Key'
    },
    local: {
      enabled: true,
      username: 'admin',
      sessionTtlMinutes: 1_440
    },
    header: {
      enabled: false,
      trustedCidrs: ['127.0.0.1/32', '::1/128'],
      usernameHeader: 'Remote-User',
      groupsHeader: 'Remote-Groups',
      groupsSeparator: ',',
      allowedUsers: [],
      allowedGroups: [],
      signedIdentity: {
        enabled: false,
        headerName: 'X-Oauth-Identity',
        issuer: null,
        audience: null,
        clockSkewSeconds: 30,
        maxTokenTtlSeconds: 31_536_000
      }
    }
  }),
  database: z.object({
    sqlite: z.object({
      busyTimeoutMs: z.number().int().positive().default(5_000),
      synchronous: z.enum(['OFF', 'NORMAL', 'FULL', 'EXTRA']).default('FULL')
    }).prefault({
      busyTimeoutMs: 5_000,
      synchronous: 'FULL'
    }),
    postgres: z.object({
      host: z.string().min(1),
      port: z.number().int().positive().default(5_432),
      database: z.string().min(1),
      user: z.string().min(1),
      poolMax: z.number().int().positive().max(100).default(10),
      ssl: z.boolean().default(false),
      rejectUnauthorized: z.boolean().default(true)
    }).nullable().default(null)
  }).prefault({
    sqlite: {
      busyTimeoutMs: 5_000,
      synchronous: 'FULL'
    },
    postgres: null
  }),
  cache: z.object({
    redis: z.object({
      enabled: z.boolean().default(false),
      url: urlSchema.default('redis://redis:6379'),
      keyPrefix: z.string().regex(/^[A-Za-z0-9:_-]+$/).default('cryptotracker'),
      resultTtlSeconds: z.number().int().min(300).max(31_536_000).default(2_592_000),
      connectTimeoutMs: z.number().int().min(100).max(60_000).default(2_000)
    }).prefault({
      enabled: false,
      url: 'redis://redis:6379',
      keyPrefix: 'cryptotracker',
      resultTtlSeconds: 2_592_000,
      connectTimeoutMs: 2_000
    })
  }).prefault({
    redis: {
      enabled: false,
      url: 'redis://redis:6379',
      keyPrefix: 'cryptotracker',
      resultTtlSeconds: 2_592_000,
      connectTimeoutMs: 2_000
    }
  }),
  providers: z.object({
    market: z.object({
      coinGecko: coinGeckoProviderSchema.prefault({
        enabled: true,
        baseUrl: 'https://api.coingecko.com/api/v3',
        rate: {}
      }),
      coinbase: marketProviderSchema.prefault({
        enabled: true,
        baseUrl: 'https://api.exchange.coinbase.com',
        rate: {}
      }),
      kraken: marketProviderSchema.prefault({
        enabled: true,
        baseUrl: 'https://api.kraken.com',
        rate: {}
      })
    }).prefault({
      coinGecko: {
        enabled: true,
        baseUrl: 'https://api.coingecko.com/api/v3',
        rate: {}
      },
      coinbase: {
        enabled: true,
        baseUrl: 'https://api.exchange.coinbase.com',
        rate: {}
      },
      kraken: {
        enabled: true,
        baseUrl: 'https://api.kraken.com',
        rate: {}
      }
    }),
    chains: z.object({
      bitcoin: chainProviderSchema.prefault({
        enabled: true,
        provider: 'esplora',
        baseUrl: 'https://blockstream.info/api',
        confirmations: 6,
        rate: {}
      }),
      dogecoin: chainProviderSchema.prefault({
        enabled: true,
        provider: 'blockcypher',
        baseUrl: 'https://api.blockcypher.com/v1/doge/main',
        confirmations: 6,
        rate: {}
      }),
      ethereum: ethereumProviderSchema.prefault({
        enabled: true,
        provider: 'etherscan',
        baseUrl: 'https://api.etherscan.io',
        rpcBaseUrl: 'https://ethereum-rpc.publicnode.com',
        chainId: 1,
        confirmations: 12,
        rate: {}
      }),
      polkadot: chainProviderSchema.prefault({
        enabled: true,
        provider: 'subscan',
        baseUrl: 'https://polkadot.api.subscan.io',
        confirmations: 0,
        rate: {}
      }),
      solana: chainProviderSchema.prefault({
        enabled: true,
        provider: 'helius',
        baseUrl: 'https://api.helius.xyz',
        cluster: 'mainnet-beta',
        confirmations: 0,
        rate: {}
      })
    }).prefault({
      bitcoin: {
        enabled: true,
        provider: 'esplora',
        baseUrl: 'https://blockstream.info/api',
        confirmations: 6,
        rate: {}
      },
      dogecoin: {
        enabled: true,
        provider: 'blockcypher',
        baseUrl: 'https://api.blockcypher.com/v1/doge/main',
        confirmations: 6,
        rate: {}
      },
      ethereum: {
        enabled: true,
        provider: 'etherscan',
        baseUrl: 'https://api.etherscan.io',
        rpcBaseUrl: 'https://ethereum-rpc.publicnode.com',
        chainId: 1,
        confirmations: 12,
        rate: {}
      },
      polkadot: {
        enabled: true,
        provider: 'subscan',
        baseUrl: 'https://polkadot.api.subscan.io',
        confirmations: 0,
        rate: {}
      },
      solana: {
        enabled: true,
        provider: 'helius',
        baseUrl: 'https://api.helius.xyz',
        cluster: 'mainnet-beta',
        confirmations: 0,
        rate: {}
      }
    })
  }).prefault({
    market: {
      coinGecko: {
        enabled: true,
        baseUrl: 'https://api.coingecko.com/api/v3',
        rate: {}
      },
      coinbase: {
        enabled: true,
        baseUrl: 'https://api.exchange.coinbase.com',
        rate: {}
      },
      kraken: {
        enabled: true,
        baseUrl: 'https://api.kraken.com',
        rate: {}
      }
    },
    chains: {
      bitcoin: {
        enabled: true,
        provider: 'esplora',
        baseUrl: 'https://blockstream.info/api',
        confirmations: 6,
        rate: {}
      },
      dogecoin: {
        enabled: true,
        provider: 'blockcypher',
        baseUrl: 'https://api.blockcypher.com/v1/doge/main',
        confirmations: 6,
        rate: {}
      },
      ethereum: {
        enabled: true,
        provider: 'etherscan',
        baseUrl: 'https://api.etherscan.io',
        rpcBaseUrl: 'https://ethereum-rpc.publicnode.com',
        chainId: 1,
        confirmations: 12,
        rate: {}
      },
      polkadot: {
        enabled: true,
        provider: 'subscan',
        baseUrl: 'https://polkadot.api.subscan.io',
        confirmations: 0,
        rate: {}
      },
      solana: {
        enabled: true,
        provider: 'helius',
        baseUrl: 'https://api.helius.xyz',
        cluster: 'mainnet-beta',
        confirmations: 0,
        rate: {}
      }
    }
  }),
  sync: z.object({
    pollMinutes: z.number().int().positive().default(30),
    maxConcurrentJobs: z.number().int().min(1).max(16).default(2),
    staleAfterMinutes: z.number().int().positive().default(90),
    overlapBuckets: z.number().int().min(1).max(100).default(3)
  }).prefault({
    pollMinutes: 30,
    maxConcurrentJobs: 2,
    staleAfterMinutes: 90,
    overlapBuckets: 3
  }),
  exports: z.object({
    directory: z.string().min(1).default('/app/data/exports'),
    artifactTtlHours: z.number().int().positive().default(24),
    restoreBodyLimit: z.string().min(1).max(32).default('128mb'),
    restoreMaxUncompressedBytes: z.number().int().positive().default(512 * 1024 * 1024)
  }).prefault({
    directory: '/app/data/exports',
    artifactTtlHours: 24,
    restoreBodyLimit: '128mb',
    restoreMaxUncompressedBytes: 512 * 1024 * 1024
  }),
  logging: loggingSchema.prefault({})
});

export const configSchema = configBaseSchema.superRefine((value, context) => {
  if (value.api.https.enabled && value.api.https.port === value.api.port) {
    context.addIssue({
      code: 'custom',
      path: ['api', 'https', 'port'],
      message: 'The API HTTPS port must differ from the HTTP application port.'
    });
  }
  const header = value.auth.header;
  if (header.enabled) {
    if (header.trustedCidrs.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['auth', 'header', 'trustedCidrs'],
        message: 'Trusted-header auth requires at least one direct-peer CIDR.'
      });
    }

    if (header.allowedUsers.length === 0 && header.allowedGroups.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['auth', 'header'],
        message: 'Trusted-header auth requires an allowed user or allowed group.'
      });
    }

    if (
      header.signedIdentity.enabled
      && (!header.signedIdentity.issuer || !header.signedIdentity.audience)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['auth', 'header', 'signedIdentity'],
        message: 'Signed identity requires issuer and audience.'
      });
    }
  }
});

export const secretsSchema = z.object({
  sessionSecret: nullableSecretSchema,
  localPassword: nullableSecretSchema,
  signedIdentitySecret: nullableSecretSchema,
  providers: z.object({
    coinGeckoApiKey: nullableSecretSchema,
    blockCypherApiToken: nullableSecretSchema,
    etherscanApiKey: nullableSecretSchema,
    heliusApiKey: nullableSecretSchema,
    subscanApiKey: nullableSecretSchema
  }).prefault({
    coinGeckoApiKey: null,
    blockCypherApiToken: null,
    etherscanApiKey: null,
    heliusApiKey: null,
    subscanApiKey: null
  }),
  kraken: z.object({
    apiKey: nullableSecretSchema,
    apiSecret: nullableSecretSchema
  }).prefault({
    apiKey: null,
    apiSecret: null
  }),
  apiKeys: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    key: z.string().min(16),
    role: z.enum(['read', 'readwrite']).default('read')
  })).max(100).refine(
    (entries) => new Set(entries.map((entry) => entry.name.toLowerCase())).size === entries.length,
    { message: 'API key names must be unique.' }
  ).default([]),
  postgresPassword: nullableSecretSchema,
  redisPassword: nullableSecretSchema
});

export type RuntimeConfig = z.infer<typeof configSchema>;
export type RuntimeSecrets = z.infer<typeof secretsSchema>;
export type ProviderRateConfig = z.infer<typeof providerRateSchema>;
