import type { EmailAddress } from '@open-archiver/types';
import type { PSTMessage } from 'pst-extractor';
import { createHash } from 'crypto';

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
		headers.set('in-reply-to', msg.inReplyToId);
	}
	if (msg.conversationId) {
		headers.set('conversation-id', msg.conversationId);
	}

	return headers;
}

export function getPstThreadId(msg: PSTMessage): string | undefined {
	if (msg.inReplyToId) {
		return msg.inReplyToId.trim();
	}
	if (msg.conversationId) {
		return msg.conversationId.trim();
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

			const attachmentBuffer = Buffer.alloc(attachment.filesize);
			attachmentStream.readCompletely(attachmentBuffer);

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

export function extractPstAttachments(
	msg: PSTMessage,
	preserveOriginalFile: boolean
): { filename: string; contentType: string; size: number; content: Buffer }[] {
	if (preserveOriginalFile || !msg.hasAttachments) {
		return [];
	}

	const attachments: { filename: string; contentType: string; size: number; content: Buffer }[] =
		[];

	for (let i = 0; i < msg.numberOfAttachments; i++) {
		const attachment = msg.getAttachment(i);
		const attachmentStream = attachment.fileInputStream;
		if (!attachmentStream) {
			continue;
		}

		const attachmentBuffer = Buffer.alloc(attachment.filesize);
		attachmentStream.readCompletely(attachmentBuffer);

		attachments.push({
			filename: attachment.longFilename || attachment.filename || 'untitled',
			contentType: attachment.mimeTag || 'application/octet-stream',
			size: attachment.filesize,
			content: attachmentBuffer,
		});
	}

	return attachments;
}
