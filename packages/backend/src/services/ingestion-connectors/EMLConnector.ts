import type {

	EMLImportCredentials,

	EmailObject,

	EmailAddress,

	SyncState,

	MailboxUser,

} from '@open-archiver/types';

import type { IEmailConnector, ConnectorOptions } from '../EmailProviderFactory';

import { simpleParser, ParsedMail, Attachment, AddressObject } from 'mailparser';

import { logger } from '../../config/logger';

import { getThreadId } from './helpers/utils';

import { writeEmailToTempFile } from './helpers/tempFile';

import { StorageService } from '../StorageService';

import { Readable } from 'stream';

import { createHash } from 'crypto';

import { join, dirname } from 'path';

import { createReadStream, promises as fs, createWriteStream } from 'fs';

import { tmpdir } from 'os';

import { pipeline } from 'stream/promises';

import * as yauzl from 'yauzl';

import type { FileImportProgressContext } from '../../helpers/fileImportProgress';

import { FileImportIndexTracker } from '../../helpers/fileImportProgress';

import { extractMessageIdFromEmlBytes } from '../../helpers/emlHeaderScan';

import { discardTempEml, streamEmlToTemp } from '../../helpers/streamEmlToTemp';



const streamToBuffer = (stream: Readable): Promise<Buffer> => {

	return new Promise((resolve, reject) => {

		const chunks: Buffer[] = [];

		stream.on('data', (chunk) => chunks.push(chunk));

		stream.on('error', reject);

		stream.on('end', () => resolve(Buffer.concat(chunks)));

	});

};



export class EMLConnector implements IEmailConnector {

	private storage: StorageService;

	private options: ConnectorOptions;

	private importCompleted = false;



	constructor(

		private credentials: EMLImportCredentials,

		options?: ConnectorOptions

	) {

		this.options = options ?? { preserveOriginalFile: false, streamAttachmentsOnImport: true };

		this.storage = new StorageService();

	}



	private getFilePath(): string {

		return this.credentials.localFilePath || this.credentials.uploadedFilePath || '';

	}



	private getDisplayName(): string {

		if (this.credentials.uploadedFileName) {

			return this.credentials.uploadedFileName;

		}

		if (this.credentials.localFilePath) {

			const parts = this.credentials.localFilePath.split('/');

			return parts[parts.length - 1].replace('.zip', '');

		}

		return `eml-import-${new Date().getTime()}`;

	}



	private async getFileStream(): Promise<NodeJS.ReadableStream> {

		if (this.credentials.localFilePath) {

			return createReadStream(this.credentials.localFilePath);

		}

		return this.storage.getStream(this.getFilePath());

	}



	public async testConnection(): Promise<boolean> {

		try {

			const filePath = this.getFilePath();

			if (!filePath) {

				throw Error('EML Zip file path not provided.');

			}

			if (!filePath.includes('.zip')) {

				throw Error('Provided file is not in the ZIP format.');

			}



			let fileExist = false;

			if (this.credentials.localFilePath) {

				try {

					await fs.access(this.credentials.localFilePath);

					fileExist = true;

				} catch {

					fileExist = false;

				}

			} else {

				fileExist = await this.storage.exists(filePath);

			}



			if (!fileExist) {

				if (this.credentials.localFilePath) {

					throw Error(

						`EML Zip file not found at path: ${this.credentials.localFilePath}`

					);

				} else {

					throw Error(

						'Uploaded EML Zip file not found. The upload may not have finished yet, or it failed.'

					);

				}

			}



			return true;

		} catch (error) {

			logger.error(

				{ error, credentials: this.credentials },

				'EML Zip file validation failed.'

			);

			throw error;

		}

	}



	public async *listAllUsers(): AsyncGenerator<MailboxUser> {

		const displayName = this.getDisplayName();

		logger.info(`Found potential mailbox: ${displayName}`);

		const constructedPrimaryEmail = `${displayName.replace(/ /g, '.').toLowerCase()}@eml.local`;

		yield {

			id: constructedPrimaryEmail,

			primaryEmail: constructedPrimaryEmail,

			displayName: displayName,

		};

	}



	public async *fetchEmails(

		userEmail: string,

		_syncState?: SyncState | null,

		checkDuplicate?: (messageId: string) => Promise<boolean>,

		fileImportProgress?: FileImportProgressContext

	): AsyncGenerator<EmailObject | null> {

		const indexTracker = new FileImportIndexTracker(

			fileImportProgress?.resumeAfterIndex ?? -1

		);



		let zipFilePath: string;

		let tempDir: string | null = null;

		let shouldCleanupZip = false;



		try {

			if (this.credentials.localFilePath) {

				zipFilePath = this.credentials.localFilePath;

			} else {

				tempDir = await fs.mkdtemp(join(tmpdir(), 'eml-import-'));

				zipFilePath = join(tempDir, 'eml.zip');

				shouldCleanupZip = true;

				const fileStream = await this.getFileStream();

				await pipeline(fileStream as Readable, createWriteStream(zipFilePath));

			}



			yield* this.processZipEntries(

				zipFilePath,

				checkDuplicate,

				fileImportProgress,

				indexTracker

			);

			this.importCompleted = true;

		} catch (error) {

			logger.error({ error }, 'Failed to fetch email.');

			throw error;

		} finally {

			if (tempDir) {

				await fs.rm(tempDir, { recursive: true, force: true });

			}

			if (

				this.importCompleted &&

				this.credentials.uploadedFilePath &&

				!this.credentials.localFilePath &&

				shouldCleanupZip

			) {

				try {

					await this.storage.delete(this.credentials.uploadedFilePath);

				} catch (error) {

					logger.error(

						{ error, file: this.credentials.uploadedFilePath },

						'Failed to delete EML file after processing.'

					);

				}

			}

		}

	}



	private async *processZipEntries(

		zipFilePath: string,

		checkDuplicate?: (messageId: string) => Promise<boolean>,

		fileImportProgress?: FileImportProgressContext,

		indexTracker?: FileImportIndexTracker

	): AsyncGenerator<EmailObject | null> {

		const zipfile = await new Promise<yauzl.ZipFile>((resolve, reject) => {

			yauzl.open(zipFilePath, { lazyEntries: true, decodeStrings: false }, (err, zipfile) => {

				if (err || !zipfile) return reject(err);

				resolve(zipfile);

			});

		});



		const entryIterator = this.zipEntryGenerator(zipfile);



		for await (const { entry, openReadStream } of entryIterator) {

			if (fileImportProgress?.stopSignal?.stopped) {

				break;

			}

			const fileName = entry.fileName.toString();

			if (fileName.startsWith('__MACOSX/') || /\/$/.test(fileName)) {

				continue;

			}



			if (fileName.endsWith('.eml')) {

				if (indexTracker?.shouldSkip()) {

					continue;

				}



				const globalIndex = indexTracker?.currentIndex() ?? 0;



				try {

					const readStream = await openReadStream();

					const relativePath = dirname(fileName) === '.' ? '' : dirname(fileName);

					const streamed = await streamEmlToTemp(readStream, 'eml-zip');

					let messageId = streamed.messageId;



					if (!messageId) {

						const emlBuffer = await fs.readFile(streamed.tempFilePath);

						messageId = extractMessageIdFromEmlBytes(emlBuffer);

					}



					if (messageId && checkDuplicate && (await checkDuplicate(messageId))) {

						await discardTempEml(streamed.tempFilePath);

						await fileImportProgress?.onMessageHandled({

							lastGlobalIndex: globalIndex,

							lastMessageId: messageId,

							lastPath: fileName,

						});

						continue;

					}



					if (fileImportProgress?.dedupOnly) {

						await discardTempEml(streamed.tempFilePath);

						if (fileImportProgress.stopSignal) {

							fileImportProgress.stopSignal.stopped = true;

						}

						return;

					}



					const emailObject = await this.parseMessageFromTemp(

						streamed.tempFilePath,

						relativePath

					);



					yield { ...emailObject, fileImportIndex: globalIndex };

				} catch (error) {

					logger.error(

						{ error, file: fileName },

						'Failed to process a single EML file from zip. Skipping.'

					);

				}

			}

		}

	}



	private async parseMessageFromTemp(tempFilePath: string, path: string): Promise<EmailObject> {

		const emlBuffer = await fs.readFile(tempFilePath);

		return this.parseMessage(emlBuffer, path, tempFilePath);

	}



	private async *zipEntryGenerator(

		zipfile: yauzl.ZipFile

	): AsyncGenerator<{ entry: yauzl.Entry; openReadStream: () => Promise<Readable> }> {

		let resolveNext: ((value: any) => void) | null = null;

		let rejectNext: ((reason?: any) => void) | null = null;

		let finished = false;

		const queue: yauzl.Entry[] = [];



		zipfile.readEntry();



		zipfile.on('entry', (entry) => {

			if (resolveNext) {

				const resolve = resolveNext;

				resolveNext = null;

				rejectNext = null;

				resolve(entry);

			} else {

				queue.push(entry);

			}

		});



		zipfile.on('end', () => {

			finished = true;

			if (resolveNext) {

				const resolve = resolveNext;

				resolveNext = null;

				rejectNext = null;

				resolve(null);

			}

		});



		zipfile.on('error', (err) => {

			finished = true;

			if (rejectNext) {

				const reject = rejectNext;

				resolveNext = null;

				rejectNext = null;

				reject(err);

			}

		});



		while (!finished || queue.length > 0) {

			if (queue.length > 0) {

				const entry = queue.shift()!;

				yield {

					entry,

					openReadStream: () =>

						new Promise<Readable>((resolve, reject) => {

							zipfile.openReadStream(entry, (err, stream) => {

								if (err || !stream) return reject(err);

								resolve(stream);

							});

						}),

				};

				zipfile.readEntry();

			} else {

				const entry = await new Promise<yauzl.Entry | null>((resolve, reject) => {

					resolveNext = resolve;

					rejectNext = reject;

				});

				if (entry) {

					yield {

						entry,

						openReadStream: () =>

							new Promise<Readable>((resolve, reject) => {

								zipfile.openReadStream(entry, (err, stream) => {

									if (err || !stream) return reject(err);

									resolve(stream);

								});

							}),

					};

					zipfile.readEntry();

				} else {

					break;

				}

			}

		}

	}



	private async parseMessage(

		input: Buffer | Readable,

		path: string,

		existingTempFilePath?: string

	): Promise<EmailObject> {

		let emlBuffer: Buffer;

		if (Buffer.isBuffer(input)) {

			emlBuffer = input;

		} else {

			emlBuffer = await streamToBuffer(input);

		}



		const tempFilePath = existingTempFilePath ?? (await writeEmailToTempFile(emlBuffer));

		const parsedEmail: ParsedMail = await simpleParser(emlBuffer);



		const attachments = parsedEmail.attachments.map((attachment: Attachment) => ({

			filename: attachment.filename || 'untitled',

			contentType: attachment.contentType,

			size: attachment.size,

			content: this.options.preserveOriginalFile

				? Buffer.alloc(0)

				: (attachment.content as Buffer),

		}));



		const mapAddresses = (

			addresses: AddressObject | AddressObject[] | undefined

		): EmailAddress[] => {

			if (!addresses) return [];

			const addressArray = Array.isArray(addresses) ? addresses : [addresses];

			return addressArray.flatMap((a) =>

				a.value.map((v) => ({

					name: v.name,

					address: v.address?.replaceAll(`'`, '') || '',

				}))

			);

		};



		const threadId = getThreadId(parsedEmail.headers);

		let messageId = parsedEmail.messageId;



		if (!messageId) {

			messageId = `generated-${createHash('sha256').update(emlBuffer).digest('hex')}`;

		}



		const from = mapAddresses(parsedEmail.from);

		if (from.length === 0) {

			from.push({ name: 'No Sender', address: 'No Sender' });

		}



		return {

			id: messageId,

			threadId: threadId,

			from,

			to: mapAddresses(parsedEmail.to),

			cc: mapAddresses(parsedEmail.cc),

			bcc: mapAddresses(parsedEmail.bcc),

			subject: parsedEmail.subject || '',

			body: parsedEmail.text || '',

			html: parsedEmail.html || '',

			headers: parsedEmail.headers,

			attachments,

			receivedAt: parsedEmail.date || new Date(),

			tempFilePath,

			path,

		};

	}



	public getUpdatedSyncState(_userEmail?: string): SyncState {

		return {};

	}

}


