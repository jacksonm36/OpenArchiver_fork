import type { IQueueOverview } from './jobs.types';

export type ServiceHealthStatus = 'healthy' | 'degraded' | 'down';

export type ServiceHealthId =
	| 'database'
	| 'redis'
	| 'meilisearch'
	| 'ingestion_worker'
	| 'indexing_worker';

export interface IServiceHealth {
	id: ServiceHealthId;
	status: ServiceHealthStatus;
	latencyMs?: number;
	message?: string | null;
}

export interface ISystemHealth {
	checkedAt: string;
	services: IServiceHealth[];
}

export type ActivityLogLevel = 'info' | 'warn' | 'error' | 'success';

export interface IActivityEvent {
	id: string;
	at: string;
	level: ActivityLogLevel;
	source: string;
	message: string;
	meta?: Record<string, unknown>;
}

export interface IMonitorResponse {
	health: ISystemHealth;
	events: IActivityEvent[];
	queues: IQueueOverview[];
	resources?: IResourceStatus;
}

export interface IResourceCapacity {
	hostMemGb: number;
	hostCpus: number;
	effectiveMemGb: number;
	effectiveCpus: number;
	memLimitSource: 'host' | 'cgroup' | 'meminfo';
	cpuLimitSource: 'host' | 'cgroup' | 'cpuset';
	cgroupMemLimited: boolean;
	cgroupCpuLimited: boolean;
	virtualization: string;
	virtualizationDetail: string | null;
}

export interface IResourceTuning {
	profile: string;
	profileSource: 'auto' | 'manual';
	ingestionWorkerConcurrency: number;
	indexingWorkerConcurrency: number;
	indexingEmailConcurrency: number;
	indexingAttachmentConcurrency: number;
	attachmentStorageConcurrency: number;
	indexingBatchSize: number;
	syncFrequency: string;
	nodeMaxOldSpaceMb: number;
}

export interface IResourceStatus {
	capacity: IResourceCapacity;
	tuning: IResourceTuning;
}
