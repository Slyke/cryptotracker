import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { json } from '@sveltejs/kit';
import packageMetadata from '../../../package.json';

const loadBuildInfo = async () => {
  const candidates = [
    process.env.BUILD_INFO_PATH,
    resolve(process.cwd(), 'build-info.json'),
    resolve(process.cwd(), '..', 'build-info.json')
  ].filter((value): value is string => Boolean(value));
  for (const filePath of candidates) {
    try {
      const value = JSON.parse(await readFile(filePath, 'utf8')) as {
        version?: string;
        buildHash?: string;
      };
      if (value.version && value.buildHash) return value;
    } catch {
      continue;
    }
  }
  return {
    version: packageMetadata.version,
    buildHash: process.env.BUILD_HASH ?? 'unknown'
  };
};

export const GET = async () => json({
  ok: true,
  ...await loadBuildInfo()
});
