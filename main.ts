// swift-site-generator: the harness driver.
//
// Reads every case from /input/cases.json, answers each one with solve.js's
// run (the fast drop-in for makefun-site 1.0.0), and writes the answers, in
// the cases' order, to /output/answers.json.
//
// V8's incremental marking is turned off before solve.js is imported, the
// same tuning the house baseline uses: the builds here are short and bursty,
// and one less background marker keeps the measured CPU time on the work.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

async function main(): Promise<void> {
  const { run } = await import('./solve.js');
  const cases = JSON.parse(readFileSync('/input/cases.json', 'utf8')) as { id: string; input: unknown }[];
  const answers = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) answers[i] = run(cases[i].input);
  mkdirSync('/output', { recursive: true });
  writeFileSync('/output/answers.json', JSON.stringify(answers));
}

void main();

