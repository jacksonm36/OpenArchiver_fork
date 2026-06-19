import { db } from '../database';
import { ingestionSources } from '../database/schema';
import type {
	CreateIngestionSourceDto,
	UpdateIngestionSourceDto,
	IngestionSource,
	IngestionCredentials,
	IngestionProvider,
	PendingEmail,
	IndexingHint,
	FileImportCheckpoint,
	ResumeImportMode,
	IngestionDiagnostics,
} from '@open-archiver/types';
import { and, desc, eq, inArray, or, count, sql } from 'drizzle-orm';
import { CryptoService } from './CryptoService';
import { EmailProviderFactory } from './EmailProviderFactory';
import { ingestionQueue, indexingQueue } from '../jobs/queues';
import type { JobType } from 'bullmq';
import { StorageService } from './StorageService';
import type { IInitialImportJob, EmailObject } from '@open-archiver/types';
import { stripAttachmentsFromEml } from '../helpers/emlUtils';
import {
	archivedEmails,
	attachments as attachmentsSchema,
	emailAttachments,
} from '../database/schema';
import { createHash, randomUUID } from 'crypto';
import { readFile, unlink } from 'fs/promises';
import { logger } from '../config/logger';
import { SearchService } from './SearchService';
import { config } from '../config/index';
import { FilterBuilder } from './FilterBuilder';
import { AuditService } from './AuditService';
import { User } from '@open-archiver/types';
import { checkDeletionEnabled } from '../helpers/deletionGuard';
import { mapWithConcurrency } from '../helpers/parallel';
import { SyncSessionService } from './SyncSessionService';
import { validateFileImportCredentials } from '../helpers/localImportPath';
import { getFileImportCheckpoint } from '../helpers/fileImportProgress';
import { FileImportDedupCache } from '../helpers/fileImportDedupCache';
import { hashReadableStream } from '../helpers/hashStream';
import type { Readable } from 'stream';
import { createReadStream } from 'fs';

/** Max searchable body text stored in Redis indexing jobs (low-RAM hosts). */
export const INDEXING_HINT_BODY_MAX_CHARS = 32_000;

function buildIndexingHint(email: EmailObject): IndexingHint | undefined {
	const rawBody = email.body || email.html || '';
	const body =
		rawBody.length > INDEXING_HINT_BODY_MAX_CHARS
			? rawBody.slice(0, INDEXING_HINT_BODY_MAX_CHARS)
			: rawBody;
	// Only skip the indexing re-parse when the connector already extracted searchable text
	// (e.g. PST fast path). Other connectors may only have content in the temp EML file.
	if (!body && !email.emlAttachmentsStripped) {
		return undefined;
	}

	return {
		body,
		subject: email.subject || '',
		from: email.from[0]?.address || '',
		to: email.to?.map((address) => address.address) || [],
		cc: email.cc?.map((address) => address.address) || [],
		bcc: email.bcc?.map((address) => address.address) || [],
	};
}

export class IngestionService {
	private static auditService = new AuditService();
	private static decryptSource(
		source: typeof ingestionSources.$inferSelect
	): IngestionSource | null {
		const decryptedCredentials = CryptoService.decryptObject<IngestionCredentials>(
			source.credentials as string
		);

		if (!decryptedCredentials) {
			logger.error(
				{ sourceId: source.id },
				'Failed to decrypt ingestion source credentials.'
			);
			return null;
		}

		return { ...source, credentials: decryptedCredentials } as IngestionSource;
	}

	public static returnFileBasedIngestions(): IngestionProvider[] {
		return ['pst_import', 'eml_import', 'mbox_import'];
	}

	public static async create(
		dto: CreateIngestionSourceDto,
		userId: string,
		actor: User,
		actorIp: string
	): Promise<IngestionSource> {
		const { providerConfig, mergedIntoId, ...rest } = dto;
		await validateFileImportCredentials(
			rest.provider,
			providerConfig as IngestionCredentials
		);
		const encryptedCredentials = CryptoService.encryptObject(providerConfig);

		// Resolve merge target: if mergedIntoId points to a child, follow to the root.
		let resolvedMergedIntoId: string | undefined;
		if (mergedIntoId) {
			const target = await this.findById(mergedIntoId);
			resolvedMergedIntoId = target.mergedIntoId ?? target.id;
		}

		const valuesToInsert = {
			userId,
			...rest,
			status: 'pending_auth' as const,
			credentials: encryptedCredentials,
			mergedIntoId: resolvedMergedIntoId ?? null,
		};

		const [newSource] = await db.insert(ingestionSources).values(valuesToInsert).returning();

		await this.auditService.createAuditLog({
			actorIdentifier: actor.id,
			actionType: 'CREATE',
			targetType: 'IngestionSource',
			targetId: newSource.id,
			actorIp,
			details: {
				sourceName: newSource.name,
				sourceType: newSource.provider,
			},
		});

		const decryptedSource = this.decryptSource(newSource);
		if (!decryptedSource) {
			await this.delete(newSource.id, actor, actorIp, true);
			throw new Error(
				'Failed to process newly created ingestion source due to a decryption error.'
			);
		}
		const connector = EmailProviderFactory.createConnector(decryptedSource);

		try {
			const connectionValid = await connector.testConnection();
			// If connection succeeds, update status to auth_success, which triggers the initial import.
			if (connectionValid) {
				return await this.update(
					decryptedSource.id,
					{ status: 'auth_success' },
					actor,
					actorIp
				);
			} else {
				throw Error('Ingestion authentication failed.');
			}
		} catch (error) {
			// If connection fails, delete the newly created source and throw the error.
			await this.delete(decryptedSource.id, actor, actorIp, true);
			throw error;
		}
	}

	public static async findAll(userId: string): Promise<IngestionSource[]> {
		const { drizzleFilter } = await FilterBuilder.create(userId, 'ingestion', 'read');
		let query = db.select().from(ingestionSources).$dynamic();

		if (drizzleFilter) {
			query = query.where(drizzleFilter);
		}

		const sources = await query.orderBy(desc(ingestionSources.createdAt));
		return sources.flatMap((source) => {
			const decrypted = this.decryptSource(source);
			return decrypted ? [decrypted] : [];
		});
	}

	public static async findById(id: string): Promise<IngestionSource> {
		const [source] = await db
			.select()
			.from(ingestionSources)
			.where(eq(ingestionSources.id, id));
		if (!source) {
			throw new Error('Ingestion source not found');
		}
		const decryptedSource = this.decryptSource(source);
		if (!decryptedSource) {
			throw new Error('Failed to decrypt ingestion source credentials.');
		}
		return decryptedSource;
	}

	public static async findByIdForUser(id: string, userId: string): Promise<IngestionSource> {
		const { drizzleFilter } = await FilterBuilder.create(userId, 'ingestion', 'read');
		const whereClause = drizzleFilter
			? and(eq(ingestionSources.id, id), drizzleFilter)
			: eq(ingestionSources.id, id);

		const [source] = await db.select().from(ingestionSources).where(whereClause);
		if (!source) {
			throw new Error('Ingestion source not found');
		}

		const decryptedSource = this.decryptSource(source);
		if (!decryptedSource) {
			throw new Error('Failed to decrypt ingestion source credentials.');
		}
		return decryptedSource;
	}

	public static async update(
		id: string,
		dto: UpdateIngestionSourceDto,
		actor?: User,
		actorIp?: string
	): Promise<IngestionSource> {
		const { providerConfig, ...rest } = dto;
		const valuesToUpdate: Partial<typeof ingestionSources.$inferInsert> = { ...rest };

		// Get the original source to compare the status later
		const originalSource = await this.findById(id);

		if (providerConfig) {
			await validateFileImportCredentials(
				rest.provider ?? originalSource.provider,
				providerConfig as IngestionCredentials
			);
			// Encrypt the new credentials before updating
			valuesToUpdate.credentials = CryptoService.encryptObject(providerConfig);
		}

		const [updatedSource] = await db
			.update(ingestionSources)
			.set(valuesToUpdate)
			.where(eq(ingestionSources.id, id))
			.returning();

		if (!updatedSource) {
			throw new Error('Ingestion source not found');
		}

		const decryptedSource = this.decryptSource(updatedSource);

		if (!decryptedSource) {
			throw new Error(
				'Failed to process updated ingestion source due to a decryption error.'
			);
		}

		// If the status has changed to auth_success, trigger the initial import
		if (originalSource.status !== 'auth_success' && decryptedSource.status === 'auth_success') {
			await this.triggerInitialImport(decryptedSource.id);
		}
		if (actor && actorIp) {
			const changedFields = Object.keys(dto).filter(
				(key) =>
					key !== 'providerConfig' &&
					originalSource[key as keyof IngestionSource] !==
						decryptedSource[key as keyof IngestionSource]
			);
			if (changedFields.length > 0) {
				await this.auditService.createAuditLog({
					actorIdentifier: actor.id,
					actionType: 'UPDATE',
					targetType: 'IngestionSource',
					targetId: id,
					actorIp,
					details: {
						changedFields,
					},
				});
			}
		}

		return decryptedSource;
	}

	/**
	 * Returns all ingestionSourceId values in a merge group given any member's ID.
	 * If the source is standalone (no parent, no children), returns just its own ID.
	 */
	public static async findGroupSourceIds(sourceId: string): Promise<string[]> {
		const source = await this.findById(sourceId);
		const rootId = source.mergedIntoId ?? source.id;

		const children = await db
			.select({ id: ingestionSources.id })
			.from(ingestionSources)
			.where(eq(ingestionSources.mergedIntoId, rootId));

		return [rootId, ...children.map((c) => c.id)];
	}

	/**
	 * Detaches a child source from its merge group, making it standalone.
	 */
	public static async unmerge(
		id: string,
		actor: User,
		actorIp: string
	): Promise<IngestionSource> {
		const source = await this.findById(id);
		if (!source.mergedIntoId) {
			throw new Error('Source is not merged into another source.');
		}

		const [updated] = await db
			.update(ingestionSources)
			.set({ mergedIntoId: null })
			.where(eq(ingestionSources.id, id))
			.returning();

		await this.auditService.createAuditLog({
			actorIdentifier: actor.id,
			actionType: 'UPDATE',
			targetType: 'IngestionSource',
			targetId: id,
			actorIp,
			details: {
				action: 'unmerge',
				previousParentId: source.mergedIntoId,
			},
		});

		const decrypted = this.decryptSource(updated);
		if (!decrypted) {
			throw new Error('Failed to decrypt unmerged source.');
		}
		return decrypted;
	}

	public static async delete(
		id: string,
		actor: User,
		actorIp: string,
		force: boolean = false
	): Promise<IngestionSource> {
		if (!force) {
			checkDeletionEnabled();
		}
		const source = await this.findById(id);
		if (!source) {
			throw new Error('Ingestion source not found');
		}

		// If this is a root source with children, delete all children first
		if (!source.mergedIntoId) {
			const children = await db
				.select({ id: ingestionSources.id })
				.from(ingestionSources)
				.where(eq(ingestionSources.mergedIntoId, id));

			for (const child of children) {
				await this.delete(child.id, actor, actorIp, force);
			}
		}

		// Delete all emails and attachments from storage
		const storage = new StorageService();
		const emailPath = `${config.storage.openArchiverFolderName}/${source.name.replaceAll(' ', '-')}-${source.id}/`;
		await storage.delete(emailPath);

		if (
			(source.credentials.type === 'pst_import' ||
				source.credentials.type === 'eml_import' ||
				source.credentials.type === 'mbox_import') &&
			source.credentials.uploadedFilePath &&
			(await storage.exists(source.credentials.uploadedFilePath))
		) {
			await storage.delete(source.credentials.uploadedFilePath);
		}

		// Delete all emails from the database
		// NOTE: This is done by database CASADE, change when CASADE relation no longer exists.
		// await db.delete(archivedEmails).where(eq(archivedEmails.ingestionSourceId, id));

		// Delete all documents from Meilisearch
		const searchService = new SearchService();
		await searchService.deleteDocumentsByFilter('emails', `ingestionSourceId = ${id}`);

		const [deletedSource] = await db
			.delete(ingestionSources)
			.where(eq(ingestionSources.id, id))
			.returning();

		await this.auditService.createAuditLog({
			actorIdentifier: actor.id,
			actionType: 'DELETE',
			targetType: 'IngestionSource',
			targetId: id,
			actorIp,
			details: {
				sourceName: deletedSource.name,
			},
		});

		const decryptedSource = this.decryptSource(deletedSource);
		if (!decryptedSource) {
			// Even if decryption fails, we should confirm deletion.
			// We might return a simpler object or just a success message.
			// For now, we'll indicate the issue but still confirm deletion happened.
			logger.warn(
				{ sourceId: deletedSource.id },
				'Could not decrypt credentials of deleted source, but deletion was successful.'
			);
			return { ...deletedSource, credentials: null } as unknown as IngestionSource;
		}
		return decryptedSource;
	}

	public static async triggerInitialImport(id: string): Promise<void> {
		const source = await this.findById(id);

		await ingestionQueue.add('initial-import', { ingestionSourceId: source.id });
	}

	public static async mergeFileImportCheckpoint(
		sourceId: string,
		userEmail: string,
		checkpoint: FileImportCheckpoint
	): Promise<void> {
		const mailboxPatch = JSON.stringify({ [userEmail]: checkpoint });
		await db
			.update(ingestionSources)
			.set({
				syncState: sql`jsonb_set(
					COALESCE(${ingestionSources.syncState}, '{}'::jsonb),
					'{fileImport}',
					COALESCE(${ingestionSources.syncState}->'fileImport', '{}'::jsonb) || ${mailboxPatch}::jsonb
				)`,
			})
			.where(eq(ingestionSources.id, sourceId));
	}

	public static canResumeFileImport(source: IngestionSource): boolean {
		if (!this.returnFileBasedIngestions().includes(source.provider)) {
			return false;
		}
		if (['importing', 'syncing'].includes(source.status)) {
			return false;
		}
		const checkpoint = Object.values(source.syncState?.fileImport ?? {})[0];
		if (checkpoint?.complete) {
			return false;
		}
		if (source.status === 'imported') {
			return false;
		}
		return (
			source.status === 'error' ||
			source.status === 'paused' ||
			checkpoint !== undefined
		);
	}

	public static async cancelJobsForSource(sourceId: string): Promise<void> {
		const jobTypes: JobType[] = ['active', 'waiting', 'failed', 'delayed', 'paused'];
		const jobs = await ingestionQueue.getJobs(jobTypes);
		for (const job of jobs) {
			if (job.data.ingestionSourceId !== sourceId) {
				continue;
			}
			try {
				const state = await job.getState();
				if (state === 'active') {
					await job.moveToFailed(new Error('Stopped by user'), '0', true);
				} else {
					await job.remove();
				}
				logger.info(
					{ jobId: job.id, ingestionSourceId: sourceId, state },
					'Cancelled ingestion queue job'
				);
			} catch (error) {
				logger.error(
					{ err: error, jobId: job.id, ingestionSourceId: sourceId },
					'Failed to cancel ingestion queue job'
				);
			}
		}
	}

	public static async stopImport(
		id: string,
		actor?: User,
		actorIp?: string
	): Promise<IngestionSource> {
		const source = await this.findById(id);
		if (!source) {
			throw new Error('Ingestion source not found');
		}

		await this.cancelJobsForSource(id);

		const message =
			source.status === 'importing' || source.status === 'syncing'
				? 'Import stopped by user.'
				: 'Sync stopped by user.';

		const updated = await this.update(
			id,
			{
				status: 'paused',
				lastSyncStatusMessage: message,
			},
			actor,
			actorIp
		);

		if (actor) {
			await this.auditService.createAuditLog({
				actorIdentifier: actor.id,
				actionType: 'SYNC',
				targetType: 'IngestionSource',
				targetId: id,
				actorIp: actorIp || 'unknown',
				details: {
					sourceName: source.name,
					action: 'stop_import',
				},
			});
		}

		return updated;
	}

	public static async triggerResumeImport(
		id: string,
		mode: ResumeImportMode = 'import',
		actor?: User,
		actorIp?: string
	): Promise<void> {
		const source = await this.findById(id);
		if (!source) {
			throw new Error('Ingestion source not found');
		}
		if (!this.canResumeFileImport(source)) {
			throw new Error('This ingestion source cannot be resumed.');
		}

		const connector = EmailProviderFactory.createConnector(source);
		await connector.testConnection();

		await this.cancelJobsForSource(id);

		const resumeLabel =
			mode === 'dedup'
				? 'Resuming duplicate scan from last processed message…'
				: 'Resuming import from last processed message…';

		await this.update(
			id,
			{
				status: 'importing',
				lastSyncStartedAt: new Date(),
				lastSyncStatusMessage: resumeLabel,
			},
			actor,
			actorIp
		);

		if (actor) {
			await this.auditService.createAuditLog({
				actorIdentifier: actor.id,
				actionType: 'SYNC',
				targetType: 'IngestionSource',
				targetId: id,
				actorIp: actorIp || 'unknown',
				details: {
					sourceName: source.name,
					resumeMode: mode,
				},
			});
		}

		await ingestionQueue.add('initial-import', { ingestionSourceId: id, resumeMode: mode });
	}

	public static async triggerForceSync(id: string, actor: User, actorIp: string): Promise<void> {
		const source = await this.findById(id);
		logger.info({ ingestionSourceId: id }, 'Force syncing started.');
		if (!source) {
			throw new Error('Ingestion source not found');
		}

		// Clean up existing jobs for this source to break any stuck flows
		const jobTypes: JobType[] = ['active', 'waiting', 'failed', 'delayed', 'paused'];
		const jobs = await ingestionQueue.getJobs(jobTypes);
		for (const job of jobs) {
			if (job.data.ingestionSourceId === id) {
				try {
					await job.remove();
					logger.info(
						{ jobId: job.id, ingestionSourceId: id },
						'Removed stale job during force sync.'
					);
				} catch (error) {
					logger.error({ err: error, jobId: job.id }, 'Failed to remove stale job.');
				}
			}
		}

		// Reset status to 'active'
		await this.update(
			id,
			{
				status: 'active',
				lastSyncStatusMessage: 'Force sync triggered by user.',
			},
			actor,
			actorIp
		);

		await this.auditService.createAuditLog({
			actorIdentifier: actor.id,
			actionType: 'SYNC',
			targetType: 'IngestionSource',
			targetId: id,
			actorIp,
			details: {
				sourceName: source.name,
			},
		});

		await ingestionQueue.add('continuous-sync', { ingestionSourceId: source.id });

		// If this is a root source, also trigger sync for all non-file-based active/error children
		if (!source.mergedIntoId) {
			const fileBasedProviders = this.returnFileBasedIngestions();
			const children = await db
				.select({
					id: ingestionSources.id,
					provider: ingestionSources.provider,
					status: ingestionSources.status,
				})
				.from(ingestionSources)
				.where(eq(ingestionSources.mergedIntoId, id));

			for (const child of children) {
				if (
					!fileBasedProviders.includes(child.provider) &&
					(child.status === 'active' || child.status === 'error')
				) {
					logger.info(
						{ childId: child.id, parentId: id },
						'Cascading force sync to child source.'
					);
					await ingestionQueue.add('continuous-sync', { ingestionSourceId: child.id });
				}
			}
		}
	}

	public static async performBulkImport(
		job: IInitialImportJob,
		actor: User,
		actorIp: string
	): Promise<void> {
		const { ingestionSourceId } = job;
		const source = await IngestionService.findById(ingestionSourceId);
		if (!source) {
			throw new Error(`Ingestion source ${ingestionSourceId} not found.`);
		}

		logger.info(`Starting bulk import for source: ${source.name} (${source.id})`);
		await IngestionService.update(
			ingestionSourceId,
			{
				status: 'importing',
				lastSyncStartedAt: new Date(),
			},
			actor,
			actorIp
		);

		const connector = EmailProviderFactory.createConnector(source);

		try {
			if (connector.listAllUsers) {
				// For multi-mailbox providers, dispatch a job for each user
				for await (const user of connector.listAllUsers()) {
					const userEmail = user.primaryEmail;
					if (userEmail) {
						await ingestionQueue.add('process-mailbox', {
							ingestionSourceId: source.id,
							userEmail: userEmail,
						});
					}
				}
			} else {
				// For single-mailbox providers, dispatch a single job
				await ingestionQueue.add('process-mailbox', {
					ingestionSourceId: source.id,
					userEmail:
						source.credentials.type === 'generic_imap'
							? source.credentials.username
							: 'Default',
				});
			}
		} catch (error) {
			logger.error(`Bulk import failed for source: ${source.name} (${source.id})`, error);
			await IngestionService.update(
				ingestionSourceId,
				{
					status: 'error',
					lastSyncFinishedAt: new Date(),
					lastSyncStatusMessage:
						error instanceof Error ? error.message : 'An unknown error occurred.',
				},
				actor,
				actorIp
			);
			throw error; // Re-throw to allow BullMQ to handle the job failure
		}
	}

	/**
	 * Pre-fetch duplicate check to avoid unnecessary API calls during ingestion.
	 * Checks both providerMessageId (for Google/Microsoft API IDs) and
	 * messageIdHeader (for IMAP/PST/EML/Mbox RFC Message-IDs and pre-migration rows).
	 *
	 * The check is scoped to the full merge group so that emails already archived
	 * by a sibling source are not re-downloaded and stored again.
	 */
	public static async doesEmailExist(
		messageId: string,
		ingestionSourceId: string,
		dedupCache?: FileImportDedupCache
	): Promise<boolean> {
		if (dedupCache?.hasMessageId(messageId)) {
			return true;
		}
		const groupIds = await this.findGroupSourceIds(ingestionSourceId);
		const sourceFilter =
			groupIds.length === 1
				? eq(archivedEmails.ingestionSourceId, groupIds[0])
				: inArray(archivedEmails.ingestionSourceId, groupIds);

		const existingEmail = await db.query.archivedEmails.findFirst({
			where: and(
				sourceFilter,
				or(
					eq(archivedEmails.providerMessageId, messageId),
					eq(archivedEmails.messageIdHeader, messageId)
				)
			),
			columns: { id: true },
		});
		if (existingEmail) {
			dedupCache?.registerMessage(messageId);
		}
		return !!existingEmail;
	}

	public static async preloadExistingMessageIds(sourceId: string): Promise<{
		knownMessageIds: Set<string>;
		groupSourceIds: string[];
	}> {
		const groupIds = await this.findGroupSourceIds(sourceId);
		const sourceFilter =
			groupIds.length === 1
				? eq(archivedEmails.ingestionSourceId, groupIds[0])
				: inArray(archivedEmails.ingestionSourceId, groupIds);

		const rows = await db
			.select({
				messageIdHeader: archivedEmails.messageIdHeader,
				providerMessageId: archivedEmails.providerMessageId,
			})
			.from(archivedEmails)
			.where(sourceFilter);

		const knownMessageIds = new Set<string>();
		for (const row of rows) {
			if (row.messageIdHeader) knownMessageIds.add(row.messageIdHeader);
			if (row.providerMessageId) knownMessageIds.add(row.providerMessageId);
		}

		return { knownMessageIds, groupSourceIds: groupIds };
	}

	public async processEmail(
		email: EmailObject,
		source: IngestionSource,
		storage: StorageService,
		userEmail: string,
		dedupCache?: FileImportDedupCache,
		groupSourceIds?: string[],
		knownMessageIds?: Set<string>
	): Promise<PendingEmail | null> {
		try {
			// Read the raw bytes from the temp file written by the connector
			const rawEmlBuffer = await readFile(email.tempFilePath);

			// If this source is a child in a merge group, redirect all storage and DB
			// ownership to the root source. Child sources are "assistants" — they fetch
			// emails on behalf of the root but never own any stored content.
			const effectiveSource = source.mergedIntoId
				? await IngestionService.findById(source.mergedIntoId)
				: source;

			// Generate a unique message ID for the email. If the email already has a message-id header, use that.
			// Otherwise, generate a new one based on the email's hash, source ID, and email ID.
			const messageIdHeader = email.headers.get('message-id');
			let messageId: string | undefined;
			if (Array.isArray(messageIdHeader)) {
				messageId = messageIdHeader[0];
			} else if (typeof messageIdHeader === 'string') {
				messageId = messageIdHeader;
			}
			if (!messageId) {
				messageId = `generated-${createHash('sha256')
					.update(rawEmlBuffer)
					.digest('hex')}-${source.id}-${email.id}`;
			}
			// Check if an email with the same message ID has already been imported
			// within the merge group. This prevents duplicate imports when the same
			// email exists in multiple mailboxes or across merged ingestion sources.
			if (dedupCache?.hasMessageId(messageId)) {
				logger.info(
					{ messageId, ingestionSourceId: source.id },
					'Skipping duplicate email (in-memory dedup cache)'
				);
				return null;
			}

			const groupIds = groupSourceIds ?? (await IngestionService.findGroupSourceIds(source.id));
			const groupSourceFilter =
				groupIds.length === 1
					? eq(archivedEmails.ingestionSourceId, groupIds[0])
					: inArray(archivedEmails.ingestionSourceId, groupIds);

			if (knownMessageIds?.has(messageId)) {
				dedupCache?.registerMessage(messageId);
				logger.info(
					{ messageId, ingestionSourceId: source.id },
					'Skipping duplicate email (cached)'
				);
				return null;
			}

			const existingEmail = await db.query.archivedEmails.findFirst({
				where: and(
					groupSourceFilter,
					or(
						eq(archivedEmails.messageIdHeader, messageId),
						eq(archivedEmails.providerMessageId, email.id)
					)
				),
				columns: { id: true },
			});

			if (existingEmail) {
				dedupCache?.registerMessage(messageId);
				knownMessageIds?.add(messageId);
				logger.info(
					{ messageId, ingestionSourceId: source.id },
					'Skipping duplicate email'
				);
				return null;
			}

			const sanitizedPath = email.path
				? email.path.endsWith('/') || email.path.endsWith('\\')
					? email.path
					: `${email.path}/`
				: '';
			// Use effectiveSource (root) for storage path and DB ownership.
			// Child sources are assistants; all content physically belongs to the root.
			const emailPath = `${config.storage.openArchiverFolderName}/${effectiveSource.name.replaceAll(' ', '-')}-${effectiveSource.id}/emails/${sanitizedPath}${email.id}.eml`;

			// GoBD / Preserve Original File mode: store the unmodified raw EML as-is.
			// No attachment stripping, no attachment table records — the full MIME body
			// including attachments is preserved in the single .eml file.
			// Use the root (effectiveSource) compliance mode as authoritative.
			if (effectiveSource.preserveOriginalFile) {
				const emailHash = createHash('sha256').update(rawEmlBuffer).digest('hex');

				// Message-level deduplication by file hash, scoped to the effective (root) source
				const hashDuplicate = await db.query.archivedEmails.findFirst({
					where: and(
						eq(archivedEmails.storageHashSha256, emailHash),
						eq(archivedEmails.ingestionSourceId, effectiveSource.id)
					),
					columns: { id: true },
				});

				if (hashDuplicate || dedupCache?.hasContentHash(emailHash)) {
					if (emailHash) {
						dedupCache?.registerMessage(messageId, emailHash);
					}
					logger.info(
						{ emailHash, ingestionSourceId: effectiveSource.id },
						'Skipping duplicate email (hash-level dedup, preserve original mode)'
					);
					return null;
				}

				// Store the unmodified raw buffer — no modifications
				await storage.put(emailPath, rawEmlBuffer);

				const [archivedEmail] = await db
					.insert(archivedEmails)
					.values({
						// Always assign to root (effectiveSource)
						ingestionSourceId: effectiveSource.id,
						userEmail,
						threadId: email.threadId,
						messageIdHeader: messageId,
						providerMessageId: email.id,
						sentAt: email.receivedAt,
						subject: email.subject,
						senderName: email.from[0]?.name,
						senderEmail: email.from[0]?.address,
						recipients: {
							to: email.to,
							cc: email.cc,
							bcc: email.bcc,
						},
						storagePath: emailPath,
						storageHashSha256: emailHash,
						sizeBytes: rawEmlBuffer.length,
						hasAttachments: email.attachments.length > 0,
						path: email.path,
						tags: email.tags,
					})
					.onConflictDoNothing()
					.returning();

				if (!archivedEmail) {
					logger.info(
						{ messageId, ingestionSourceId: effectiveSource.id },
						'Skipping duplicate email (DB constraint, preserve original mode)'
					);
					return null;
				}

				const indexingHint = buildIndexingHint(email);
				dedupCache?.registerMessage(messageId, emailHash);
				knownMessageIds?.add(messageId);
				return {
					archivedEmailId: archivedEmail.id,
					...(indexingHint ? { indexingHint } : {}),
				};
			}

			// Default mode: strip non-inline attachments from the .eml to avoid double-storing
			// attachment data (attachments are stored separately). Connectors that already
			// wrote a body-only EML (e.g. PST fast path) skip the extra mailparser pass.
			const emlBuffer = email.emlAttachmentsStripped
				? rawEmlBuffer
				: await stripAttachmentsFromEml(rawEmlBuffer);
			const emailHash = createHash('sha256').update(emlBuffer).digest('hex');

			if (dedupCache?.hasContentHash(emailHash)) {
				dedupCache.registerMessage(messageId, emailHash);
				logger.info(
					{ emailHash, ingestionSourceId: effectiveSource.id },
					'Skipping duplicate email (hash-level dedup cache)'
				);
				return null;
			}

			await storage.put(emailPath, emlBuffer);

			const [archivedEmail] = await db
				.insert(archivedEmails)
				.values({
					// Always assign to root (effectiveSource)
					ingestionSourceId: effectiveSource.id,
					userEmail,
					threadId: email.threadId,
					messageIdHeader: messageId,
					providerMessageId: email.id,
					sentAt: email.receivedAt,
					subject: email.subject,
					senderName: email.from[0]?.name,
					senderEmail: email.from[0]?.address,
					recipients: {
						to: email.to,
						cc: email.cc,
						bcc: email.bcc,
					},
					storagePath: emailPath,
					storageHashSha256: emailHash,
					sizeBytes: emlBuffer.length,
					hasAttachments: email.attachments.length > 0,
					path: email.path,
					tags: email.tags,
				})
				.onConflictDoNothing()
				.returning();

			if (!archivedEmail) {
				logger.info(
					{ messageId, ingestionSourceId: effectiveSource.id },
					'Skipping duplicate email (DB constraint)'
				);
				return null;
			}

			if (email.attachments.length > 0) {
				await mapWithConcurrency(
					email.attachments,
					config.resources.attachmentStorageConcurrency,
					async (attachment) => {
						const attachmentTempPath = attachment.tempFilePath;
						const readContent = attachment.readContent;
						const attachmentBuffer =
							!attachmentTempPath && !readContent ? attachment.content : null;

						let attachmentId: string | undefined;
						let attachmentHash = '';
						let storedSize = attachment.size;

						const resolveExistingAttachmentId = async (
							hash: string
						): Promise<string | undefined> => {
							const cachedId = dedupCache?.getAttachmentId(hash);
							if (cachedId) {
								return cachedId;
							}
							const existingAttachment = await db.query.attachments.findFirst({
								where: and(
									eq(attachmentsSchema.contentHashSha256, hash),
									eq(attachmentsSchema.ingestionSourceId, effectiveSource.id)
								),
							});
							if (existingAttachment) {
								dedupCache?.registerAttachmentHash(hash, existingAttachment.id);
								logger.info(
									{
										attachmentHash: hash,
										ingestionSourceId: effectiveSource.id,
										reusedPath: existingAttachment.storagePath,
									},
									'Reusing existing attachment file for deduplication.'
								);
								return existingAttachment.id;
							}
							return undefined;
						};

						try {
							if (readContent) {
								const hashProbe = await hashReadableStream(readContent() as Readable);
								attachmentHash = hashProbe.hash;
								storedSize = hashProbe.size;
								attachmentId = await resolveExistingAttachmentId(attachmentHash);

								if (!attachmentId) {
									const uniqueId = randomUUID().slice(0, 7);
									const storagePath = `${config.storage.openArchiverFolderName}/${effectiveSource.name.replaceAll(' ', '-')}-${effectiveSource.id}/attachments/${uniqueId}-${attachment.filename}`;
									const stored = await storage.putFromStreamWithHash(
										storagePath,
										readContent() as Readable
									);
									attachmentHash = stored.hash;
									storedSize = stored.size;

									const [newRecord] = await db
										.insert(attachmentsSchema)
										.values({
											filename: attachment.filename,
											mimeType: attachment.contentType,
											sizeBytes: storedSize,
											contentHashSha256: attachmentHash,
											storagePath,
											ingestionSourceId: effectiveSource.id,
										})
										.returning();
									attachmentId = newRecord.id;
									dedupCache?.registerAttachmentHash(attachmentHash, attachmentId);
								}
							} else if (attachmentTempPath) {
								const hashProbe = await hashReadableStream(
									createReadStream(attachmentTempPath)
								);
								attachmentHash = hashProbe.hash;
								storedSize = hashProbe.size;
								attachmentId = await resolveExistingAttachmentId(attachmentHash);

								if (!attachmentId) {
									const uniqueId = randomUUID().slice(0, 7);
									const storagePath = `${config.storage.openArchiverFolderName}/${effectiveSource.name.replaceAll(' ', '-')}-${effectiveSource.id}/attachments/${uniqueId}-${attachment.filename}`;
									const stored = await storage.putFromFileWithHash(
										storagePath,
										attachmentTempPath
									);
									attachmentHash = stored.hash;
									storedSize = stored.size;

									const [newRecord] = await db
										.insert(attachmentsSchema)
										.values({
											filename: attachment.filename,
											mimeType: attachment.contentType,
											sizeBytes: storedSize,
											contentHashSha256: attachmentHash,
											storagePath,
											ingestionSourceId: effectiveSource.id,
										})
										.returning();
									attachmentId = newRecord.id;
									dedupCache?.registerAttachmentHash(attachmentHash, attachmentId);
								}
							} else {
								attachmentHash = createHash('sha256')
									.update(attachmentBuffer!)
									.digest('hex');
								attachmentId = await resolveExistingAttachmentId(attachmentHash);

								if (!attachmentId) {
									const uniqueId = randomUUID().slice(0, 7);
									const storagePath = `${config.storage.openArchiverFolderName}/${effectiveSource.name.replaceAll(' ', '-')}-${effectiveSource.id}/attachments/${uniqueId}-${attachment.filename}`;
									await storage.put(storagePath, attachmentBuffer!);

									const [newRecord] = await db
										.insert(attachmentsSchema)
										.values({
											filename: attachment.filename,
											mimeType: attachment.contentType,
											sizeBytes: attachment.size,
											contentHashSha256: attachmentHash,
											storagePath,
											ingestionSourceId: effectiveSource.id,
										})
										.returning();
									attachmentId = newRecord.id;
									dedupCache?.registerAttachmentHash(attachmentHash, attachmentId);
								}
							}

							if (!attachmentId) {
								return;
							}

							await db
								.insert(emailAttachments)
								.values({
									emailId: archivedEmail.id,
									attachmentId,
								})
								.onConflictDoNothing();
						} finally {
							if (attachmentTempPath) {
								await unlink(attachmentTempPath).catch((err) =>
									logger.warn(
										{ err, attachmentTempPath },
										'Failed to delete temp attachment file'
									)
								);
							}
						}
					}
				);
			}

			const indexingHint = buildIndexingHint(email);
			dedupCache?.registerMessage(messageId, emailHash);
			knownMessageIds?.add(messageId);
			return {
				archivedEmailId: archivedEmail.id,
				...(indexingHint ? { indexingHint } : {}),
			};
		} catch (error) {
			logger.error({
				message: `Failed to process email ${email.id} for source ${source.id}`,
				error,
				emailId: email.id,
				ingestionSourceId: source.id,
			});
			return null;
		} finally {
			// Always clean up the temp file, regardless of success or failure
			await unlink(email.tempFilePath).catch((err) =>
				logger.warn(
					{ err, tempFilePath: email.tempFilePath },
					'Failed to delete temp email file'
				)
			);
		}
	}

	public static async getDiagnostics(
		sourceId: string,
		userId: string
	): Promise<IngestionDiagnostics> {
		const source = await this.findByIdForUser(sourceId, userId);
		const groupIds = await this.findGroupSourceIds(sourceId);
		const sourceFilter =
			groupIds.length === 1
				? eq(archivedEmails.ingestionSourceId, groupIds[0])
				: inArray(archivedEmails.ingestionSourceId, groupIds);

		const [[archivedRow], [indexedRow]] = await Promise.all([
			db.select({ value: count() }).from(archivedEmails).where(sourceFilter),
			db
				.select({ value: count() })
				.from(archivedEmails)
				.where(and(sourceFilter, eq(archivedEmails.isIndexed, true))),
		]);

		const archivedEmailCount = Number(archivedRow?.value ?? 0);
		const indexedEmailCount = Number(indexedRow?.value ?? 0);
		const pendingIndexCount = Math.max(0, archivedEmailCount - indexedEmailCount);

		const session = await SyncSessionService.findLatestBySourceId(sourceId);
		const sessionInProgress =
			session !== null &&
			session.completedMailboxes + session.failedMailboxes < session.totalMailboxes;

		const activeSyncSession =
			session && sessionInProgress
				? {
						id: session.id,
						isInitialImport: session.isInitialImport,
						totalMailboxes: session.totalMailboxes,
						completedMailboxes: session.completedMailboxes,
						failedMailboxes: session.failedMailboxes,
						errorMessages: session.errorMessages,
						lastActivityAt: session.lastActivityAt.toISOString(),
					}
				: null;

		const jobTypes = ['active', 'waiting', 'failed'] as const;
		const diagnosticsJobScanLimit = 20;
		const [ingestionJobs, indexingJobs] = await Promise.all([
			ingestionQueue.getJobs([...jobTypes], 0, diagnosticsJobScanLimit, true),
			indexingQueue.getJobs([...jobTypes], 0, diagnosticsJobScanLimit, true),
		]);

		const matchesSource = (job: { data?: { ingestionSourceId?: string } }) =>
			job.data?.ingestionSourceId === sourceId;

		const ingestionForSource = ingestionJobs.filter(matchesSource);
		const indexingForSource = indexingJobs.filter(matchesSource);

		const failedJobs = (
			await Promise.all(
				[...ingestionForSource, ...indexingForSource].map(async (job) => ({
					job,
					state: await job.getState(),
				}))
			)
		).filter(({ state }) => state === 'failed');

		const recentFailures = (
			await Promise.all(
				failedJobs.slice(0, 10).map(async ({ job }) => ({
					queue: ingestionForSource.includes(job)
						? ('ingestion' as const)
						: ('indexing' as const),
					id: String(job.id),
					name: job.name,
					state: 'failed',
					failedReason: job.failedReason,
					stacktrace: job.stacktrace,
					timestamp: job.timestamp,
				}))
			)
		).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

		let ingestionActiveCount = 0;
		let ingestionWaitingCount = 0;
		let indexingActiveCount = 0;
		let indexingWaitingCount = 0;
		for (const job of ingestionForSource) {
			const state = await job.getState();
			if (state === 'active') ingestionActiveCount++;
			if (state === 'waiting' || state === 'delayed') ingestionWaitingCount++;
		}
		for (const job of indexingForSource) {
			const state = await job.getState();
			if (state === 'active') indexingActiveCount++;
			if (state === 'waiting' || state === 'delayed') indexingWaitingCount++;
		}

		let phase: IngestionDiagnostics['progress']['phase'] = 'idle';
		let label = 'Idle';
		let isIndeterminate = false;
		let mailboxPercent: number | null = null;
		let indexingPercent =
			archivedEmailCount > 0
				? Math.round((indexedEmailCount / archivedEmailCount) * 100)
				: null;

		if (source.status === 'error') {
			phase = 'error';
			label = source.lastSyncStatusMessage || 'Error';
		} else if (
			source.status === 'importing' ||
			source.status === 'syncing' ||
			activeSyncSession ||
			ingestionActiveCount > 0
		) {
			phase = 'importing';
			if (activeSyncSession && activeSyncSession.totalMailboxes > 0) {
				const processed =
					activeSyncSession.completedMailboxes + activeSyncSession.failedMailboxes;
				mailboxPercent = Math.round(
					(processed / activeSyncSession.totalMailboxes) * 100
				);
				if (processed === 0 && archivedEmailCount > 0) {
					isIndeterminate = true;
					label = `Importing… ${archivedEmailCount.toLocaleString()} emails archived`;
				} else {
					label = `Importing mailboxes ${processed}/${activeSyncSession.totalMailboxes}`;
				}
			} else if (archivedEmailCount > 0) {
				isIndeterminate = true;
				label = `Importing… ${archivedEmailCount.toLocaleString()} emails archived`;
			} else {
				isIndeterminate = true;
				label = 'Import in progress…';
			}
		} else if (pendingIndexCount > 0 || indexingActiveCount > 0 || indexingWaitingCount > 0) {
			phase = 'indexing';
			label = `Indexing ${indexedEmailCount.toLocaleString()} / ${archivedEmailCount.toLocaleString()} emails`;
		} else if (archivedEmailCount > 0) {
			phase = 'complete';
			label = `${archivedEmailCount.toLocaleString()} emails archived`;
		}

		return {
			sourceId,
			status: source.status,
			provider: source.provider,
			lastSyncStatusMessage: source.lastSyncStatusMessage,
			lastSyncStartedAt: source.lastSyncStartedAt?.toISOString() ?? null,
			lastSyncFinishedAt: source.lastSyncFinishedAt?.toISOString() ?? null,
			archivedEmailCount,
			indexedEmailCount,
			pendingIndexCount,
			activeSyncSession,
			queue: {
				ingestionActive: ingestionActiveCount,
				ingestionWaiting: ingestionWaitingCount,
				indexingActive: indexingActiveCount,
				indexingWaiting: indexingWaitingCount,
				recentFailures,
			},
			progress: {
				phase,
				mailboxPercent,
				indexingPercent,
				label,
				isIndeterminate,
			},
			resume: (() => {
				const canResume = this.canResumeFileImport(source);
				const mailboxEmail = Object.keys(source.syncState?.fileImport ?? {})[0];
				const checkpoint = mailboxEmail
					? getFileImportCheckpoint(source.syncState, mailboxEmail)
					: undefined;
				return {
					available: canResume,
					lastGlobalIndex: checkpoint?.lastGlobalIndex ?? null,
					lastMessageId: checkpoint?.lastMessageId ?? null,
					lastPath: checkpoint?.lastPath ?? null,
				};
			})(),
		};
	}
}
