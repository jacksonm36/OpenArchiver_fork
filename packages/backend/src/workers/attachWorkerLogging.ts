import type { Job, JobProgress, Worker } from 'bullmq';
import { logger } from '../config/logger';
import { activityLogService } from '../services/ActivityLogService';

function logActivity(
	level: 'info' | 'warn' | 'error' | 'success',
	message: string,
	meta?: Record<string, unknown>
) {
	void activityLogService.push({
		level,
		source: 'worker',
		message,
		meta,
	});
}

export function attachWorkerLogging(worker: Worker, queueName: string): void {
	worker.on('active', (job: Job) => {
		const meta = {
			queue: queueName,
			jobId: job.id,
			jobName: job.name,
			ingestionSourceId: job.data?.ingestionSourceId,
			userEmail: job.data?.userEmail,
		};
		logger.info(meta, 'Queue job started');
		logActivity(
			'success',
			`${queueName}: started ${job.name} #${job.id}`,
			meta
		);
	});

	worker.on('completed', (job: Job) => {
		const meta = {
			queue: queueName,
			jobId: job.id,
			jobName: job.name,
			ingestionSourceId: job.data?.ingestionSourceId,
		};
		logger.info(meta, 'Queue job completed');
		logActivity('info', `${queueName}: completed ${job.name} #${job.id}`, meta);
	});

	worker.on('failed', (job: Job | undefined, error: Error) => {
		const meta = {
			queue: queueName,
			jobId: job?.id,
			jobName: job?.name,
			ingestionSourceId: job?.data?.ingestionSourceId,
			error: error.message,
		};
		logger.error({ ...meta, err: error }, 'Queue job failed');
		logActivity(
			'error',
			`${queueName}: failed ${job?.name ?? 'unknown'} #${job?.id ?? 'n/a'} — ${error.message}`,
			meta
		);
	});

	worker.on('progress', (job: Job, progress: JobProgress) => {
		const meta = {
			queue: queueName,
			jobId: job.id,
			jobName: job.name,
			progress,
		};
		logger.info(meta, 'Queue job progress');
		logActivity('info', `${queueName}: progress ${job.name} #${job.id}`, meta);
	});

	worker.on('error', (error: Error) => {
		logger.error({ queue: queueName, err: error }, 'Worker error');
		logActivity('error', `${queueName} worker error — ${error.message}`, {
			queue: queueName,
			error: error.message,
		});
	});
}
