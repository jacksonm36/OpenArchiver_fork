import { readdir, stat } from 'fs/promises';
import path from 'path';
import type {
	IImportDirectoryEntry,
	IImportDirectoryListing,
	IImportSettings,
	IngestionProvider,
} from '@open-archiver/types';
import { fileImportConfig } from '../config/fileImport';
import {
	assertAllowedLocalImportPath,
	getAllowedImportRoots,
	getBrowsableImportRoots,
} from '../helpers/localImportPath';

const IMPORT_EXTENSIONS: Record<IngestionProvider, string[]> = {
	pst_import: ['.pst'],
	eml_import: ['.zip'],
	mbox_import: ['.mbox'],
	generic_imap: [],
	google_workspace: [],
	microsoft_365: [],
};

function extensionMatches(filename: string, extensions: string[]): boolean {
	const lower = filename.toLowerCase();
	return extensions.some((ext) => lower.endsWith(ext));
}

export class LocalImportService {
	public getSettings(): IImportSettings {
		const allowedRoots = getBrowsableImportRoots();

		return {
			localPathOnly: fileImportConfig.localPathOnly,
			maxUploadMb: fileImportConfig.maxUploadMb,
			allowedRoots,
			suggestedImportDir: allowedRoots[0],
		};
	}

	public async listDirectory(
		provider: IngestionProvider,
		requestedDir?: string
	): Promise<IImportDirectoryListing> {
		const allowedRoots = getBrowsableImportRoots();
		if (allowedRoots.length === 0) {
			throw new Error('No import directories configured');
		}

		const targetDir = requestedDir?.trim()
			? await assertAllowedLocalImportPath(requestedDir.trim())
			: allowedRoots[0];

		const extensions = IMPORT_EXTENSIONS[provider] ?? [];
		const entries: IImportDirectoryEntry[] = [];

		let dirEntries;
		try {
			dirEntries = await readdir(targetDir, { withFileTypes: true });
		} catch (error) {
			throw new Error(
				`Cannot read directory: ${error instanceof Error ? error.message : 'unknown error'}`
			);
		}

		for (const entry of dirEntries) {
			if (entry.name.startsWith('.')) {
				continue;
			}

			const fullPath = path.join(targetDir, entry.name);

			if (entry.isDirectory()) {
				entries.push({
					name: entry.name,
					path: fullPath,
					isDirectory: true,
				});
				continue;
			}

			if (!entry.isFile()) {
				continue;
			}

			if (extensions.length > 0 && !extensionMatches(entry.name, extensions)) {
				continue;
			}

			const fileStat = await stat(fullPath);
			entries.push({
				name: entry.name,
				path: fullPath,
				isDirectory: false,
				sizeBytes: fileStat.size,
			});
		}

		entries.sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) {
				return a.isDirectory ? -1 : 1;
			}
			return a.name.localeCompare(b.name);
		});

		return {
			directory: targetDir,
			allowedRoots,
			entries,
		};
	}
}
