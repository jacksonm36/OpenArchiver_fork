/**
 * Shared CPU/RAM detection for Docker, LXC/LXD, systemd-nspawn, Kubernetes,
 * and full VMs (QEMU/KVM, Hyper-V, VMware). Used by backend and docker-entrypoint.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export const VIRTUALIZATION_TYPES = [
	'bare-metal',
	'docker',
	'podman',
	'lxc',
	'lxd',
	'systemd-nspawn',
	'kubernetes',
	'qemu-kvm',
	'hyper-v',
	'vmware',
	'xen',
	'unknown-vm',
];

/** @typedef {(typeof VIRTUALIZATION_TYPES)[number]} VirtualizationType */

/**
 * @typedef {Object} SystemCapacity
 * @property {number} hostMemGb
 * @property {number} hostCpus
 * @property {number} effectiveMemGb
 * @property {number} effectiveCpus
 * @property {'host' | 'cgroup' | 'meminfo'} memLimitSource
 * @property {'host' | 'cgroup' | 'cpuset'} cpuLimitSource
 * @property {boolean} cgroupMemLimited
 * @property {boolean} cgroupCpuLimited
 * @property {VirtualizationType} virtualization
 * @property {string | null} virtualizationDetail
 */

function readFileSafe(filePath) {
	try {
		return fs.readFileSync(filePath, 'utf8').trim();
	} catch {
		return null;
	}
}

function parsePositiveInt(value) {
	if (!value) return null;
	const parsed = parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function roundGb(bytes) {
	return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

/** Parse cpuset list like "0-3,8" into a CPU count. */
export function countCpuList(spec) {
	if (!spec) return null;
	const trimmed = spec.trim();
	if (!trimmed || trimmed === 'none') return null;

	let count = 0;
	for (const part of trimmed.split(',')) {
		const segment = part.trim();
		if (!segment) continue;
		if (segment.includes('-')) {
			const [startRaw, endRaw] = segment.split('-');
			const start = parseInt(startRaw, 10);
			const end = parseInt(endRaw, 10);
			if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
				count += end - start + 1;
			}
		} else {
			const cpu = parseInt(segment, 10);
			if (Number.isFinite(cpu)) count += 1;
		}
	}
	return count > 0 ? count : null;
}

/** @returns {{ v2Path: string | null, v1: Record<string, string> }} */
export function parseSelfCgroup() {
	const content = readFileSafe('/proc/self/cgroup');
	if (!content) {
		return { v2Path: null, v1: {} };
	}

	let v2Path = null;
	/** @type {Record<string, string>} */
	const v1 = {};

	for (const line of content.split('\n')) {
		if (!line) continue;
		const match = line.match(/^(\d+):([^:]*):(.*)$/);
		if (!match) continue;
		const [, id, controllers, cgroupPath] = match;
		if (id === '0' && controllers === '') {
			v2Path = cgroupPath;
			continue;
		}
		for (const controller of controllers.split(',')) {
			if (controller) {
				v1[controller] = cgroupPath;
			}
		}
	}

	return { v2Path, v1 };
}

function cgroupV2Root() {
	const mounts = readFileSafe('/proc/mounts');
	if (mounts) {
		for (const line of mounts.split('\n')) {
			const parts = line.split(' ');
			if (parts.length >= 3 && parts[2] === 'cgroup2') {
				return parts[1];
			}
		}
	}
	return '/sys/fs/cgroup';
}

function readCgroupV2File(relativePath, fileName) {
	const root = cgroupV2Root();
	const segments = relativePath.replace(/^\//, '').split('/').filter(Boolean);

	for (let depth = segments.length; depth >= 0; depth -= 1) {
		const sub = segments.slice(0, depth).join('/');
		const filePath = sub ? path.join(root, sub, fileName) : path.join(root, fileName);
		const value = readFileSafe(filePath);
		if (value !== null && value !== '') {
			return value;
		}
	}

	return null;
}

function readCgroupV1File(controllerPath, fileName) {
	const root = '/sys/fs/cgroup';
	const segments = controllerPath.replace(/^\//, '').split('/').filter(Boolean);

	for (let depth = segments.length; depth >= 0; depth -= 1) {
		const sub = segments.slice(0, depth).join('/');
		const filePath = sub
			? path.join(root, sub, fileName)
			: path.join(root, fileName);
		const value = readFileSafe(filePath);
		if (value !== null && value !== '') {
			return value;
		}
	}

	return null;
}

/** cgroup memory limit in bytes (walks hierarchy — LXC/LXD/Docker/K8s). */
export function readCgroupMemoryLimitBytes() {
	const { v2Path, v1 } = parseSelfCgroup();
	const candidates = [];

	if (v2Path) {
		const raw = readCgroupV2File(v2Path, 'memory.max');
		if (raw && raw !== 'max') {
			const bytes = parsePositiveInt(raw);
			if (bytes && bytes < 1e15) candidates.push(bytes);
		}
	}

	const memoryPath = v1.memory;
	if (memoryPath) {
		const raw = readCgroupV1File(memoryPath, 'memory.limit_in_bytes');
		const bytes = parsePositiveInt(raw);
		if (bytes && bytes < 1e15) candidates.push(bytes);
	}

	for (const fallback of [
		'/sys/fs/cgroup/memory.max',
		'/sys/fs/cgroup/memory/memory.max',
		'/sys/fs/cgroup/memory.limit_in_bytes',
		'/sys/fs/cgroup/memory/memory.limit_in_bytes',
	]) {
		const raw = readFileSafe(fallback);
		if (raw && raw !== 'max') {
			const bytes = parsePositiveInt(raw);
			if (bytes && bytes < 1e15) candidates.push(bytes);
		}
	}

	if (candidates.length === 0) return null;
	return Math.min(...candidates);
}

/** CPU count from cgroup quota (v1/v2). */
export function readCgroupCpuQuotaCount() {
	const { v2Path, v1 } = parseSelfCgroup();
	const candidates = [];

	if (v2Path) {
		const cpuMax = readCgroupV2File(v2Path, 'cpu.max');
		if (cpuMax && !cpuMax.startsWith('max')) {
			const [quotaRaw, periodRaw] = cpuMax.split(/\s+/);
			const quota = parsePositiveInt(quotaRaw);
			const period = parsePositiveInt(periodRaw);
			if (quota && period) {
				candidates.push(Math.max(1, Math.floor(quota / period)));
			}
		}
	}

	const cpuPath = v1.cpu ?? v1.cpuacct;
	if (cpuPath) {
		const quota = parsePositiveInt(readCgroupV1File(cpuPath, 'cpu.cfs_quota_us'));
		const period = parsePositiveInt(readCgroupV1File(cpuPath, 'cpu.cfs_period_us'));
		if (quota && period && quota > 0) {
			candidates.push(Math.max(1, Math.floor(quota / period)));
		}
	}

	for (const fallback of ['/sys/fs/cgroup/cpu.max', '/sys/fs/cgroup/cpu/cpu.max']) {
		const cpuMax = readFileSafe(fallback);
		if (cpuMax && !cpuMax.startsWith('max')) {
			const [quotaRaw, periodRaw] = cpuMax.split(/\s+/);
			const quota = parsePositiveInt(quotaRaw);
			const period = parsePositiveInt(periodRaw);
			if (quota && period) {
				candidates.push(Math.max(1, Math.floor(quota / period)));
			}
		}
	}

	if (candidates.length === 0) return null;
	return Math.min(...candidates);
}

/** CPU count from cpuset (common in LXC and some K8s configs). */
export function readCpusetCpuCount() {
	const { v2Path, v1 } = parseSelfCgroup();
	const candidates = [];

	if (v2Path) {
		const effective = readCgroupV2File(v2Path, 'cpuset.cpus.effective');
		const count = countCpuList(effective);
		if (count) candidates.push(count);
	}

	const cpusetPath = v1.cpuset;
	if (cpusetPath) {
		const effective = readCgroupV1File(cpusetPath, 'cpuset.cpus');
		const count = countCpuList(effective);
		if (count) candidates.push(count);
	}

	for (const fallback of [
		'/sys/fs/cgroup/cpuset.cpus.effective',
		'/sys/fs/cgroup/cpuset/cpuset.cpus',
	]) {
		const count = countCpuList(readFileSafe(fallback));
		if (count) candidates.push(count);
	}

	if (candidates.length === 0) return null;
	return Math.min(...candidates);
}

/** MemTotal from /proc/meminfo — reflects QEMU/KVM/Hyper-V balloon deflation. */
export function readProcMemTotalBytes() {
	const meminfo = readFileSafe('/proc/meminfo');
	if (!meminfo) return null;
	const match = meminfo.match(/^MemTotal:\s+(\d+)\s+kB/im);
	if (!match) return null;
	const kb = parsePositiveInt(match[1]);
	return kb ? kb * 1024 : null;
}

/** Online CPUs from sysfs (VM hotplug / some hypervisors). */
export function readOnlineCpuCount() {
	const online = readFileSafe('/sys/devices/system/cpu/online');
	return countCpuList(online);
}

function readDmiField(fileName) {
	return readFileSafe(path.join('/sys/class/dmi/id', fileName));
}

function detectHypervisorFromCpuinfo() {
	const cpuinfo = readFileSafe('/proc/cpuinfo');
	if (!cpuinfo) return null;
	if (/hypervisor/i.test(cpuinfo)) {
		if (/QEMU|KVM/i.test(cpuinfo)) return 'qemu-kvm';
		if (/Microsoft/i.test(cpuinfo)) return 'hyper-v';
		if (/VMware/i.test(cpuinfo)) return 'vmware';
		if (/Xen/i.test(cpuinfo)) return 'xen';
		return 'unknown-vm';
	}
	return null;
}

/**
 * @returns {{ type: VirtualizationType, detail: string | null }}
 */
export function detectVirtualization() {
	const cgroupText = readFileSafe('/proc/self/cgroup') ?? '';
	const systemdContainer = readFileSafe('/run/systemd/container');
	const vendor = readDmiField('sys_vendor') ?? '';
	const product = readDmiField('product_name') ?? '';
	const chassis = readDmiField('chassis_type') ?? '';
	const combined = `${cgroupText}\n${systemdContainer ?? ''}\n${vendor}\n${product}`.toLowerCase();

	if (fs.existsSync('/.dockerenv') || combined.includes('docker')) {
		return { type: 'docker', detail: vendor || 'docker' };
	}
	if (combined.includes('libpod') || combined.includes('podman')) {
		return { type: 'podman', detail: vendor || 'podman' };
	}
	if (combined.includes('lxd') || combined.includes('lxcfs')) {
		return { type: 'lxd', detail: product || 'lxd' };
	}
	if (
		combined.includes('lxc') ||
		combined.includes('lxc.payload') ||
		systemdContainer === 'lxc'
	) {
		return { type: 'lxc', detail: product || 'lxc' };
	}
	if (combined.includes('kubepods') || combined.includes('kubernetes')) {
		return { type: 'kubernetes', detail: 'kubernetes' };
	}
	if (systemdContainer === 'systemd-nspawn') {
		return { type: 'systemd-nspawn', detail: 'systemd-nspawn' };
	}

	const cpuHypervisor = detectHypervisorFromCpuinfo();
	if (cpuHypervisor) {
		return { type: cpuHypervisor, detail: `${vendor} ${product}`.trim() || cpuHypervisor };
	}

	if (/microsoft/i.test(vendor) || /virtual machine/i.test(product)) {
		return { type: 'hyper-v', detail: `${vendor} ${product}`.trim() };
	}
	if (/qemu/i.test(vendor) || /qemu|kvm|virtual/i.test(product)) {
		return { type: 'qemu-kvm', detail: `${vendor} ${product}`.trim() };
	}
	if (/vmware/i.test(vendor) || /vmware/i.test(product)) {
		return { type: 'vmware', detail: `${vendor} ${product}`.trim() };
	}
	if (/xen/i.test(vendor) || /xen/i.test(product)) {
		return { type: 'xen', detail: `${vendor} ${product}`.trim() };
	}

	// DMI chassis 1 = "Other", often VMs; not definitive alone
	if (chassis === '1' && /virtual/i.test(product)) {
		return { type: 'unknown-vm', detail: `${vendor} ${product}`.trim() };
	}

	return { type: 'bare-metal', detail: vendor ? `${vendor} ${product}`.trim() : null };
}

/** @returns {SystemCapacity} */
export function detectSystemCapacity() {
	const hostMemBytes = os.totalmem();
	const hostCpus = os.cpus().length;

	const cgroupMemBytes = readCgroupMemoryLimitBytes();
	const cgroupQuotaCpus = readCgroupCpuQuotaCount();
	const cpusetCpus = readCpusetCpuCount();
	const meminfoBytes = readProcMemTotalBytes();
	const onlineCpus = readOnlineCpuCount();

	const memCandidates = [hostMemBytes];
	if (cgroupMemBytes !== null) memCandidates.push(cgroupMemBytes);
	if (meminfoBytes !== null) memCandidates.push(meminfoBytes);
	const effectiveMemBytes = Math.min(...memCandidates);

	const cpuCandidates = [hostCpus];
	if (onlineCpus !== null) cpuCandidates.push(onlineCpus);
	if (cgroupQuotaCpus !== null) cpuCandidates.push(cgroupQuotaCpus);
	if (cpusetCpus !== null) cpuCandidates.push(cpusetCpus);
	const effectiveCpus = Math.max(1, Math.min(...cpuCandidates));

	let memLimitSource = 'host';
	if (cgroupMemBytes !== null && cgroupMemBytes <= effectiveMemBytes + 1024) {
		memLimitSource = 'cgroup';
	} else if (meminfoBytes !== null && meminfoBytes < hostMemBytes - 64 * 1024 * 1024) {
		memLimitSource = 'meminfo';
	}

	let cpuLimitSource = 'host';
	if (cgroupQuotaCpus !== null && cgroupQuotaCpus <= effectiveCpus) {
		cpuLimitSource = 'cgroup';
	} else if (cpusetCpus !== null && cpusetCpus <= effectiveCpus) {
		cpuLimitSource = 'cpuset';
	}

	const { type: virtualization, detail: virtualizationDetail } = detectVirtualization();

	return {
		hostMemGb: roundGb(hostMemBytes),
		hostCpus,
		effectiveMemGb: roundGb(effectiveMemBytes),
		effectiveCpus,
		memLimitSource,
		cpuLimitSource,
		cgroupMemLimited: cgroupMemBytes !== null,
		cgroupCpuLimited: cgroupQuotaCpus !== null,
		virtualization,
		virtualizationDetail,
	};
}

export function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

export function computeAutoHeapMb(memGb) {
	const reservedGb = memGb <= 6 ? 2.5 : memGb <= 10 ? 3 : memGb <= 20 ? 4 : 5;
	const appMemGb = Math.max(1, memGb - reservedGb);
	return clamp(Math.floor((appMemGb * 1024) / 3 / 2), 512, 3072);
}
