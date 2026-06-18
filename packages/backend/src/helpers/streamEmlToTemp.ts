import { createWriteStream, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { extractMessageIdFromEmlBytes } from './emlHeaderScan';

const HEADER_PEEK = 64 * 1024;

/**
 * Streams an EML entry to a temp file while peeking the Message-ID header.
 */
export async function streamEmlToTemp(
	readStream: Readable,
	prefix = 'eml-entry'
): Promise<{ tempFilePath: string; messageId: string | null; headerPeek: Buffer }> {
	const tempFilePath = join(
		tmpdir(),
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.eml`
	);

	const headerChunks: Buffer[] = [];
	let headerBytes = 0;

	const peekTransform = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			if (headerBytes < HEADER_PEEK) {
				const remaining = HEADER_PEEK - headerBytes;
				const slice = chunk.subarray(0, Math.min(chunk.length, remaining));
				headerChunks.push(slice);
				headerBytes += slice.length;
			}
			callback(null, chunk);
		},
	});

	await pipeline(readStream, peekTransform, createWriteStream(tempFilePath));

	const headerPeek = Buffer.concat(headerChunks);
	const messageId = extractMessageIdFromEmlBytes(headerPeek);

	return { tempFilePath, messageId, headerPeek };
}

export async function discardTempEml(tempFilePath: string): Promise<void> {
	try {
		await fs.unlink(tempFilePath);
	} catch {
		// Best-effort cleanup
	}
}
