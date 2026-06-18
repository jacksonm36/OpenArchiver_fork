import { Worker } from 'bullmq';
import { connection } from '../config/redis';
import { config } from '../config';
import initialImportProcessor from '../jobs/processors/initial-import.processor';
import continuousSyncProcessor from '../jobs/processors/continuous-sync.processor';
import scheduleContinuousSyncProcessor from '../jobs/processors/schedule-continuous-sync.processor';
import { processMailboxProcessor } from '../jobs/processors/process-mailbox.processor';
import syncCycleFinishedProcessor from '../jobs/processors/sync-cycle-finished.processor';
import { logger } from '../config/logger';
import { attachWorkerLogging } from './attachWorkerLogging';
import { activityLogService } from '../services/ActivityLogService';

const processor = async (job: any) => {
	switch (job.name) {
		case 'initial-import':
			return initialImportProcessor(job);
		case 'sync-cycle-finished':
			return syncCycleFinishedProcessor(job);
		case 'continuous-sync':
			return continuousSyncProcessor(job);
		case 'schedule-continuous-sync':
			return scheduleContinuousSyncProcessor(job);
		case 'process-mailbox':
			return processMailboxProcessor(job);
		default:
			throw new Error(`Unknown job name: ${job.name}`);
	}
};

const worker = new Worker('ingestion', processor, {
	connection,
	concurrency: config.resources.ingestionWorkerConcurrency,
	removeOnComplete: {
		count: 100, // keep last 100 jobs
	},
	removeOnFail: {
		count: 500, // keep last 500 failed jobs
	},
});

logger.info(
	{
		resourceProfile: config.resources.profile,
		concurrency: config.resources.ingestionWorkerConcurrency,
	},
	'Ingestion worker started'
);

attachWorkerLogging(worker, 'ingestion');

void activityLogService.push({
	level: 'success',
	source: 'worker',
	message: `ingestion worker online (concurrency=${config.resources.ingestionWorkerConcurrency})`,
});

const shutdown = async (signal: string) => {
	logger.info(`${signal} received, shutting down ingestion worker...`);
	try {
		await worker.close();
		logger.info('Ingestion worker closed');
		process.exit(0);
	} catch (err) {
		logger.error({ err }, 'Failed to close ingestion worker');
		process.exit(1);
	}
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
