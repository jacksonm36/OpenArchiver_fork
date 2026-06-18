import { Request, Response } from 'express';
import { StorageService } from '../../services/StorageService';
import * as path from 'path';
import { storage as storageConfig } from '../../config/storage';
import { assertAllowedStorageObjectPath } from '../../helpers/localImportPath';

export class StorageController {
	constructor(private storageService: StorageService) {}

	public downloadFile = async (req: Request, res: Response): Promise<void> => {
		const unsafePath = req.query.path as string;

		if (!unsafePath) {
			res.status(400).send(req.t('storage.filePathRequired'));
			return;
		}

		let safePath: string;
		try {
			assertAllowedStorageObjectPath(unsafePath);
			safePath = path.posix.normalize(unsafePath.replace(/\\/g, '/'));
		} catch {
			res.status(400).send(req.t('storage.invalidFilePath'));
			return;
		}

		// Resolve under the configured storage root (prefix-safe, not startsWith-only).
		const basePath = path.resolve(
			storageConfig.type === 'local' ? storageConfig.rootPath : '/'
		);
		const resolvedPath = path.resolve(basePath, safePath.split('/').join(path.sep));
		const relativePath = path.relative(basePath, resolvedPath);

		if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
			res.status(400).send(req.t('storage.invalidFilePath'));
			return;
		}

		const storageKey = relativePath.split(path.sep).join('/');

		try {
			const fileExists = await this.storageService.exists(storageKey);
			if (!fileExists) {
				res.status(404).send(req.t('storage.fileNotFound'));
				return;
			}

			const fileStream = await this.storageService.get(storageKey);
			const fileName = path.basename(storageKey);
			const asciiName = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
			res.setHeader(
				'Content-Disposition',
				`attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
			);
			fileStream.pipe(res);
		} catch (error) {
			console.error('Error downloading file:', error);
			res.status(500).send(req.t('storage.downloadError'));
		}
	};
}
