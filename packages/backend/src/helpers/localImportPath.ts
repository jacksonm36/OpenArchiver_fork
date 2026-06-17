import { realpath } from 'fs/promises';
import path from 'path';
import type { IngestionCredentials, IngestionProvider } from '@open-archiver/types';
import { storage } from '../config/storage';

const FILE_BASED_PROVIDERS = new Set<IngestionProvider>([
	'pst_import',
	'eml_import',
	'mbox_import',
]);

function getAllowedImportRoots(): string[] {
	const roots: string[] = [];

	if (process.env.OA_DATA?.trim()) {
		roots.push(process.env.OA_DATA.trim());
	}
	if (process.env.STORAGE_LOCAL_ROOT_PATH?.trim()) {
		roots.push(process.env.STORAGE_LOCAL_ROOT_PATH.trim());
	}
	if (process.env.IMPORT_ALLOWED_PATHS?.trim()) {
		roots.push(
			...process.env.IMPORT_ALLOWED_PATHS.split(',')
				.map((entry) => entry.trim())
				.filter(Boolean)
		);
	}

	if (roots.length === 0) {
		roots.push('/opt/openarchiver-data');
	}

	return [...new Set(roots.map((root) => path.resolve(root)))];
}

async function isPathUnderRoot(candidate: string, root: string): Promise<boolean> {
	const resolvedCandidate = path.resolve(candidate);
	const resolvedRoot = path.resolve(root);

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
 * Ensures a server-local import path is under OA_DATA, storage root, or IMPORT_ALLOWED_PATHS.
 */
export async function assertAllowedLocalImportPath(filePath: string): Promise<string> {
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
		assertAllowedUploadedFilePath(fileCredentials.uploadedFilePath.trim());
	}
}
