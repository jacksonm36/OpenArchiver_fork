#!/usr/bin/env node
/**
 * Spawns node with --max-old-space-size from NODE_MAX_OLD_SPACE_MB or auto-detection.
 * Usage: node scripts/run-node-with-heap.mjs <script.js> [args...]
 */
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function detectHeapMb() {
	const detectScript = path.join(__dirname, 'detect-resources.mjs');
	const result = spawnSync(process.execPath, [detectScript, 'heap-mb'], {
		encoding: 'utf8',
	});
	if (result.status === 0 && result.stdout?.trim()) {
		return result.stdout.trim();
	}
	return '1024';
}

const heapMb = process.env.NODE_MAX_OLD_SPACE_MB?.trim() || detectHeapMb();
const target = process.argv[2];

if (!target) {
	console.error('Usage: run-node-with-heap.mjs <script.js> [args...]');
	process.exit(1);
}

const nodeArgs = [`--max-old-space-size=${heapMb}`, target, ...process.argv.slice(3)];
const result = spawnSync(process.execPath, nodeArgs, {
	stdio: 'inherit',
	env: process.env,
});

process.exit(result.status ?? 1);
