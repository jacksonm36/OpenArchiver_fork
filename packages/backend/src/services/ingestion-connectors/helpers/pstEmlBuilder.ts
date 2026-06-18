import type { EmailAddress } from '@open-archiver/types';
import type { PSTMessage, PSTAttachment } from 'pst-extractor';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { finished } from 'stream/promises';
import {
	PST_ATTACHMENT_READ_CHUNK,
	readPstAttachmentToBuffer,
	createPstAttachmentContentReader,
} from './pstAttachmentStream';
const BOUNDARY = '----boundary-openarchiver';
const ALT_BOUNDARY = '----boundary-openarchiver_alt';

export function parseDisplayAddressList(display?: string | null): EmailAddress[] {
	if (!display) {
		return [];
	}

	return display
		.split(';')
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => {
			const angleMatch = part.match(/^(.*)<([^>]+)>$/);
			if (angleMatch) {
				return {
					name: angleMatch[1].trim().replace(/^"|"$/g, ''),
					address: angleMatch[2].trim().replaceAll("'", ''),
				};
			}

			return {
				name: part,
				address: part.replaceAll("'", ''),
			};
		});
}

export function buildPstHeadersMap(msg: PSTMessage): Map<string, string | string[]> {
	const headers = new Map<string, string | string[]>();

	if (msg.internetMessageId) {
		headers.set('message-id', `<${msg.internetMessageId}>`);
	}
	if (msg.inReplyToId) {
		const inReplyTo =
			typeof msg.inReplyToId === 'string' ? msg.inReplyToId : String(msg.inReplyToId);
		headers.set('in-reply-to', inReplyTo);
	}
	if (msg.conversationId) {
		const conversationId =
			typeof msg.conversationId === 'string'
				? msg.conversationId
				: Buffer.isBuffer(msg.conversationId)
					? msg.conversationId.toString('utf8')
					: String(msg.conversationId);
		headers.set('conversation-id', conversationId);
	}

	return headers;
}

export function getPstThreadId(msg: PSTMessage): string | undefined {
	const inReplyTo =
		typeof msg.inReplyToId === 'string'
			? msg.inReplyToId
			: msg.inReplyToId
				? String(msg.inReplyToId)
				: undefined;
	if (inReplyTo) {
		return inReplyTo.trim();
	}
	const conversationId =
		typeof msg.conversationId === 'string'
			? msg.conversationId
			: msg.conversationId
				? String(msg.conversationId)
				: undefined;
	if (conversationId) {
		return conversationId.trim();
	}
	if (msg.internetMessageId) {
		return `<${msg.internetMessageId}>`;
	}
	return undefined;
}

export function getPstMessageId(msg: PSTMessage, emlBuffer: Buffer): string {
	if (msg.internetMessageId) {
		return msg.internetMessageId;
	}

	return `generated-${createHash('sha256').update(emlBuffer).digest('hex')}-${createHash('sha256')
		.update(msg.subject || '')
		.digest('hex')}-${msg.clientSubmitTime?.getTime() ?? 0}`;
}

function buildHeaderBlock(msg: PSTMessage): string {
	let headers = '';

	if (msg.senderName || msg.senderEmailAddress) {
		headers += `From: ${msg.senderName || ''} <${msg.senderEmailAddress || ''}>\n`;
	}
	if (msg.displayTo) {
		headers += `To: ${msg.displayTo}\n`;
	}
	if (msg.displayCC) {
		headers += `Cc: ${msg.displayCC}\n`;
	}
	if (msg.displayBCC) {
		headers += `Bcc: ${msg.displayBCC}\n`;
	}
	if (msg.subject) {
		headers += `Subject: ${msg.subject}\n`;
	}
	if (msg.clientSubmitTime) {
		headers += `Date: ${new Date(msg.clientSubmitTime).toUTCString()}\n`;
	}
	if (msg.internetMessageId) {
		headers += `Message-ID: <${msg.internetMessageId}>\n`;
	}
	if (msg.inReplyToId) {
		headers += `In-Reply-To: ${msg.inReplyToId}\n`;
	}
	if (msg.conversationId) {
		headers += `Conversation-Id: ${msg.conversationId}\n`;
	}
	headers += 'MIME-Version: 1.0\n';

	return headers;
}

/**
 * Body-only EML for default ingestion mode. Attachments are stored separately.
 */
export function buildBodyOnlyEml(msg: PSTMessage): Buffer {
	let eml = buildHeaderBlock(msg);
	eml += `Content-Type: multipart/alternative; boundary="${ALT_BOUNDARY}"\n\n`;

	if (msg.body) {
		eml += `--${ALT_BOUNDARY}\n`;
		eml += 'Content-Type: text/plain; charset="utf-8"\n\n';
		eml += `${msg.body}\n\n`;
	}

	if (msg.bodyHTML) {
		eml += `--${ALT_BOUNDARY}\n`;
		eml += 'Content-Type: text/html; charset="utf-8"\n\n';
		eml += `${msg.bodyHTML}\n\n`;
	}

	if (msg.body || msg.bodyHTML) {
		eml += `--${ALT_BOUNDARY}--\n`;
	}

	return Buffer.from(eml, 'utf-8');
}

async function writeStreamChunk(
	writeStream: NodeJS.WritableStream,
	data: string | Buffer
): Promise<void> {
	const chunk = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
	const canContinue = writeStream.write(chunk);
	if (!canContinue) {
		await new Promise<void>((resolve, reject) => {
			writeStream.once('drain', resolve);
			writeStream.once('error', reject);
		});
	}
}

async function streamPstAttachmentAsBase64(
	attachment: PSTAttachment,
	writeStream: NodeJS.WritableStream
): Promise<void> {
	const attachmentStream = attachment.fileInputStream;
	if (!attachmentStream) {
		return;
	}

	const readBuffer = Buffer.alloc(PST_ATTACHMENT_READ_CHUNK);
	let bytesRead: number;
	do {
		bytesRead = attachmentStream.read(readBuffer);
		if (bytesRead > 0) {
			await writeStreamChunk(
				writeStream,
				readBuffer.subarray(0, bytesRead).toString('base64')
			);
		}
	} while (bytesRead === PST_ATTACHMENT_READ_CHUNK);
}

/**
 * Full EML including attachment payloads for preserve-original (GoBD) mode.
 * When streamAttachments is true, writes directly to a temp file without holding
 * attachment bytes in memory.
 */
export async function buildFullEmlToTemp(
	msg: PSTMessage,
	streamAttachments: boolean
): Promise<{ tempFilePath: string; buffer: Buffer }> {
	if (!streamAttachments) {
		const buffer = buildFullEml(msg);
		return { buffer, tempFilePath: '' };
	}

	const tempFilePath = join(tmpdir(), `oa-email-${randomUUID()}.eml`);
	const writeStream = createWriteStream(tempFilePath);
	const headerBlock = buildHeaderBlock(msg);

	try {
		if (msg.hasAttachments) {
			await writeStreamChunk(
				writeStream,
				`${headerBlock}Content-Type: multipart/mixed; boundary="${BOUNDARY}"\n\n--${BOUNDARY}\nContent-Type: multipart/alternative; boundary="${ALT_BOUNDARY}"\n\n`
			);
		} else {
			await writeStreamChunk(
				writeStream,
				`${headerBlock}Content-Type: multipart/alternative; boundary="${ALT_BOUNDARY}"\n\n`
			);
		}

		if (msg.body) {
			await writeStreamChunk(
				writeStream,
				`--${ALT_BOUNDARY}\nContent-Type: text/plain; charset="utf-8"\n\n${msg.body}\n\n`
			);
		}

		if (msg.bodyHTML) {
			await writeStreamChunk(
				writeStream,
				`--${ALT_BOUNDARY}\nContent-Type: text/html; charset="utf-8"\n\n${msg.bodyHTML}\n\n`
			);
		}

		if (msg.body || msg.bodyHTML) {
			await writeStreamChunk(writeStream, `--${ALT_BOUNDARY}--\n`);
		}

		if (msg.hasAttachments) {
			for (let i = 0; i < msg.numberOfAttachments; i++) {
				const attachment = msg.getAttachment(i);
				const attachmentStream = attachment.fileInputStream;
				if (!attachmentStream) {
					continue;
				}

				await writeStreamChunk(
					writeStream,
					`\n--${BOUNDARY}\nContent-Type: ${attachment.mimeTag}; name="${attachment.longFilename}"\nContent-Disposition: attachment; filename="${attachment.longFilename}"\nContent-Transfer-Encoding: base64\n\n`
				);
				await streamPstAttachmentAsBase64(attachment, writeStream);
				await writeStreamChunk(writeStream, '\n');
			}

			await writeStreamChunk(writeStream, `\n--${BOUNDARY}--`);
		}

		writeStream.end();
		await finished(writeStream);
		return { tempFilePath, buffer: Buffer.alloc(0) };
	} catch (error) {
		writeStream.destroy();
		throw error;
	}
}
/**
 * Full EML including attachment payloads for preserve-original (GoBD) mode.
 */
export function buildFullEml(msg: PSTMessage): Buffer {
	const parts: Buffer[] = [];
	const headerBlock = buildHeaderBlock(msg);

	if (msg.hasAttachments) {
		parts.push(
			Buffer.from(
				`${headerBlock}Content-Type: multipart/mixed; boundary="${BOUNDARY}"\n\n--${BOUNDARY}\nContent-Type: multipart/alternative; boundary="${ALT_BOUNDARY}"\n\n`,
				'utf-8'
			)
		);
	} else {
		parts.push(
			Buffer.from(
				`${headerBlock}Content-Type: multipart/alternative; boundary="${ALT_BOUNDARY}"\n\n`,
				'utf-8'
			)
		);
	}

	if (msg.body) {
		parts.push(
			Buffer.from(
				`--${ALT_BOUNDARY}\nContent-Type: text/plain; charset="utf-8"\n\n${msg.body}\n\n`,
				'utf-8'
			)
		);
	}

	if (msg.bodyHTML) {
		parts.push(
			Buffer.from(
				`--${ALT_BOUNDARY}\nContent-Type: text/html; charset="utf-8"\n\n${msg.bodyHTML}\n\n`,
				'utf-8'
			)
		);
	}

	if (msg.body || msg.bodyHTML) {
		parts.push(Buffer.from(`--${ALT_BOUNDARY}--\n`, 'utf-8'));
	}

	if (msg.hasAttachments) {
		for (let i = 0; i < msg.numberOfAttachments; i++) {
			const attachment = msg.getAttachment(i);
			const attachmentStream = attachment.fileInputStream;
			if (!attachmentStream) {
				continue;
			}

			const attachmentBuffer = readPstAttachmentToBuffer(attachment);

			parts.push(
				Buffer.from(
					`\n--${BOUNDARY}\nContent-Type: ${attachment.mimeTag}; name="${attachment.longFilename}"\nContent-Disposition: attachment; filename="${attachment.longFilename}"\nContent-Transfer-Encoding: base64\n\n`,
					'utf-8'
				)
			);
			parts.push(Buffer.from(attachmentBuffer.toString('base64'), 'utf-8'));
			parts.push(Buffer.from('\n', 'utf-8'));
		}

		parts.push(Buffer.from(`\n--${BOUNDARY}--`, 'utf-8'));
	}

	return Buffer.concat(parts);
}

/** Extract PST attachments for separate storage (default ingestion mode). */
export async function extractPstAttachmentsAsync(
	msg: PSTMessage,
	preserveOriginalFile: boolean,
	streamAttachments: boolean
): Promise<
	{
		filename: string;
		contentType: string;
		size: number;
		content: Buffer;
		tempFilePath?: string;
		readContent?: () => NodeJS.ReadableStream;
	}[]
> {
	if (preserveOriginalFile || !msg.hasAttachments) {
		return [];
	}

	const attachments: {
		filename: string;
		contentType: string;
		size: number;
		content: Buffer;
		tempFilePath?: string;
		readContent?: () => NodeJS.ReadableStream;
	}[] = [];

	for (let i = 0; i < msg.numberOfAttachments; i++) {
		const attachment = msg.getAttachment(i);
		const attachmentStream = attachment.fileInputStream;
		if (!attachmentStream) {
			continue;
		}

		const meta = {
			filename: attachment.longFilename || attachment.filename || 'untitled',
			contentType: attachment.mimeTag || 'application/octet-stream',
		};

		if (streamAttachments) {
			attachments.push({
				...meta,
				size: attachment.filesize,
				content: Buffer.alloc(0),
				readContent: createPstAttachmentContentReader(attachment),
			});
		} else {
			const attachmentBuffer = readPstAttachmentToBuffer(attachment);
			attachments.push({
				...meta,
				size: attachment.filesize,
				content: attachmentBuffer,
			});
		}
	}

	return attachments;
}