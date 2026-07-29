import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const workspaceDirectories = [
  '/workspace/node_modules',
  '/workspace/api/node_modules',
  '/workspace/wui/node_modules'
];
const markerName = '.cryptotracker-package-lock.sha256';
const packageLock = await readFile('/workspace/package-lock.json');
const packageLockHash = createHash('sha256').update(packageLock).digest('hex');

const markerMatches = async (directory) => {
  try {
    return (await readFile(`${directory}/${markerName}`, 'utf8')).trim() === packageLockHash;
  } catch {
    return false;
  }
};

const markersCurrent = (
  await Promise.all(workspaceDirectories.map(markerMatches))
).every(Boolean);

if (!markersCurrent) {
  console.log('Development dependency volumes are stale; synchronizing package-lock.json.');
  const exitCode = await new Promise((resolve, reject) => {
    const install = spawn('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: '/workspace',
      env: process.env,
      stdio: 'inherit'
    });
    install.once('error', reject);
    install.once('exit', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    console.error(`Development dependency synchronization failed with exit code ${exitCode}.`);
    process.exit(exitCode);
  }
  for (const directory of workspaceDirectories) {
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/${markerName}`, `${packageLockHash}\n`, 'utf8');
  }
}

await import('./dev-launcher.mjs');
