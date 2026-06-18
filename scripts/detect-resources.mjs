#!/usr/bin/env node
/**
 * Standalone resource detector for docker-entrypoint (no build step required).
 * @see scripts/lib/system-capacity-core.mjs
 */
import {
	computeAutoHeapMb,
	detectSystemCapacity,
} from './lib/system-capacity-core.mjs';

const mode = process.argv[2] || 'heap-mb';
const capacity = detectSystemCapacity();

if (mode === 'heap-mb') {
	process.stdout.write(String(computeAutoHeapMb(capacity.effectiveMemGb)));
} else if (mode === 'json') {
	process.stdout.write(
		JSON.stringify({
			...capacity,
			heapMb: computeAutoHeapMb(capacity.effectiveMemGb),
		})
	);
} else {
	process.stderr.write(`Unknown mode: ${mode}\n`);
	process.exit(1);
}
