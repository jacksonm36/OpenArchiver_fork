import { createHash } from 'crypto';
import { Transform, type Readable } from 'stream';
import { pipeline } from 'stream/promises';

/** Transform stream that computes SHA-256 and byte count while passing data through. */
export function createHashingPassThrough(): {
	stream: Transform;
	digest: () => { hash: string; size: number };
} {
	const hash = createHash('sha256');
	let size = 0;
	const stream = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			hash.update(chunk);
			size += chunk.length;
			callback(null, chunk);
		},
	});
	return {
		stream,
		digest: () => ({ hash: hash.digest('hex'), size }),
	};
}

/** Pipe source through hasher only (discards output). */
export async function hashReadableStream(source: Readable): Promise<{ hash: string; size: number }> {
	const { stream: hasher, digest } = createHashingPassThrough();
	await pipeline(source, hasher);
	return digest();
}
