import type { PSTAttachment } from 'pst-extractor';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { unlink } from 'fs/promises';
import { finished } from 'stream/promises';
import { Readable } from 'stream';

/** Block size recommended by pst-extractor / java-libpst. */
export const PST_ATTACHMENT_READ_CHUNK = 8176;

async function* readPstAttachmentChunks(
	attachment: PSTAttachment
): AsyncGenerator<Buffer> {
	const attachmentStream = attachment.fileInputStream;
	if (!attachmentStream) {
		return;
	}

	const readBuffer = Buffer.alloc(PST_ATTACHMENT_READ_CHUNK);
	let bytesRead: number;
	do {
		bytesRead = attachmentStream.read(readBuffer);
		if (bytesRead > 0) {
			yield readBuffer.subarray(0, bytesRead);
		}
	} while (bytesRead === PST_ATTACHMENT_READ_CHUNK);
}

/** One-shot reader — must not be called twice (PST streams are single-use). */
export function createPstAttachmentContentReader(
	attachment: PSTAttachment
): () => Readable {
	return () => Readable.from(readPstAttachmentChunks(attachment)) as Readable;
}

export function readPstAttachmentToBuffer(attachment: PSTAttachment): Buffer {
	const attachmentStream = attachment.fileInputStream;
	if (!attachmentStream) {
		return Buffer.alloc(0);
	}

	const attachmentBuffer = Buffer.alloc(attachment.filesize);
	attachmentStream.readCompletely(attachmentBuffer);
	return attachmentBuffer;
}

/**
 * Streams a PST attachment to a temp file (legacy / fallback path).
 */
export async function streamPstAttachmentToTemp(attachment: PSTAttachment): Promise<{
	tempFilePath: string;
	size: number;
}> {
	const tempFilePath = join(tmpdir(), `oa-attach-${randomUUID()}.bin`);
	const writeStream = createWriteStream(tempFilePath);
	const readBuffer = Buffer.alloc(PST_ATTACHMENT_READ_CHUNK);
	let totalBytes = 0;
	let bytesRead: number;

	const attachmentStream = attachment.fileInputStream;
	if (!attachmentStream) {
		throw new Error('PST attachment has no readable stream');
	}

	try {
		do {
			bytesRead = attachmentStream.read(readBuffer);
			if (bytesRead > 0) {
				const canContinue = writeStream.write(readBuffer.subarray(0, bytesRead));
				totalBytes += bytesRead;
				if (!canContinue) {
					await new Promise<void>((resolve, reject) => {
						writeStream.once('drain', resolve);
						writeStream.once('error', reject);
					});
				}
			}
		} while (bytesRead === PST_ATTACHMENT_READ_CHUNK);

		writeStream.end();
		await finished(writeStream);
	} catch (error) {
		writeStream.destroy();
		await unlink(tempFilePath).catch(() => undefined);
		throw error;
	}

	return { tempFilePath, size: totalBytes || attachment.filesize };
}
