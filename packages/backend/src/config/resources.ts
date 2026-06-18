import 'dotenv/config';
import type { SystemCapacity } from './systemCapacity';
import { detectSystemCapacity } from './systemCapacity';

export type ResourceProfileName = 'low' | 'balanced' | 'high' | 'auto';

export interface ResourceSettings {
	profile: ResourceProfileName;
	profileSource: 'auto' | 'manual';
	capacity: SystemCapacity;
	ingestionWorkerConcurrency: number;
	indexingWorkerConcurrency: number;
	indexingEmailConcurrency: number;
	indexingAttachmentConcurrency: number;
	attachmentStorageConcurrency: number;
	indexingBatchSize: number;
	syncFrequency: string;
	nodeMaxOldSpaceMb: number;
}

interface ProfileDefaults {
	ingestionWorkerConcurrency: number;
	indexingWorkerConcurrency: number;
	indexingEmailConcurrency: number;
	indexingAttachmentConcurrency: number;
	attachmentStorageConcurrency: number;
	indexingBatchSize: number;
	syncFrequency: string;
	nodeMaxOldSpaceMb: number;
}

/** Tuned for ~6 GB RAM and 4 CPU cores (native install or Docker). */
const LOW_PROFILE: ProfileDefaults = {
	ingestionWorkerConcurrency: 1,
	indexingWorkerConcurrency: 1,
	indexingEmailConcurrency: 2,
	indexingAttachmentConcurrency: 1,
	attachmentStorageConcurrency: 1,
	indexingBatchSize: 20,
	syncFrequency: '*/15 * * * *',
	nodeMaxOldSpaceMb: 1024,
};

/** Good default for 8–16 GB RAM. */
const BALANCED_PROFILE: ProfileDefaults = {
	ingestionWorkerConcurrency: 2,
	indexingWorkerConcurrency: 2,
	indexingEmailConcurrency: 5,
	indexingAttachmentConcurrency: 3,
	attachmentStorageConcurrency: 3,
	indexingBatchSize: 50,
	syncFrequency: '*/5 * * * *',
	nodeMaxOldSpaceMb: 1536,
};

/** For servers with 16 GB+ RAM and many cores. */
const HIGH_PROFILE: ProfileDefaults = {
	ingestionWorkerConcurrency: 5,
	indexingWorkerConcurrency: 3,
	indexingEmailConcurrency: 10,
	indexingAttachmentConcurrency: 5,
	attachmentStorageConcurrency: 5,
	indexingBatchSize: 100,
	syncFrequency: '* * * * *',
	nodeMaxOldSpaceMb: 2048,
};

const PROFILE_DEFAULTS: Record<'low' | 'balanced' | 'high', ProfileDefaults> = {
	low: LOW_PROFILE,
	balanced: BALANCED_PROFILE,
	high: HIGH_PROFILE,
};

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function detectProfileBucket(capacity: SystemCapacity): 'low' | 'balanced' | 'high' {
	const { effectiveMemGb: mem, effectiveCpus: cpus } = capacity;

	if (mem < 8 || (mem < 10 && cpus <= 4)) {
		return 'low';
	}
	if (mem < 16) {
		return 'balanced';
	}
	return 'high';
}

/** Continuous tuning from detected RAM/CPU (used when RESOURCE_PROFILE=auto). */
function computeAutoDefaults(capacity: SystemCapacity): ProfileDefaults {
	const mem = capacity.effectiveMemGb;
	const cpus = capacity.effectiveCpus;

	const reservedGb = mem <= 6 ? 2.5 : mem <= 10 ? 3 : mem <= 20 ? 4 : 5;
	const appMemGb = Math.max(1, mem - reservedGb);
	const nodeProcessCount = 3;

	return {
		ingestionWorkerConcurrency: clamp(Math.floor(cpus / 4) || 1, 1, 5),
		indexingWorkerConcurrency: clamp(Math.floor(cpus / 4) || 1, 1, 3),
		indexingEmailConcurrency: clamp(Math.floor(cpus / 2) || 1, 1, 12),
		indexingAttachmentConcurrency: clamp(Math.floor(cpus / 3) || 1, 1, 6),
		attachmentStorageConcurrency: clamp(Math.floor(cpus / 3) || 1, 1, 6),
		indexingBatchSize: clamp(Math.round(mem * 2.5), 15, 100),
		syncFrequency: mem < 8 ? '*/15 * * * *' : mem < 16 ? '*/5 * * * *' : '*/2 * * * *',
		nodeMaxOldSpaceMb: clamp(
			Math.floor((appMemGb * 1024) / nodeProcessCount / 2),
			512,
			3072
		),
	};
}

function resolveProfile(capacity: SystemCapacity): {
	profile: ResourceProfileName;
	profileSource: 'auto' | 'manual';
	defaults: ProfileDefaults;
} {
	const raw = (process.env.RESOURCE_PROFILE || 'auto').toLowerCase();

	if (raw === 'auto') {
		const defaults = computeAutoDefaults(capacity);
		const bucket = detectProfileBucket(capacity);
		return { profile: bucket, profileSource: 'auto', defaults };
	}

	if (raw === 'low' || raw === 'balanced' || raw === 'high') {
		return { profile: raw, profileSource: 'manual', defaults: PROFILE_DEFAULTS[raw] };
	}

	return { profile: 'balanced', profileSource: 'manual', defaults: PROFILE_DEFAULTS.balanced };
}

function readIntEnv(key: string, fallback: number): number {
	const value = process.env[key];
	if (!value) {
		return fallback;
	}
	const parsed = parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildResourceSettings(): ResourceSettings {
	const capacity = detectSystemCapacity();
	const { profile, profileSource, defaults } = resolveProfile(capacity);

	return {
		profile,
		profileSource,
		capacity,
		ingestionWorkerConcurrency: readIntEnv(
			'INGESTION_WORKER_CONCURRENCY',
			defaults.ingestionWorkerConcurrency
		),
		indexingWorkerConcurrency: readIntEnv(
			'INDEXING_WORKER_CONCURRENCY',
			defaults.indexingWorkerConcurrency
		),
		indexingEmailConcurrency: readIntEnv(
			'INDEXING_EMAIL_CONCURRENCY',
			defaults.indexingEmailConcurrency
		),
		indexingAttachmentConcurrency: readIntEnv(
			'INDEXING_ATTACHMENT_CONCURRENCY',
			defaults.indexingAttachmentConcurrency
		),
		attachmentStorageConcurrency: readIntEnv(
			'ATTACHMENT_STORAGE_CONCURRENCY',
			defaults.attachmentStorageConcurrency
		),
		indexingBatchSize: readIntEnv('MEILI_INDEXING_BATCH', defaults.indexingBatchSize),
		syncFrequency: process.env.SYNC_FREQUENCY || defaults.syncFrequency,
		nodeMaxOldSpaceMb: readIntEnv('NODE_MAX_OLD_SPACE_MB', defaults.nodeMaxOldSpaceMb),
	};
}

export const resources = buildResourceSettings();

/** Snapshot for monitor API and startup logs. */
export function getResourceStatus() {
	return {
		capacity: resources.capacity,
		tuning: {
			profile: resources.profile,
			profileSource: resources.profileSource,
			ingestionWorkerConcurrency: resources.ingestionWorkerConcurrency,
			indexingWorkerConcurrency: resources.indexingWorkerConcurrency,
			indexingEmailConcurrency: resources.indexingEmailConcurrency,
			indexingAttachmentConcurrency: resources.indexingAttachmentConcurrency,
			attachmentStorageConcurrency: resources.attachmentStorageConcurrency,
			indexingBatchSize: resources.indexingBatchSize,
			syncFrequency: resources.syncFrequency,
			nodeMaxOldSpaceMb: resources.nodeMaxOldSpaceMb,
		},
	};
}
