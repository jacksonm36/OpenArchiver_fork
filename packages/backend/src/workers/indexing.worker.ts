import { Worker } from 'bullmq';
import { connection } from '../config/redis';
import { config } from '../config';
import indexEmailBatchProcessor from '../jobs/processors/index-email-batch.processor';
import { logger } from '../config/logger';
import { attachWorkerLogging } from './attachWorkerLogging';
import { activityLogService } from '../services/ActivityLogService';

const processor = async (job: any) => {
	switch (job.name) {
		case 'index-email-batch':
			return indexEmailBatchProcessor(job);
		default:
			throw new Error(`Unknown job name: ${job.name}`);
	}
};

const worker = new Worker('indexing', processor, {
	connection,
	concurrency: config.resources.indexingWorkerConcurrency,
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
		concurrency: config.resources.indexingWorkerConcurrency,
		indexingBatchSize: config.resources.indexingBatchSize,
	},
	'Indexing worker started'
);

attachWorkerLogging(worker, 'indexing');

void activityLogService.push({
	level: 'success',
	source: 'worker',
	message: `indexing worker online (concurrency=${config.resources.indexingWorkerConcurrency})`,
});

const shutdown = async (signal: string) => {
	logger.info(`${signal} received, shutting down indexing worker...`);
	try {
		await worker.close();
		logger.info('Indexing worker closed');
		process.exit(0);
	} catch (err) {
		logger.error({ err }, 'Failed to close indexing worker');
		process.exit(1);
	}
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
