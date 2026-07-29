import { spawn } from 'node:child_process';

const nodeOptions = [
  process.env.NODE_OPTIONS,
  '--disable-warning=DEP0060'
].filter(Boolean).join(' ');
const childEnvironment = { ...process.env, NODE_OPTIONS: nodeOptions };

const children = [
  spawn('npm', ['run', 'dev', '--workspace', 'cryptotracker-wui', '--', '--host', '127.0.0.1', '--port', '3000'], {
    stdio: 'inherit',
    env: {
      ...childEnvironment,
      ORIGIN: process.env.CRYPTOTRACKER_PUBLIC_BASE_URL ?? 'http://localhost:8192'
    }
  }),
  spawn('npm', ['run', 'dev', '--workspace', 'cryptotracker-api'], {
    stdio: 'inherit',
    env: childEnvironment
  })
];

let stopping = false;
const stop = ({ code }) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
    process.exit(code);
  }, 10_000).unref();
};

for (const child of children) {
  child.once('exit', (code) => stop({ code: code ?? 1 }));
}
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => stop({ code: 0 }));
}
