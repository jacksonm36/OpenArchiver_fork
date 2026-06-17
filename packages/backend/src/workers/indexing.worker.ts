import { Worker } from 'bullmq';
import { connection } from '../config/redis';
import { config } from '../config';
import indexEmailBatchProcessor from '../jobs/processors/index-email-batch.processor';
import { logger } from '../config/logger';

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

process.on('SIGINT', () => worker.close());
process.on('SIGTERM', () => worker.close());
