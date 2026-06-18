import { Job } from 'bullmq';
import {
	IProcessMailboxJob,
	ProcessMailboxError,
	PendingEmail,
	FileImportCheckpoint,
} from '@open-archiver/types';
import { IngestionService } from '../../services/IngestionService';
import { logger } from '../../config/logger';
import { EmailProviderFactory } from '../../services/EmailProviderFactory';
import { StorageService } from '../../services/StorageService';
import { config } from '../../config';
import { indexingQueue, ingestionQueue } from '../queues';
import { SyncSessionService } from '../../services/SyncSessionService';
import {
	createFileImportProgressContext,
	type FileImportProgressContext,
} from '../../helpers/fileImportProgress';
import { FileImportDedupCache } from '../../helpers/fileImportDedupCache';

const CHECKPOINT_SAVE_INTERVAL = 25;

/**
 * Handles ingestion of emails for a single user's mailbox.
 *
 * On completion, it reports its result to SyncSessionService using an atomic DB counter.
 * If this is the last mailbox job in the session, it dispatches the 'sync-cycle-finished' job.
 * This replaces the BullMQ FlowProducer parent/child pattern, avoiding the memory and Redis
 * overhead of loading all children's return values at once.
 */
export const processMailboxProcessor = async (job: Job<IProcessMailboxJob>) => {
	const { ingestionSourceId, userEmail, sessionId, resumeMode, isInitialImport } = job.data;
	const BATCH_SIZE: number = config.meili.indexingBatchSize;
	let emailBatch: PendingEmail[] = [];

	logger.info({ ingestionSourceId, userEmail, sessionId, resumeMode }, `Processing mailbox for user`);

	const storageService = new StorageService();
	const fileBasedProviders = IngestionService.returnFileBasedIngestions();
	let lastCheckpoint: FileImportCheckpoint | null = null;
	let checkpointWrites = 0;
	let fileImportProgress: FileImportProgressContext | undefined;

	const persistCheckpoint = async (checkpoint: FileImportCheckpoint, force = false) => {
		lastCheckpoint = checkpoint;
		checkpointWrites += 1;
		if (!force && checkpointWrites % CHECKPOINT_SAVE_INTERVAL !== 0) {
			return;
		}
		await IngestionService.mergeFileImportCheckpoint(ingestionSourceId, userEmail, checkpoint);
	};

	try {
		const source = await IngestionService.findById(ingestionSourceId);
		if (!source) {
			throw new Error(`Ingestion source with ID ${ingestionSourceId} not found`);
		}

		const isFileImport = fileBasedProviders.includes(source.provider);
		if (isFileImport) {
			fileImportProgress = createFileImportProgressContext(
				source.syncState,
				userEmail,
				(checkpoint) => persistCheckpoint(checkpoint),
				{ dedupOnly: resumeMode === 'dedup' }
			);
		}

		const connector = EmailProviderFactory.createConnector(source);
		const ingestionService = new IngestionService();

		const dedupCache = isFileImport
			? await FileImportDedupCache.load(ingestionSourceId)
			: undefined;

		let knownMessageIds: Set<string> | undefined;
		let groupSourceIds: string[] | undefined;

		if (!isFileImport) {
			const preloaded = await IngestionService.preloadExistingMessageIds(ingestionSourceId);
			knownMessageIds = preloaded.knownMessageIds;
			groupSourceIds = preloaded.groupSourceIds;
			logger.info(
				{ ingestionSourceId, preloadedCount: knownMessageIds.size },
				'Pre-loaded existing message IDs for duplicate checking'
			);
		}

		const checkDuplicate = async (messageId: string) => {
			if (knownMessageIds) {
				return knownMessageIds.has(messageId);
			}
			return await IngestionService.doesEmailExist(messageId, ingestionSourceId, dedupCache);
		};

		for await (const email of connector.fetchEmails(
			userEmail,
			source.syncState,
			checkDuplicate,
			fileImportProgress
		)) {
			if (!email) {
				continue;
			}

			const processedEmail = await ingestionService.processEmail(
				email,
				source,
				storageService,
				userEmail,
				dedupCache,
				groupSourceIds,
				knownMessageIds
			);

			if (email.fileImportIndex !== undefined) {
				await persistCheckpoint(
					{
						lastGlobalIndex: email.fileImportIndex,
						lastMessageId: email.id,
						lastPath: email.path,
					}
				);
			}

			if (processedEmail) {
				emailBatch.push(processedEmail);
				if (emailBatch.length >= BATCH_SIZE) {
					await indexingQueue.add('index-email-batch', { emails: emailBatch });
					emailBatch = [];
					await SyncSessionService.heartbeat(sessionId);
				}
			}
		}

		if (emailBatch.length > 0) {
			await indexingQueue.add('index-email-batch', { emails: emailBatch });
			emailBatch = [];
		}

		if (isFileImport && lastCheckpoint && resumeMode !== 'dedup') {
			const checkpoint: FileImportCheckpoint = lastCheckpoint;
			await IngestionService.mergeFileImportCheckpoint(ingestionSourceId, userEmail, {
				...checkpoint,
				complete: true,
			});
		}

		const newSyncState = connector.getUpdatedSyncState(userEmail);
		logger.info({ ingestionSourceId, userEmail }, `Finished processing mailbox for user`);

		const { isLast } = await SyncSessionService.recordMailboxResult(sessionId, newSyncState);

		if (isLast) {
			logger.info(
				{ ingestionSourceId, sessionId },
				'Last mailbox job completed, dispatching sync-cycle-finished'
			);
			await ingestionQueue.add('sync-cycle-finished', {
				ingestionSourceId,
				sessionId,
				isInitialImport: isInitialImport ?? false,
			});
		}
	} catch (error) {
		if (emailBatch.length > 0) {
			await indexingQueue.add('index-email-batch', { emails: emailBatch });
			emailBatch = [];
		}

		if (lastCheckpoint) {
			try {
				await IngestionService.mergeFileImportCheckpoint(
					ingestionSourceId,
					userEmail,
					lastCheckpoint
				);
			} catch (checkpointError) {
				logger.error(
					{ err: checkpointError, ingestionSourceId, userEmail },
					'Failed to persist import checkpoint after error'
				);
			}
		}

		logger.error({ err: error, ingestionSourceId, userEmail }, 'Error processing mailbox');
		const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
		const processMailboxError: ProcessMailboxError = {
			error: true,
			message: `Failed to process mailbox for ${userEmail}: ${errorMessage}`,
		};

		try {
			const { isLast } = await SyncSessionService.recordMailboxResult(
				sessionId,
				processMailboxError
			);

			if (isLast) {
				logger.info(
					{ ingestionSourceId, sessionId },
					'Last mailbox job (with error) completed, dispatching sync-cycle-finished'
				);
				await ingestionQueue.add('sync-cycle-finished', {
					ingestionSourceId,
					sessionId,
					isInitialImport: isInitialImport ?? false,
				});
			}
		} catch (sessionError) {
			logger.error(
				{ err: sessionError, sessionId },
				'Failed to record mailbox error in sync session'
			);
		}
	}
};
