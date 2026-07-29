import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = process.cwd();
const nodeOptions = [
  process.env.NODE_OPTIONS,
  '--disable-warning=DEP0060'
].filter(Boolean).join(' ');
const children = new Map();
let shuttingDown = false;
let requestedExitCode = 0;

const startChild = ({ name, entry, env = {} }) => {
  const child = spawn(process.execPath, [resolve(root, entry)], {
    cwd: root,
    env: {
      ...process.env,
      ...env
    },
    stdio: 'inherit'
  });
  children.set(name, child);
  child.once('exit', (code, signal) => {
    children.delete(name);
    if (shuttingDown) return;
    requestedExitCode = code ?? (signal ? 1 : 0);
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      caller: 'launcher::childExit',
      loggerKey: 'REQUIRED_CHILD_EXITED',
      message: `Required ${name} process exited unexpectedly.`,
      context: {
        code,
        signal
      }
    }));
    void shutdown({ signal: 'SIGTERM', exitCode: requestedExitCode || 1 });
  });
  child.once('error', (error) => {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      caller: 'launcher::childError',
      loggerKey: 'REQUIRED_CHILD_START_FAILED',
      message: `Required ${name} process failed to start.`,
      rootCause: {
        name: error.name,
        message: error.message
      }
    }));
    void shutdown({ signal: 'SIGTERM', exitCode: 1 });
  });
  return child;
};

const shutdown = async ({ signal, exitCode }) => {
  if (shuttingDown) return;
  shuttingDown = true;
  requestedExitCode = exitCode;
  for (const child of children.values()) {
    child.kill(signal);
  }
  const deadline = setTimeout(() => {
    for (const child of children.values()) {
      child.kill('SIGKILL');
    }
  }, 10_000);
  deadline.unref();
  await Promise.all([...children.values()].map((child) => new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit();
      return;
    }
    child.once('exit', () => resolveExit());
  })));
  clearTimeout(deadline);
  process.exit(requestedExitCode);
};

startChild({
  name: 'wui',
  entry: 'wui/build/index.js',
  env: {
    HOST: process.env.CRYPTOTRACKER_WUI_HOST ?? '127.0.0.1',
    PORT: process.env.CRYPTOTRACKER_WUI_PORT ?? '3000',
    ORIGIN: process.env.CRYPTOTRACKER_PUBLIC_BASE_URL ?? 'http://localhost:8192',
    BUILD_INFO_PATH: process.env.BUILD_INFO_PATH ?? resolve(root, 'build-info.json')
  }
});
startChild({
  name: 'api',
  entry: 'api/dist/index.js',
  env: {
    BUILD_INFO_PATH: process.env.BUILD_INFO_PATH ?? resolve(root, 'build-info.json'),
    NODE_OPTIONS: nodeOptions
  }
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => void shutdown({ signal, exitCode: 0 }));
}
