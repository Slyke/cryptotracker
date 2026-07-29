import { readFile } from 'node:fs/promises';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, entry, index, all) => {
    if (!entry.startsWith('--')) return pairs;
    pairs.push([entry.slice(2), all[index + 1]]);
    return pairs;
  }, [])
);

if (args.action !== 'validate' || !args['error-file']) {
  console.error('Usage: --action validate --error-file PATH');
  process.exitCode = 2;
} else {
  const values = JSON.parse(await readFile(args['error-file'], 'utf8'));
  const codes = new Set();
  for (const [key, code] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]+$/.test(key) || typeof code !== 'string' || codes.has(code)) {
      throw new Error(`Invalid or duplicate error entry: ${key}`);
    }
    codes.add(code);
  }
  console.log(`Validated ${Object.keys(values).length} unique error entries.`);
}
