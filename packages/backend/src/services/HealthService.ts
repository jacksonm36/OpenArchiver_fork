import { sql } from 'drizzle-orm';
import { MeiliSearch } from 'meilisearch';
import type { IServiceHealth, ISystemHealth, ServiceHealthId } from '@open-archiver/types';
import { config } from '../config';
import { db } from '../database';
import { ingestionQueue, indexingQueue } from '../jobs/queues';
import { activityLogService } from './ActivityLogService';

const lastStatuses = new Map<ServiceHealthId, IServiceHealth['status']>();

async function timedCheck(
	check: () => Promise<void>
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
	const started = Date.now();
	try {
		await check();
		return { ok: true, latencyMs: Date.now() - started };
	} catch (error) {
		return {
			ok: false,
			latencyMs: Date.now() - started,
			error: error instanceof Error ? error.message : 'Unknown error',
		};
	}
}

export class HealthService {
	public async check(): Promise<ISystemHealth> {
		const [database, redis, meilisearch, ingestionWorker, indexingWorker] = await Promise.all([
			this.checkDatabase(),
			this.checkRedis(),
			this.checkMeilisearch(),
			this.checkWorkers('ingestion_worker', ingestionQueue),
			this.checkWorkers('indexing_worker', indexingQueue),
		]);

		const services = [database, redis, meilisearch, ingestionWorker, indexingWorker];
		this.logStatusChanges(services);

		return {
			checkedAt: new Date().toISOString(),
			services,
		};
	}

	private async checkDatabase(): Promise<IServiceHealth> {
		const result = await timedCheck(async () => {
			await db.execute(sql`SELECT 1`);
		});
		return {
			id: 'database',
			status: result.ok ? 'healthy' : 'down',
			latencyMs: result.latencyMs,
			message: result.error ?? null,
		};
	}

	private async checkRedis(): Promise<IServiceHealth> {
		const result = await timedCheck(async () => {
			const client = await ingestionQueue.client;
			const pong = await client.ping();
			if (pong !== 'PONG') {
				throw new Error(`Unexpected Redis response: ${pong}`);
			}
		});
		return {
			id: 'redis',
			status: result.ok ? 'healthy' : 'down',
			latencyMs: result.latencyMs,
			message: result.error ?? null,
		};
	}

	private async checkMeilisearch(): Promise<IServiceHealth> {
		const result = await timedCheck(async () => {
			const client = new MeiliSearch({
				host: config.search.host,
				apiKey: config.search.apiKey,
			});
			const health = await client.health();
			if (health.status !== 'available') {
				throw new Error(`Meilisearch status: ${health.status}`);
			}
		});
		return {
			id: 'meilisearch',
			status: result.ok ? 'healthy' : 'down',
			latencyMs: result.latencyMs,
			message: result.error ?? null,
		};
	}

	private async checkWorkers(
		id: Extract<ServiceHealthId, 'ingestion_worker' | 'indexing_worker'>,
		queue: typeof ingestionQueue
	): Promise<IServiceHealth> {
		const started = Date.now();
		try {
			const workers = await queue.getWorkers();
			const latencyMs = Date.now() - started;
			if (workers.length === 0) {
				return {
					id,
					status: 'down',
					latencyMs,
					message: 'No active workers registered',
				};
			}
			return {
				id,
				status: 'healthy',
				latencyMs,
				message: `${workers.length} worker(s)`,
			};
		} catch (error) {
			return {
				id,
				status: 'down',
				latencyMs: Date.now() - started,
				message: error instanceof Error ? error.message : 'Unknown error',
			};
		}
	}

	private logStatusChanges(services: IServiceHealth[]): void {
		for (const service of services) {
			const previous = lastStatuses.get(service.id);
			if (previous === service.status) {
				continue;
			}
			lastStatuses.set(service.id, service.status);

			const level =
				service.status === 'healthy' ? 'success' : service.status === 'degraded' ? 'warn' : 'error';
			const detail = service.message ? ` (${service.message})` : '';
			void activityLogService.push({
				level,
				source: 'health',
				message: `${service.id} is ${service.status}${detail}`,
				meta: {
					serviceId: service.id,
					status: service.status,
					latencyMs: service.latencyMs,
				},
			});
		}
	}
}

export const healthService = new HealthService();
