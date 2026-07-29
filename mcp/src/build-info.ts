import { readFile } from 'node:fs/promises';

interface BuildInfo {
  version: string;
  buildHash: string;
}

export const getBuildInfo = async (): Promise<BuildInfo> => {
  const configuredPath = process.env.BUILD_INFO_PATH?.trim();
  if (configuredPath) {
    try {
      const value = JSON.parse(await readFile(configuredPath, 'utf8')) as Partial<BuildInfo>;
      if (value.version && value.buildHash) {
        return {
          version: value.version,
          buildHash: value.buildHash
        };
      }
    } catch {
      // Fall through to package metadata.
    }
  }
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as { version?: string };
  return {
    version: packageJson.version ?? 'unknown',
    buildHash: process.env.BUILD_HASH?.trim() || 'development'
  };
};
