import { Request, Response } from 'express';
import { JobsService } from '../../services/JobsService';
import { healthService } from '../../services/HealthService';
import { activityLogService } from '../../services/ActivityLogService';
import { getResourceStatus } from '../../config/resources';
import {
	IGetQueueJobsRequestParams,
	IGetQueueJobsRequestQuery,
	JobStatus,
} from '@open-archiver/types';

export class JobsController {
	private jobsService: JobsService;

	constructor() {
		this.jobsService = new JobsService();
	}

	public getQueues = async (req: Request, res: Response) => {
		try {
			const queues = await this.jobsService.getQueues();
			res.status(200).json({ queues });
		} catch (error) {
			res.status(500).json({ message: 'Error fetching queues', error });
		}
	};

	public getQueueJobs = async (req: Request, res: Response) => {
		try {
			const { queueName } = req.params as unknown as IGetQueueJobsRequestParams;
			const { status, page, limit } = req.query as unknown as IGetQueueJobsRequestQuery;
			const pageNumber = parseInt(page, 10) || 1;
			const limitNumber = parseInt(limit, 10) || 10;
			const queueDetails = await this.jobsService.getQueueDetails(
				queueName,
				status,
				pageNumber,
				limitNumber
			);
			res.status(200).json(queueDetails);
		} catch (error) {
			res.status(500).json({ message: 'Error fetching queue jobs', error });
		}
	};

	public getMonitor = async (req: Request, res: Response) => {
		try {
			const since = typeof req.query.since === 'string' ? req.query.since : undefined;
			const [health, events, queues] = await Promise.all([
				healthService.check(),
				activityLogService.getSince(since),
				this.jobsService.getQueues(),
			]);
			res.status(200).json({ health, events, queues, resources: getResourceStatus() });
		} catch (error) {
			res.status(500).json({ message: 'Error fetching monitor data', error });
		}
	};
}
