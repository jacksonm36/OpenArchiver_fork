import { IStorageProvider, StorageConfig } from '@open-archiver/types';
import { LocalFileSystemProvider } from './storage/LocalFileSystemProvider';
import { S3StorageProvider } from './storage/S3StorageProvider';
import { config } from '../config/index';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { streamToBuffer } from '../helpers/streamToBuffer';
import { Readable, Transform, PassThrough } from 'stream';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createHashingPassThrough } from '../helpers/hashStream';
import {
	compressStorageBuffer,
	createCompressTransform,
	createGzipMarkerTransform,
	createOptionalGunzipTransform,
	decompressStorageBuffer,
	shouldCompressStorage,
	StorageDecodeError,
} from '../helpers/storageCompression';

/**
 *  A unique identifier for Open Archiver encrypted files. This value SHOULD NOT BE ALTERED in future development to ensure compatibility.
 */
const ENCRYPTION_PREFIX = Buffer.from('oa_enc_idf_v1::');

export class StorageService implements IStorageProvider {
	private provider: IStorageProvider;
	private encryptionKey: Buffer | null = null;
	private readonly compress: boolean;
	private readonly algorithm = 'aes-256-cbc';

	constructor(storageConfig: StorageConfig = config.storage) {
		if (storageConfig.encryptionKey) {
			this.encryptionKey = Buffer.from(storageConfig.encryptionKey, 'hex');
		}
		this.compress = storageConfig.compress ?? true;

		switch (storageConfig.type) {
			case 'local':
				this.provider = new LocalFileSystemProvider(storageConfig);
				break;
			case 's3':
				this.provider = new S3StorageProvider(storageConfig);
				break;
			default:
				throw new Error('Invalid storage provider type');
		}
	}

	private prepareBufferForStorage(plaintext: Buffer): Buffer {
		let payload = plaintext;
		if (shouldCompressStorage(this.compress, plaintext.length)) {
			payload = compressStorageBuffer(plaintext);
		}
		if (!this.encryptionKey) {
			return payload;
		}
		const iv = randomBytes(16);
		const cipher = createCipheriv(this.algorithm, this.encryptionKey, iv);
		const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
		return Buffer.concat([ENCRYPTION_PREFIX, iv, encrypted]);
	}

	private decodeStoredBuffer(stored: Buffer): Buffer {
		let payload = stored;
		if (this.encryptionKey) {
			const prefix = payload.subarray(0, ENCRYPTION_PREFIX.length);
			if (prefix.equals(ENCRYPTION_PREFIX)) {
				const iv = payload.subarray(
					ENCRYPTION_PREFIX.length,
					ENCRYPTION_PREFIX.length + 16
				);
				const encrypted = payload.subarray(ENCRYPTION_PREFIX.length + 16);
				try {
					const decipher = createDecipheriv(this.algorithm, this.encryptionKey, iv);
					payload = Buffer.concat([decipher.update(encrypted), decipher.final()]);
				} catch (error) {
					throw new StorageDecodeError(
						'Failed to decrypt archived file (corrupt ciphertext or wrong key)',
						{ cause: error }
					);
				}
			}
		}
		return decompressStorageBuffer(payload);
	}

	private createEncryptTransform(): Transform {
		const iv = randomBytes(16);
		const cipher = createCipheriv(this.algorithm, this.encryptionKey!, iv);
		const prefix = Buffer.concat([ENCRYPTION_PREFIX, iv]);
		let prefixWritten = false;

		return new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				try {
					if (!prefixWritten) {
						prefixWritten = true;
						const encrypted = cipher.update(chunk);
						callback(
							null,
							encrypted.length
								? Buffer.concat([prefix, encrypted])
								: prefix
						);
						return;
					}
					callback(null, cipher.update(chunk));
				} catch (error) {
					callback(error as Error);
				}
			},
			flush(callback) {
				try {
					const final = cipher.final();
					callback(null, final.length ? final : undefined);
				} catch (error) {
					callback(error as Error);
				}
			},
		});
	}

	private async pipeToStorage(
		storagePath: string,
		source: NodeJS.ReadableStream,
		plaintextSizeHint?: number
	): Promise<void> {
		const output = new PassThrough();
		const upload = this.provider.put(storagePath, output);

		const useCompress =
			this.compress &&
			(plaintextSizeHint === undefined ||
				shouldCompressStorage(this.compress, plaintextSizeHint));

		if (!this.encryptionKey) {
			if (useCompress) {
				await pipeline(
					source,
					createCompressTransform(),
					createGzipMarkerTransform(),
					output
				);
			} else {
				await pipeline(source, output);
			}
			await upload;
			return;
		}

		const encryptTransform = this.createEncryptTransform();
		if (useCompress) {
			await pipeline(
				source,
				createCompressTransform(),
				createGzipMarkerTransform(),
				encryptTransform,
				output
			);
		} else {
			await pipeline(source, encryptTransform, output);
		}
		await upload;
	}

	async put(path: string, content: Buffer | NodeJS.ReadableStream): Promise<void> {
		if (content instanceof Buffer) {
			return this.provider.put(path, this.prepareBufferForStorage(content));
		}
		await this.pipeToStorage(path, content as NodeJS.ReadableStream);
	}

	/** Store a readable stream and return its SHA-256 + size in a single pass (no temp file). */
	async putFromStreamWithHash(
		storagePath: string,
		source: NodeJS.ReadableStream
	): Promise<{ hash: string; size: number }> {
		const { stream: hasher, digest } = createHashingPassThrough();
		const output = new PassThrough();
		const upload = this.provider.put(storagePath, output);

		const useCompress = this.compress;

		if (!this.encryptionKey) {
			if (useCompress) {
				await pipeline(
					source,
					hasher,
					createCompressTransform(),
					createGzipMarkerTransform(),
					output
				);
			} else {
				await pipeline(source, hasher, output);
			}
			await upload;
			return digest();
		}

		const encryptTransform = this.createEncryptTransform();
		if (useCompress) {
			await pipeline(
				source,
				hasher,
				createCompressTransform(),
				createGzipMarkerTransform(),
				encryptTransform,
				output
			);
		} else {
			await pipeline(source, hasher, encryptTransform, output);
		}
		await upload;
		return digest();
	}

	async putFromFileWithHash(
		storagePath: string,
		localFilePath: string
	): Promise<{ hash: string; size: number }> {
		return this.putFromStreamWithHash(storagePath, createReadStream(localFilePath));
	}

	async putFromFile(storagePath: string, localFilePath: string): Promise<void> {
		await this.putFromFileWithHash(storagePath, localFilePath);
	}

	async readPlaintext(path: string): Promise<Buffer> {
		const stream = await this.provider.get(path);
		const stored = await streamToBuffer(stream);
		return this.decodeStoredBuffer(stored);
	}

	async get(path: string): Promise<NodeJS.ReadableStream> {
		return Readable.from(await this.readPlaintext(path));
	}

	public async getStream(path: string): Promise<NodeJS.ReadableStream> {
		const stream = await this.provider.get(path);

		if (!this.encryptionKey) {
			return stream.pipe(createOptionalGunzipTransform());
		}

		const prefixAndIvBuffer = await new Promise<Buffer>((resolve, reject) => {
			const chunks: Buffer[] = [];
			let totalLength = 0;
			const targetLength = ENCRYPTION_PREFIX.length + 16;

			const onData = (chunk: Buffer) => {
				chunks.push(chunk);
				totalLength += chunk.length;
				if (totalLength >= targetLength) {
					stream.removeListener('data', onData);
					resolve(Buffer.concat(chunks));
				}
			};

			stream.on('data', onData);
			stream.on('error', reject);
			stream.on('end', () => {
				if (totalLength < targetLength) {
					resolve(Buffer.concat(chunks));
				}
			});
		});

		const prefix = prefixAndIvBuffer.subarray(0, ENCRYPTION_PREFIX.length);
		if (!prefix.equals(ENCRYPTION_PREFIX)) {
			const combinedStream = new Readable({ read() {} });
			combinedStream.push(prefixAndIvBuffer);
			stream.on('data', (chunk) => combinedStream.push(chunk));
			stream.on('end', () => combinedStream.push(null));
			stream.on('error', (err) => combinedStream.emit('error', err));
			return combinedStream.pipe(createOptionalGunzipTransform());
		}

		try {
			const iv = prefixAndIvBuffer.subarray(
				ENCRYPTION_PREFIX.length,
				ENCRYPTION_PREFIX.length + 16
			);
			const decipher = createDecipheriv(this.algorithm, this.encryptionKey, iv);
			const remainingBuffer = prefixAndIvBuffer.subarray(ENCRYPTION_PREFIX.length + 16);
			if (remainingBuffer.length > 0) {
				decipher.write(remainingBuffer);
			}
			stream.pipe(decipher);
			return decipher.pipe(createOptionalGunzipTransform());
		} catch (error) {
			if (error instanceof StorageDecodeError) {
				throw error;
			}
			throw new Error('Failed to decrypt file. It may be corrupted or the key is incorrect.');
		}
	}

	delete(path: string): Promise<void> {
		return this.provider.delete(path);
	}

	exists(path: string): Promise<boolean> {
		return this.provider.exists(path);
	}
}
