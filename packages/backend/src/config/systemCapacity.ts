import { createRequire } from 'module';
import os from 'os';
import path from 'path';

export type CapacityLimitSource = 'host' | 'cgroup' | 'meminfo';
export type CpuLimitSource = 'host' | 'cgroup' | 'cpuset';

export type VirtualizationType =
	| 'bare-metal'
	| 'docker'
	| 'podman'
	| 'lxc'
	| 'lxd'
	| 'systemd-nspawn'
	| 'kubernetes'
	| 'qemu-kvm'
	| 'hyper-v'
	| 'vmware'
	| 'xen'
	| 'unknown-vm';

export interface SystemCapacity {
	hostMemGb: number;
	hostCpus: number;
	effectiveMemGb: number;
	effectiveCpus: number;
	memLimitSource: CapacityLimitSource;
	cpuLimitSource: CpuLimitSource;
	cgroupMemLimited: boolean;
	cgroupCpuLimited: boolean;
	virtualization: VirtualizationType;
	virtualizationDetail: string | null;
}

type CoreModule = {
	detectSystemCapacity: () => SystemCapacity;
	readCgroupMemoryLimitBytes: () => number | null;
	readCgroupCpuQuotaCount: () => number | null;
};

let coreModule: CoreModule | null = null;

function roundGb(bytes: number): number {
	return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

function loadCore(): CoreModule {
	if (coreModule) {
		return coreModule;
	}

	const require = createRequire(__filename);
	const candidates = [
		path.resolve(__dirname, '../../../../scripts/lib/system-capacity-core.mjs'),
		path.resolve(process.cwd(), 'scripts/lib/system-capacity-core.mjs'),
		path.resolve(process.cwd(), '../../scripts/lib/system-capacity-core.mjs'),
	];

	for (const candidate of candidates) {
		try {
			coreModule = require(candidate) as CoreModule;
			return coreModule;
		} catch {
			// try next path
		}
	}

	throw new Error(
		'Could not load scripts/lib/system-capacity-core.mjs — resource auto-detection unavailable'
	);
}

function fallbackDetect(): SystemCapacity {
	const hostMemBytes = os.totalmem();
	const hostCpus = os.cpus().length;
	return {
		hostMemGb: roundGb(hostMemBytes),
		hostCpus,
		effectiveMemGb: roundGb(hostMemBytes),
		effectiveCpus: hostCpus,
		memLimitSource: 'host',
		cpuLimitSource: 'host',
		cgroupMemLimited: false,
		cgroupCpuLimited: false,
		virtualization: 'bare-metal',
		virtualizationDetail: null,
	};
}

export function detectSystemCapacity(): SystemCapacity {
	try {
		return loadCore().detectSystemCapacity();
	} catch {
		return fallbackDetect();
	}
}

export function readCgroupMemoryLimitBytes(): number | null {
	try {
		return loadCore().readCgroupMemoryLimitBytes();
	} catch {
		return null;
	}
}

export function readCgroupCpuCount(): number | null {
	try {
		return loadCore().readCgroupCpuQuotaCount();
	} catch {
		return null;
	}
}
