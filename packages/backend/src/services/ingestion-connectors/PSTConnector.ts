import type {
	PSTImportCredentials,
	EmailObject,
	EmailAddress,
	SyncState,
	MailboxUser,
} from '@open-archiver/types';
import type { IEmailConnector, ConnectorOptions } from '../EmailProviderFactory';
import { PSTFolder, PSTMessage } from 'pst-extractor';
import { logger } from '../../config/logger';
import { writeEmailToTempFile } from './helpers/tempFile';
import { StorageService } from '../StorageService';
import { openPstFile } from './helpers/pstLoader';
import {
	buildBodyOnlyEml,
	buildFullEml,
	buildPstHeadersMap,
	extractPstAttachments,
	getPstMessageId,
	getPstThreadId,
	parseDisplayAddressList,
} from './helpers/pstEmlBuilder';
import { basename } from 'path';
import { access } from 'fs/promises';

const DELETED_FOLDERS = new Set([
	'deleted items',
	'trash',
	'elementos eliminados',
	'papelera',
	'éléments supprimés',
	'corbeille',
	'gelöschte elemente',
	'papierkorb',
	'posta eliminata',
	'cestino',
	'itens excluídos',
	'lixo',
	'verwijderde items',
	'prullenbak',
	'удаленные',
	'корзина',
	'usunięte elementy',
	'kosz',
	'削除済みアイテム',
	'odstraněná pošta',
	'koš',
	'kustutatud kirjad',
	'prügikast',
	'borttagna objekt',
	'skräp',
	'slettet post',
	'papirkurv',
	'slettede elementer',
	'poistetut',
	'roskakori',
]);

const JUNK_FOLDERS = new Set([
	'junk email',
	'spam',
	'correo no deseado',
	'courrier indésirable',
	'junk-e-mail',
	'posta indesiderata',
	'lixo eletrônico',
	'ongewenste e-mail',
	'нежелательная почта',
	'спам',
	'wiadomości-śmieci',
	'迷惑メール',
	'スパム',
	'nevyžádaná pošta',
	'rämpspost',
	'skräppost',
	'uønsket post',
	'søppelpost',
	'roskaposti',
]);

export class PSTConnector implements IEmailConnector {
	private storage: StorageService;
	private options: ConnectorOptions;

	constructor(
		private credentials: PSTImportCredentials,
		options?: ConnectorOptions
	) {
		this.options = options ?? { preserveOriginalFile: false };
		this.storage = new StorageService();
	}

	private getFilePath(): string {
		return this.credentials.localFilePath || this.credentials.uploadedFilePath || '';
	}

	private getDisplayName(): string {
		if (this.credentials.uploadedFileName) {
			return this.credentials.uploadedFileName.replace(/\.pst$/i, '');
		}
		if (this.credentials.localFilePath) {
			return basename(this.credentials.localFilePath).replace(/\.pst$/i, '');
		}
		return `pst-import-${Date.now()}`;
	}

	public async testConnection(): Promise<boolean> {
		try {
			const filePath = this.getFilePath();
			if (!filePath) {
				throw Error('PST file path not provided.');
			}
			if (!filePath.toLowerCase().includes('.pst')) {
				throw Error('Provided file is not in the PST format.');
			}

			let fileExist = false;
			if (this.credentials.localFilePath) {
				try {
					await access(this.credentials.localFilePath);
					fileExist = true;
				} catch {
					fileExist = false;
				}
			} else {
				fileExist = await this.storage.exists(filePath);
			}

			if (!fileExist) {
				if (this.credentials.localFilePath) {
					throw Error(`PST file not found at path: ${this.credentials.localFilePath}`);
				}
				throw Error(
					'Uploaded PST file not found. The upload may not have finished yet, or it failed.'
				);
			}
			return true;
		} catch (error) {
			logger.error({ error, credentials: this.credentials }, 'PST file validation failed.');
			throw error;
		}
	}

	/**
	 * Lists mailboxes without opening the PST — the file is only loaded once during fetchEmails.
	 */
	public async *listAllUsers(): AsyncGenerator<MailboxUser> {
		const displayName = this.getDisplayName();
		logger.info(`Found potential mailbox: ${displayName}`);
		const constructedPrimaryEmail = `${displayName.replace(/ /g, '.').toLowerCase()}@pst.local`;
		yield {
			id: constructedPrimaryEmail,
			primaryEmail: constructedPrimaryEmail,
			displayName,
		};
	}

	public async *fetchEmails(
		userEmail: string,
		_syncState?: SyncState | null,
		checkDuplicate?: (messageId: string) => Promise<boolean>
	): AsyncGenerator<EmailObject | null> {
		const session = await openPstFile({
			localFilePath: this.credentials.localFilePath,
			uploadedFilePath: this.credentials.uploadedFilePath,
			storage: this.storage,
		});

		try {
			const root = session.pstFile.getRootFolder();
			yield* this.processFolder(root, '', userEmail, checkDuplicate);
		} catch (error) {
			logger.error({ error }, 'Failed to fetch emails from PST file.');
			throw error;
		} finally {
			await session.cleanup();
			if (this.credentials.uploadedFilePath && !this.credentials.localFilePath) {
				try {
					await this.storage.delete(this.credentials.uploadedFilePath);
				} catch (error) {
					logger.error(
						{ error, file: this.credentials.uploadedFilePath },
						'Failed to delete PST file after processing.'
					);
				}
			}
		}
	}

	private async *processFolder(
		folder: PSTFolder,
		currentPath: string,
		userEmail: string,
		checkDuplicate?: (messageId: string) => Promise<boolean>
	): AsyncGenerator<EmailObject | null> {
		const folderName = folder.displayName.toLowerCase();
		if (DELETED_FOLDERS.has(folderName) || JUNK_FOLDERS.has(folderName)) {
			logger.info(`Skipping folder: ${folder.displayName}`);
			return;
		}

		const newPath = currentPath ? `${currentPath}/${folder.displayName}` : folder.displayName;

		if (folder.contentCount > 0) {
			let email: PSTMessage | null = folder.getNextChild();
			while (email != null) {
				if (checkDuplicate && email.internetMessageId) {
					const messageId = email.internetMessageId.startsWith('<')
						? email.internetMessageId
						: `<${email.internetMessageId}>`;
					if (await checkDuplicate(messageId)) {
						try {
							email = folder.getNextChild();
						} catch {
							email = null;
						}
						continue;
					}
				}

				yield await this.parseMessage(email, newPath, userEmail);
				try {
					email = folder.getNextChild();
				} catch (error) {
					logger.warn(
						{ folder: folder.displayName, error },
						"Folder doesn't have child or failed to read next child."
					);
					email = null;
				}
			}
		}

		if (folder.hasSubfolders) {
			for (const subFolder of folder.getSubFolders()) {
				yield* this.processFolder(subFolder, newPath, userEmail, checkDuplicate);
			}
		}
	}

	private async parseMessage(
		msg: PSTMessage,
		path: string,
		userEmail: string
	): Promise<EmailObject> {
		const preserveOriginal = this.options.preserveOriginalFile;
		const emlBuffer = preserveOriginal ? buildFullEml(msg) : buildBodyOnlyEml(msg);
		const tempFilePath = await writeEmailToTempFile(emlBuffer);

		const from: EmailAddress[] =
			msg.senderEmailAddress || msg.senderName
				? [
						{
							name: msg.senderName || '',
							address: (msg.senderEmailAddress || msg.senderName || 'No Sender').replaceAll(
								"'",
								''
							),
						},
					]
				: [{ name: 'No Sender', address: 'No Sender' }];

		const to = parseDisplayAddressList(msg.displayTo);
		const cc = parseDisplayAddressList(msg.displayCC);
		const bcc = parseDisplayAddressList(msg.displayBCC);
		const attachments = extractPstAttachments(msg, preserveOriginal);

		return {
			id: getPstMessageId(msg, emlBuffer),
			threadId: getPstThreadId(msg),
			from,
			to,
			cc,
			bcc,
			subject: msg.subject || '',
			body: msg.body || '',
			html: msg.bodyHTML || '',
			headers: buildPstHeadersMap(msg),
			attachments,
			receivedAt: msg.clientSubmitTime || msg.messageDeliveryTime || new Date(),
			tempFilePath,
			emlAttachmentsStripped: !preserveOriginal,
			path,
			userEmail,
		};
	}

	public getUpdatedSyncState(): SyncState {
		return {};
	}
}
