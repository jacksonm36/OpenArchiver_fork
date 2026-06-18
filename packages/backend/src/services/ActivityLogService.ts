import { randomUUID } from 'crypto';
import type { ActivityLogLevel, IActivityEvent } from '@open-archiver/types';
import { ingestionQueue } from '../jobs/queues';

const ACTIVITY_LOG_KEY = 'open-archiver:activity-log';
const MAX_EVENTS = 500;

type PushActivityInput = {
	level: ActivityLogLevel;
	source: string;
	message: string;
	meta?: Record<string, unknown>;
};

export class ActivityLogService {
	public async push(input: PushActivityInput): Promise<void> {
		try {
			const client = await ingestionQueue.client;
			const event: IActivityEvent = {
				id: randomUUID(),
				at: new Date().toISOString(),
				level: input.level,
				source: input.source,
				message: input.message,
				meta: input.meta,
			};
			await client.lpush(ACTIVITY_LOG_KEY, JSON.stringify(event));
			await client.ltrim(ACTIVITY_LOG_KEY, 0, MAX_EVENTS - 1);
		} catch {
			// Activity logging must not break workers or API handlers.
		}
	}

	public async getSince(since?: string, limit = 100): Promise<IActivityEvent[]> {
		try {
			const client = await ingestionQueue.client;
			const raw = await client.lrange(ACTIVITY_LOG_KEY, 0, limit - 1);
			const events = raw
				.map((entry) => {
					try {
						return JSON.parse(entry) as IActivityEvent;
					} catch {
						return null;
					}
				})
				.filter((event): event is IActivityEvent => event !== null)
				.filter((event) => !since || event.at > since);
			return events.reverse();
		} catch {
			return [];
		}
	}
}

export const activityLogService = new ActivityLogService();
