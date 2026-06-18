import type { Response } from 'express';

export interface ExportProgress {
	total: number;
	exported: number;
	skipped: number;
	aborted: boolean;
}

export function createExportProgress(): ExportProgress {
	return { total: 0, exported: 0, skipped: 0, aborted: false };
}

export function attachExportAbort(req: { on(event: string, cb: () => void): void }, progress: ExportProgress): void {
	req.on('close', () => {
		progress.aborted = true;
	});
}

export function setExportSummaryHeaders(res: Response, progress: ExportProgress): void {
	res.setHeader('X-Export-Total', String(progress.total));
	res.setHeader('X-Export-Exported', String(progress.exported));
	res.setHeader('X-Export-Skipped', String(progress.skipped));
	if (progress.aborted) {
		res.setHeader('X-Export-Aborted', 'true');
	}
}

/** Write with backpressure so large exports do not exhaust memory. */
export async function writeResponseChunk(res: Response, chunk: string | Buffer): Promise<boolean> {
	if (res.destroyed || res.writableEnded) {
		return false;
	}

	const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
	if (res.write(buffer)) {
		return true;
	}

	await new Promise<void>((resolve, reject) => {
		const onDrain = () => {
			cleanup();
			resolve();
		};
		const onError = (err: Error) => {
			cleanup();
			reject(err);
		};
		const onClose = () => {
			cleanup();
			resolve();
		};
		const cleanup = () => {
			res.off('drain', onDrain);
			res.off('error', onError);
			res.off('close', onClose);
		};
		res.once('drain', onDrain);
		res.once('error', onError);
		res.once('close', onClose);
	});

	return !res.destroyed && !res.writableEnded;
}

const usedZipNames = new Map<string, Set<string>>();

export function uniqueZipEntryName(exportKey: string, baseName: string): string {
	let used = usedZipNames.get(exportKey);
	if (!used) {
		used = new Set<string>();
		usedZipNames.set(exportKey, used);
	}

	let candidate = baseName.replace(/\\/g, '/');
	if (!used.has(candidate)) {
		used.add(candidate);
		return candidate;
	}

	const dot = candidate.lastIndexOf('.');
	const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
	const ext = dot > 0 ? candidate.slice(dot) : '';
	let counter = 2;
	while (used.has(`${stem}-${counter}${ext}`)) {
		counter += 1;
	}
	candidate = `${stem}-${counter}${ext}`;
	used.add(candidate);
	return candidate;
}

export function clearZipEntryNames(exportKey: string): void {
	usedZipNames.delete(exportKey);
}
