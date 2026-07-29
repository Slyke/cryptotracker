import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageMetadata from '../package.json' with { type: 'json' };

export interface BuildInfo {
  version: string;
  buildHash: string;
}

let cachedBuildInfo: BuildInfo | null = null;

const parseBuildInfo = ({ value }: { value: unknown }): BuildInfo | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const version = typeof record.version === 'string' ? record.version.trim() : '';
  const buildHash = typeof record.buildHash === 'string' ? record.buildHash.trim() : '';
  return version && buildHash ? { version, buildHash } : null;
};

export const getBuildInfo = async (): Promise<BuildInfo> => {
  if (cachedBuildInfo) return cachedBuildInfo;

  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.BUILD_INFO_PATH,
    resolve(process.cwd(), 'build-info.json'),
    join(moduleDirectory, '..', '..', 'build-info.json'),
    join(moduleDirectory, '..', 'build-info.json')
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const filePath of candidates) {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
      const buildInfo = parseBuildInfo({ value: parsed });
      if (buildInfo) {
        cachedBuildInfo = buildInfo;
        return buildInfo;
      }
    } catch {
      continue;
    }
  }

  cachedBuildInfo = {
    version: packageMetadata.version,
    buildHash: process.env.BUILD_HASH?.trim() || 'unknown'
  };
  return cachedBuildInfo;
};

export const resetBuildInfoForTests = () => {
  cachedBuildInfo = null;
};
