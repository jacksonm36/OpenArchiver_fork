import archiver from 'archiver';
import { eq, and, inArray, asc, count, SQL } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { db } from '../database';
import {
	archivedEmails,
	attachments,
	emailAttachments,
} from '../database/schema';
import { StorageService } from './StorageService';
import { FilterBuilder } from './FilterBuilder';
import { IngestionService } from './IngestionService';
import {
	escapeMboxFromLines,
	formatMboxFromLine,
	rebuildEmlWithAttachments,
	type ExportAttachmentPart,
} from '../helpers/emlUtils';
import {
	attachExportAbort,
	clearZipEntryNames,
	createExportProgress,
	setExportSummaryHeaders,
	uniqueZipEntryName,
	writeResponseChunk,
	type ExportProgress,
} from '../helpers/exportStreamUtils';
import { logger } from '../config/logger';

export type ArchiveExportFormat = 'eml' | 'mbox' | 'zip';

const EXPORT_BATCH_SIZE = 100;

function sanitizeExportFilename(name: string, fallback: string): string {
	const base = (name || fallback)
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 120);
	return base || fallback;
}

function emlEntryName(email: typeof archivedEmails.$inferSelect, index: number): string {
	const folder = email.path
		? email.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
		: '';
	const subject = sanitizeExportFilename(email.subject || '', `email-${index}`);
	const id = email.id.slice(0, 8);
	const fileName = `${subject}-${id}.eml`;
	return folder ? `${folder}/${fileName}` : fileName;
}

export class ExportService {
	constructor(private storage = new StorageService()) {}

	private async loadExportAttachments(emailId: string): Promise<ExportAttachmentPart[]> {
		const rows = await db
			.select({
				filename: attachments.filename,
				mimeType: attachments.mimeType,
				storagePath: attachments.storagePath,
			})
			.from(emailAttachments)
			.innerJoin(attachments, eq(emailAttachments.attachmentId, attachments.id))
			.where(eq(emailAttachments.emailId, emailId));

		const parts: ExportAttachmentPart[] = [];
		for (const row of rows) {
			const content = await this.storage.readPlaintext(row.storagePath);
			parts.push({
				filename: row.filename,
				contentType: row.mimeType ?? 'application/octet-stream',
				content,
			});
		}
		return parts;
	}

	private async buildEmlBufferForEmail(
		email: typeof archivedEmails.$inferSelect,
		preserveOriginalFile: boolean
	): Promise<Buffer> {
		const emlBuffer = await this.storage.readPlaintext(email.storagePath);

		if (preserveOriginalFile || !email.hasAttachments) {
			return emlBuffer;
		}

		const attachmentParts = await this.loadExportAttachments(email.id);
		if (attachmentParts.length === 0) {
			return emlBuffer;
		}

		return rebuildEmlWithAttachments(emlBuffer, attachmentParts);
	}

	/** Build standard RFC822 bytes (decompressed, attachments reattached when needed). */
	async buildExportEml(emailId: string, userId: string): Promise<Buffer> {
		const { drizzleFilter } = await FilterBuilder.create(userId, 'archive', 'read');
		const email = await db.query.archivedEmails.findFirst({
			where: drizzleFilter
				? and(eq(archivedEmails.id, emailId), drizzleFilter)
				: eq(archivedEmails.id, emailId),
		});

		if (!email) {
			throw new Error('Archived email not found');
		}

		const source = await IngestionService.findByIdForUser(email.ingestionSourceId, userId);
		return this.buildEmlBufferForEmail(email, source.preserveOriginalFile ?? false);
	}

	private async buildSourceEmailFilter(
		ingestionSourceId: string,
		userId: string
	): Promise<{ where: SQL | undefined; groupIds: string[] }> {
		const { drizzleFilter } = await FilterBuilder.create(userId, 'archive', 'read');
		const groupIds = await IngestionService.findGroupSourceIds(ingestionSourceId);
		const sourceFilter =
			groupIds.length === 1
				? eq(archivedEmails.ingestionSourceId, groupIds[0])
				: inArray(archivedEmails.ingestionSourceId, groupIds);

		const where = drizzleFilter ? and(sourceFilter, drizzleFilter) : sourceFilter;
		return { where, groupIds };
	}

	private async countEmailsForExport(
		ingestionSourceId: string,
		userId: string
	): Promise<number> {
		const { where } = await this.buildSourceEmailFilter(ingestionSourceId, userId);
		const [row] = await db
			.select({ total: count() })
			.from(archivedEmails)
			.where(where);
		return row?.total ?? 0;
	}

	private async *iterateEmailsForExport(
		ingestionSourceId: string,
		userId: string
	): AsyncGenerator<typeof archivedEmails.$inferSelect> {
		const { where } = await this.buildSourceEmailFilter(ingestionSourceId, userId);
		let offset = 0;

		while (true) {
			const batch = await db
				.select()
				.from(archivedEmails)
				.where(where)
				.orderBy(asc(archivedEmails.sentAt))
				.limit(EXPORT_BATCH_SIZE)
				.offset(offset);

			if (batch.length === 0) {
				break;
			}

			for (const email of batch) {
				yield email;
			}

			offset += batch.length;
		}
	}

	async streamSingleEmlExport(
		emailId: string,
		userId: string,
		res: Response
	): Promise<void> {
		const eml = await this.buildExportEml(emailId, userId);
		const email = await db.query.archivedEmails.findFirst({
			where: eq(archivedEmails.id, emailId),
		});
		const fileName = sanitizeExportFilename(email?.subject || '', 'message') + '.eml';

		res.setHeader('Content-Type', 'message/rfc822');
		res.setHeader(
			'Content-Disposition',
			`attachment; filename="${fileName.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
		);
		res.send(eml);
	}

	async streamMboxExport(
		ingestionSourceId: string,
		userId: string,
		res: Response,
		req?: Request
	): Promise<void> {
		const source = await IngestionService.findByIdForUser(ingestionSourceId, userId);
		const preserveOriginalFile = source.preserveOriginalFile ?? false;

		const fileName = sanitizeExportFilename(source.name, 'export') + '.mbox';
		res.setHeader('Content-Type', 'application/mbox');
		res.setHeader(
			'Content-Disposition',
			`attachment; filename="${fileName.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
		);

		const progress = createExportProgress();
		progress.total = await this.countEmailsForExport(ingestionSourceId, userId);
		if (req) {
			attachExportAbort(req, progress);
		}
		res.setHeader('X-Export-Total', String(progress.total));

		let index = 0;

		for await (const email of this.iterateEmailsForExport(ingestionSourceId, userId)) {
			if (progress.aborted) {
				break;
			}

			try {
				const emlBuffer = await this.buildEmlBufferForEmail(email, preserveOriginalFile);
				const fromLine = formatMboxFromLine(
					email.senderEmail || 'unknown@local',
					email.sentAt
				);
				const body = escapeMboxFromLines(emlBuffer);

				if (!(await writeResponseChunk(res, fromLine))) {
					progress.aborted = true;
					break;
				}
				if (!(await writeResponseChunk(res, body))) {
					progress.aborted = true;
					break;
				}
				if (body.length === 0 || body[body.length - 1] !== 0x0a) {
					if (!(await writeResponseChunk(res, '\n'))) {
						progress.aborted = true;
						break;
					}
				}
				if (!(await writeResponseChunk(res, '\n'))) {
					progress.aborted = true;
					break;
				}

				progress.exported += 1;
			} catch (error) {
				progress.skipped += 1;
				logger.warn({ error, emailId: email.id }, 'Skipping email during mbox export');
			}

			index += 1;
			if (index % EXPORT_BATCH_SIZE === 0) {
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		}

		setExportSummaryHeaders(res, progress);
		logger.info(
			{
				ingestionSourceId,
				total: progress.total,
				exported: progress.exported,
				skipped: progress.skipped,
				aborted: progress.aborted,
			},
			'Mbox export finished'
		);
		res.end();
	}

	/**
	 * ZIP of .eml files (folder layout from PST/mbox paths).
	 * Re-import via EML zip or Mbox import on another Open Archiver instance.
	 */
	async streamZipExport(
		ingestionSourceId: string,
		userId: string,
		res: Response,
		req?: Request
	): Promise<void> {
		const source = await IngestionService.findByIdForUser(ingestionSourceId, userId);
		const preserveOriginalFile = source.preserveOriginalFile ?? false;

		const fileName = sanitizeExportFilename(source.name, 'export') + '-eml.zip';
		res.setHeader('Content-Type', 'application/zip');
		res.setHeader(
			'Content-Disposition',
			`attachment; filename="${fileName.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
		);

		const progress = createExportProgress();
		progress.total = await this.countEmailsForExport(ingestionSourceId, userId);
		if (req) {
			attachExportAbort(req, progress);
		}
		res.setHeader('X-Export-Total', String(progress.total));

		const exportKey = `${ingestionSourceId}-${Date.now()}`;
		const archive = archiver('zip', { zlib: { level: 6 } });

		const finalizePromise = new Promise<void>((resolve, reject) => {
			archive.on('error', reject);
			archive.on('end', () => resolve());
		});

		archive.on('error', (err) => {
			logger.error({ err }, 'ZIP export failed');
			if (!res.headersSent) {
				res.status(500).end();
			}
		});
		archive.pipe(res);

		let index = 0;

		try {
			for await (const email of this.iterateEmailsForExport(ingestionSourceId, userId)) {
				if (progress.aborted) {
					break;
				}

				try {
					const emlBuffer = await this.buildEmlBufferForEmail(email, preserveOriginalFile);
					const entryName = uniqueZipEntryName(exportKey, emlEntryName(email, index));
					archive.append(emlBuffer, { name: entryName });
					progress.exported += 1;
				} catch (error) {
					progress.skipped += 1;
					logger.warn({ error, emailId: email.id }, 'Skipping email during zip export');
				}

				index += 1;
				if (index % EXPORT_BATCH_SIZE === 0) {
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
			}

			archive.append(
				Buffer.from(
					JSON.stringify(
						{
							format: 'eml-zip',
							ingestionSourceId,
							sourceName: source.name,
							total: progress.total,
							exported: progress.exported,
							skipped: progress.skipped,
							aborted: progress.aborted,
							exportedAt: new Date().toISOString(),
						},
						null,
						2
					),
					'utf8'
				),
				{ name: '_export_manifest.json' }
			);

			setExportSummaryHeaders(res, progress);
			logger.info(
				{
					ingestionSourceId,
					total: progress.total,
					exported: progress.exported,
					skipped: progress.skipped,
					aborted: progress.aborted,
				},
				'ZIP export finished'
			);
			await archive.finalize();
			await finalizePromise;
		} finally {
			clearZipEntryNames(exportKey);
		}
	}
}
