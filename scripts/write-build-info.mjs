import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const argument = ({ name, fallback }) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const readText = async ({ path }) => {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return '';
  }
};

const resolveGitDirectory = async ({ worktree }) => {
  const dotGit = resolve(worktree, '.git');
  const text = await readText({ path: dotGit });
  if (text.startsWith('gitdir:')) {
    return resolve(worktree, text.slice('gitdir:'.length).trim());
  }
  return dotGit;
};

const resolveBuildHash = async ({ worktree }) => {
  if (process.env.BUILD_HASH?.trim()) return process.env.BUILD_HASH.trim();
  const gitDirectory = await resolveGitDirectory({ worktree });
  const head = await readText({ path: resolve(gitDirectory, 'HEAD') });
  if (/^[0-9a-f]{40}$/i.test(head)) return head.slice(0, 12);
  if (!head.startsWith('ref:')) return 'unknown';
  const reference = head.slice('ref:'.length).trim();
  const loose = await readText({ path: resolve(gitDirectory, reference) });
  if (/^[0-9a-f]{40}$/i.test(loose)) return loose.slice(0, 12);
  const packed = await readText({ path: resolve(gitDirectory, 'packed-refs') });
  const packedHash = packed.split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('^'))
    .map((line) => line.split(' '))
    .find(([, packedReference]) => packedReference === reference)?.[0];
  return /^[0-9a-f]{40}$/i.test(packedHash ?? '') ? packedHash.slice(0, 12) : 'unknown';
};

const worktree = resolve(argument({ name: '--worktree', fallback: process.cwd() }));
const output = resolve(argument({ name: '--output', fallback: resolve(worktree, 'build-info.json') }));
const packagePath = resolve(worktree, 'package.json');
const packageMetadata = JSON.parse(await readFile(packagePath, 'utf8'));
const buildInfo = {
  version: packageMetadata.version,
  buildHash: await resolveBuildHash({ worktree })
};

await writeFile(output, `${JSON.stringify(buildInfo, null, 2)}\n`, 'utf8');
console.log(`Wrote ${output} (${buildInfo.version}, ${buildInfo.buildHash})`);
