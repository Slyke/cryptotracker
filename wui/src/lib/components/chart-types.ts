export interface ChartPoint {
  timestampMs: number;
  value?: string | null;
  rawValue?: string | null;
  normalizedPercent?: string | null;
  open?: string | null;
  high?: string | null;
  low?: string | null;
  close?: string | null;
  volume?: string | null;
  status?: string | null;
  disputed?: boolean;
  providers?: string[];
  coveragePercent?: string;
  quotes?: Record<string, string | null>;
  quantities?: Record<string, string>;
  denominations?: Record<string, string | null>;
  contributingValues?: Record<string, string>;
  [key: string]: unknown;
}

export interface ChartSeries {
  id: string;
  label: string;
  points: ChartPoint[];
}

export interface ChartDenominationOption {
  id: string;
  symbol: string;
  label: string;
}

export interface ChartEvent {
  id: string;
  category: string;
  timestampMs: number;
  asset?: string;
  quantity?: string;
  source?: string;
  reconciliationState?: string;
  details?: Record<string, unknown>;
}
