import { gzipSync, gunzipSync, createGzip, createGunzip } from 'zlib';
import { Transform } from 'stream';

/** Identifies gzip-compressed payloads written by Open Archiver (in addition to gzip magic bytes). */
export const STORAGE_GZIP_PREFIX = Buffer.from('oa_gz_v1::');

/** Skip gzip for tiny blobs where the header overhead exceeds savings. */
export const STORAGE_COMPRESS_MIN_BYTES = 512;

export class StorageDecodeError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'StorageDecodeError';
	}
}

export function isGzipBuffer(buffer: Buffer): boolean {
	return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

export function hasStorageGzipMarker(buffer: Buffer): boolean {
	return (
		buffer.length >= STORAGE_GZIP_PREFIX.length &&
		buffer.subarray(0, STORAGE_GZIP_PREFIX.length).equals(STORAGE_GZIP_PREFIX)
	);
}

export function stripStorageGzipMarker(buffer: Buffer): Buffer {
	if (hasStorageGzipMarker(buffer)) {
		return buffer.subarray(STORAGE_GZIP_PREFIX.length);
	}
	return buffer;
}

export function shouldCompressStorage(enabled: boolean, plaintextSize: number): boolean {
	return enabled && plaintextSize >= STORAGE_COMPRESS_MIN_BYTES;
}

/** Wrap gzip bytes with an explicit marker for reliable detection after decryption. */
export function wrapCompressedPayload(gzipBytes: Buffer): Buffer {
	return Buffer.concat([STORAGE_GZIP_PREFIX, gzipBytes]);
}

export function compressStorageBuffer(plaintext: Buffer): Buffer {
	return wrapCompressedPayload(gzipSync(plaintext));
}

export function isCompressedStoragePayload(payload: Buffer): boolean {
	return hasStorageGzipMarker(payload) || isGzipBuffer(payload);
}

export function decompressStorageBuffer(data: Buffer): Buffer {
	if (!isCompressedStoragePayload(data)) {
		return data;
	}

	const gzipPayload = stripStorageGzipMarker(data);
	try {
		return gunzipSync(gzipPayload);
	} catch (error) {
		throw new StorageDecodeError('Failed to decompress archived file (corrupt gzip payload)', {
			cause: error,
		});
	}
}

export function createCompressTransform(): Transform {
	return createGzip({ level: 6 });
}

/**
 * Transform that writes the gzip marker before compressed bytes.
 * Must be placed after createGzip in the pipeline.
 */
export function createGzipMarkerTransform(): Transform {
	let markerWritten = false;
	return new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			try {
				if (!markerWritten) {
					markerWritten = true;
					callback(null, Buffer.concat([STORAGE_GZIP_PREFIX, chunk]));
					return;
				}
				callback(null, chunk);
			} catch (error) {
				callback(error as Error);
			}
		},
	});
}

/**
 * Gunzip when input carries our marker or gzip magic; otherwise pass through.
 * Safe for legacy uncompressed files.
 */
export function createOptionalGunzipTransform(): Transform {
	let gunzip: ReturnType<typeof createGunzip> | null = null;
	let passthrough = false;
	let pending: Buffer = Buffer.alloc(0);
	let streamEnded = false;

	const flushGunzip = (callback: (error?: Error | null) => void) => {
		if (!gunzip) {
			callback();
			return;
		}
		gunzip.once('end', () => callback());
		gunzip.once('error', (err) => callback(err));
		gunzip.end();
	};

	const startGunzip = function (
		this: Transform,
		chunk: Buffer,
		callback: (error?: Error | null) => void,
	) {
		const gzipPayload = stripStorageGzipMarker(chunk);
		gunzip = createGunzip();
		gunzip.on('data', (out: Buffer) => this.push(out));
		gunzip.on('error', (err) => this.destroy(err));
		gunzip.on('end', () => {
			if (!streamEnded) {
				streamEnded = true;
				this.push(null);
			}
		});
		gunzip.write(gzipPayload, callback);
	};

	return new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			try {
				if (passthrough) {
					callback(null, chunk);
					return;
				}

				if (!gunzip) {
					pending = Buffer.concat([pending, chunk]);
					if (
						!hasStorageGzipMarker(pending) &&
						!isGzipBuffer(pending) &&
						pending.length < STORAGE_GZIP_PREFIX.length + 2
					) {
						// Need more bytes to decide (marker or gzip magic).
						callback();
						return;
					}

					if (isCompressedStoragePayload(pending)) {
						const toProcess = pending;
						pending = Buffer.alloc(0);
						startGunzip.call(this, toProcess, callback);
						return;
					}

					passthrough = true;
					const toEmit = pending;
					pending = Buffer.alloc(0);
					callback(null, toEmit.length ? toEmit : undefined);
					return;
				}

				if (!gunzip.write(chunk)) {
					gunzip.once('drain', () => callback());
				} else {
					callback();
				}
			} catch (error) {
				callback(error as Error);
			}
		},
		flush(callback) {
			try {
				if (passthrough && pending.length > 0) {
					this.push(pending);
					pending = Buffer.alloc(0);
					callback();
					return;
				}

				if (!gunzip && pending.length > 0) {
					if (isCompressedStoragePayload(pending)) {
						startGunzip.call(this, pending, (err) => {
							if (err) {
								callback(err);
								return;
							}
							flushGunzip(callback);
						});
						pending = Buffer.alloc(0);
						return;
					}
					this.push(pending);
					pending = Buffer.alloc(0);
					callback();
					return;
				}

				flushGunzip(callback);
			} catch (error) {
				callback(error as Error);
			}
		},
	});
}
