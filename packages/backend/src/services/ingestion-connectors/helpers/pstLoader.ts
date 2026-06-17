import { tmpdir } from 'os';
import { join } from 'path';
import { createWriteStream, promises as fs } from 'fs';
import { PSTFile } from 'pst-extractor';
import type { StorageService } from '../../StorageService';
import { assertAllowedLocalImportPath, assertAllowedUploadedFilePath } from '../../../helpers/localImportPath';

export interface PstSession {
	pstFile: PSTFile;
	cleanup: () => Promise<void>;
}

export interface OpenPstFileOptions {
	localFilePath?: string;
	uploadedFilePath?: string;
	storage: StorageService;
}

/**
 * Opens a PST for reading. Local files are opened in place; uploaded files are
 * copied once to the OS temp directory (pst-extractor requires random access).
 */
export async function openPstFile(options: OpenPstFileOptions): Promise<PstSession> {
	const { localFilePath, uploadedFilePath, storage } = options;

	if (localFilePath) {
		const safePath = await assertAllowedLocalImportPath(localFilePath);
		await fs.access(safePath);
		const pstFile = new PSTFile(safePath);
		return {
			pstFile,
			cleanup: async () => {
				pstFile.close();
			},
		};
	}

	if (!uploadedFilePath) {
		throw new Error('PST file path not provided.');
	}

	assertAllowedUploadedFilePath(uploadedFilePath);
	const tempDir = await fs.mkdtemp(join(tmpdir(), 'oa-pst-'));
	const tempFilePath = join(tempDir, 'archive.pst');
	const fileStream = await storage.getStream(uploadedFilePath);

	await new Promise<void>((resolve, reject) => {
		const dest = createWriteStream(tempFilePath);
		fileStream.pipe(dest);
		dest.on('finish', resolve);
		dest.on('error', reject);
	});

	const pstFile = new PSTFile(tempFilePath);
	return {
		pstFile,
		cleanup: async () => {
			pstFile.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		},
	};
}
