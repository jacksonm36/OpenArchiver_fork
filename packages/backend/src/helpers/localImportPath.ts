import { realpath } from 'fs/promises';
import path from 'path';
import type { IngestionCredentials, IngestionProvider } from '@open-archiver/types';
import { storage } from '../config/storage';
import { fileImportConfig } from '../config/fileImport';

const FILE_BASED_PROVIDERS = new Set<IngestionProvider>([
	'pst_import',
	'eml_import',
	'mbox_import',
]);

function uniqueResolvedPaths(roots: string[]): string[] {
	return [...new Set(roots.map((root) => path.resolve(root)))];
}

function configuredImportRoots(): string[] {
	const roots: string[] = [];

	if (process.env.OA_DATA?.trim()) {
		roots.push(process.env.OA_DATA.trim());
	}
	if (process.env.IMPORT_ALLOWED_PATHS?.trim()) {
		roots.push(
			...process.env.IMPORT_ALLOWED_PATHS.split(',')
				.map((entry) => entry.trim())
				.filter(Boolean)
		);
	}

	return uniqueResolvedPaths(roots);
}

function defaultImportsDirectory(): string {
	const storageRoot = process.env.STORAGE_LOCAL_ROOT_PATH?.trim() || '/opt/openarchiver-data';
	return path.join(path.resolve(storageRoot), 'imports');
}

/**
 * Directories exposed in the server file browser UI.
 * Never includes the full storage root unless explicitly listed in IMPORT_ALLOWED_PATHS.
 */
export function getBrowsableImportRoots(): string[] {
	const configured = configuredImportRoots();
	if (configured.length > 0) {
		return configured;
	}
	return [defaultImportsDirectory()];
}

/**
 * Directories from which local PST/EML/Mbox files may be read.
 * Includes configured roots plus the dedicated imports folder under storage.
 */
export function getAllowedImportRoots(): string[] {
	const roots = [...configuredImportRoots(), defaultImportsDirectory()];
	return uniqueResolvedPaths(roots);
}

async function isPathUnderRoot(candidate: string, root: string): Promise<boolean> {
	const resolvedCandidate = path.resolve(candidate);
	const resolvedRoot = path.resolve(root);

	if (resolvedCandidate.includes('\0') || resolvedRoot.includes('\0')) {
		return false;
	}

	try {
		const [realCandidate, realRoot] = await Promise.all([
			realpath(resolvedCandidate),
			realpath(resolvedRoot),
		]);
		return (
			realCandidate === realRoot || realCandidate.startsWith(`${realRoot}${path.sep}`)
		);
	} catch {
		return (
			resolvedCandidate === resolvedRoot ||
			resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
		);
	}
}

/**
 * Ensures a server-local import path is under an allowed import directory.
 */
export async function assertAllowedLocalImportPath(filePath: string): Promise<string> {
	if (filePath.includes('\0')) {
		throw new Error('Invalid local file path');
	}

	const resolved = path.resolve(filePath);
	const allowedRoots = getAllowedImportRoots();

	for (const root of allowedRoots) {
		if (await isPathUnderRoot(resolved, root)) {
			return resolved;
		}
	}

	throw new Error(
		'Local file path is outside allowed import directories. Set OA_DATA or IMPORT_ALLOWED_PATHS.'
	);
}

/**
 * Ensures an uploaded file path points only to the temporary upload area in storage.
 */
export function assertAllowedUploadedFilePath(uploadedFilePath: string): void {
	const normalized = path.posix.normalize(uploadedFilePath.replace(/\\/g, '/'));
	const prefix = `${storage.openArchiverFolderName}/tmp/`;

	if (
		!normalized.startsWith(prefix) ||
		normalized.includes('..') ||
		normalized.includes('\0')
	) {
		throw new Error('Invalid uploaded file path');
	}
}

export async function validateFileImportCredentials(
	provider: IngestionProvider,
	credentials: IngestionCredentials
): Promise<void> {
	if (!FILE_BASED_PROVIDERS.has(provider)) {
		return;
	}

	const fileCredentials = credentials as {
		localFilePath?: string;
		uploadedFilePath?: string;
	};

	if (fileCredentials.localFilePath?.trim()) {
		await assertAllowedLocalImportPath(fileCredentials.localFilePath.trim());
	}

	if (fileCredentials.uploadedFilePath?.trim()) {
		if (fileImportConfig.localPathOnly) {
			throw new Error(
				'Browser uploads are disabled. Place files on the server and use Local Path instead.'
			);
		}
		assertAllowedUploadedFilePath(fileCredentials.uploadedFilePath.trim());
	}
}
