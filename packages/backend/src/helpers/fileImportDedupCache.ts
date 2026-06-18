import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../database';
import { archivedEmails, attachments as attachmentsSchema } from '../database/schema';
import { IngestionService } from '../services/IngestionService';

/**
 * In-memory dedup sets for file-based imports (PST/EML/Mbox).
 * Avoids per-message Postgres round-trips during large imports and resume scans.
 */
export class FileImportDedupCache {
	private readonly messageIds = new Set<string>();
	private readonly contentHashes = new Set<string>();
	private readonly attachmentHashes = new Set<string>();
	private readonly attachmentHashToId = new Map<string, string>();

	constructor(readonly effectiveSourceId: string) {}

	static async load(ingestionSourceId: string): Promise<FileImportDedupCache> {
		const source = await IngestionService.findById(ingestionSourceId);
		if (!source) {
			throw new Error(`Ingestion source ${ingestionSourceId} not found`);
		}
		const effectiveSourceId = source.mergedIntoId ?? source.id;
		const groupIds = await IngestionService.findGroupSourceIds(ingestionSourceId);

		const sourceFilter =
			groupIds.length === 1
				? eq(archivedEmails.ingestionSourceId, groupIds[0])
				: inArray(archivedEmails.ingestionSourceId, groupIds);

		const cache = new FileImportDedupCache(effectiveSourceId);

		const emailRows = await db
			.select({
				messageIdHeader: archivedEmails.messageIdHeader,
				providerMessageId: archivedEmails.providerMessageId,
				storageHashSha256: archivedEmails.storageHashSha256,
			})
			.from(archivedEmails)
			.where(sourceFilter);

		for (const row of emailRows) {
			if (row.messageIdHeader) {
				cache.messageIds.add(row.messageIdHeader);
			}
			if (row.providerMessageId) {
				cache.messageIds.add(row.providerMessageId);
			}
			if (row.storageHashSha256) {
				cache.contentHashes.add(row.storageHashSha256);
			}
		}

		const attachmentRows = await db
			.select({
				id: attachmentsSchema.id,
				contentHashSha256: attachmentsSchema.contentHashSha256,
			})
			.from(attachmentsSchema)
			.where(eq(attachmentsSchema.ingestionSourceId, effectiveSourceId));

		for (const row of attachmentRows) {
			if (row.contentHashSha256) {
				cache.attachmentHashes.add(row.contentHashSha256);
				cache.attachmentHashToId.set(row.contentHashSha256, row.id);
			}
		}

		return cache;
	}

	hasMessageId(messageId: string): boolean {
		return this.messageIds.has(messageId);
	}

	hasContentHash(hash: string): boolean {
		return this.contentHashes.has(hash);
	}

	hasAttachmentHash(hash: string): boolean {
		return this.attachmentHashes.has(hash);
	}

	getAttachmentId(hash: string): string | undefined {
		return this.attachmentHashToId.get(hash);
	}

	registerMessage(messageId: string, contentHash?: string): void {
		this.messageIds.add(messageId);
		if (contentHash) {
			this.contentHashes.add(contentHash);
		}
	}

	registerAttachmentHash(hash: string, attachmentId: string): void {
		this.attachmentHashes.add(hash);
		this.attachmentHashToId.set(hash, attachmentId);
	}
}
