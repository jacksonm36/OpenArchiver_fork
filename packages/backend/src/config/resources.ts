import 'dotenv/config';
import os from 'os';

export type ResourceProfileName = 'low' | 'balanced' | 'high';

export interface ResourceSettings {
	profile: ResourceProfileName;
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

/** Tuned for ~6 GB RAM and 4 CPU cores (Docker or bare metal). */
const LOW_PROFILE: ProfileDefaults = {
	ingestionWorkerConcurrency: 1,
	indexingWorkerConcurrency: 1,
	indexingEmailConcurrency: 2,
	indexingAttachmentConcurrency: 2,
	attachmentStorageConcurrency: 2,
	indexingBatchSize: 25,
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

const PROFILE_DEFAULTS: Record<ResourceProfileName, ProfileDefaults> = {
	low: LOW_PROFILE,
	balanced: BALANCED_PROFILE,
	high: HIGH_PROFILE,
};

function detectProfile(): ResourceProfileName {
	const totalGb = os.totalmem() / 1024 ** 3;
	const cpus = os.cpus().length;

	// Typical 6 GB machines report ~5.8–6.5 GB to Node.
	if (totalGb < 8 || (totalGb < 10 && cpus <= 4)) {
		return 'low';
	}
	if (totalGb < 16) {
		return 'balanced';
	}
	return 'high';
}

function resolveProfileName(): ResourceProfileName {
	const raw = (process.env.RESOURCE_PROFILE || 'auto').toLowerCase();

	if (raw === 'auto') {
		return detectProfile();
	}
	if (raw === 'low' || raw === 'balanced' || raw === 'high') {
		return raw;
	}

	return 'balanced';
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
	const profile = resolveProfileName();
	const defaults = PROFILE_DEFAULTS[profile];

	return {
		profile,
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
