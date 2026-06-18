import type { FileImportCheckpoint, SyncState } from '@open-archiver/types';

export interface FileImportProgressContext {
	resumeAfterIndex: number;
	/** When true, only advance through already-archived messages (duplicate skip). */
	dedupOnly?: boolean;
	/** Set by connectors when dedup-only scan reaches the first unimported message. */
	stopSignal?: { stopped: boolean };
	onMessageHandled: (checkpoint: FileImportCheckpoint) => Promise<void>;
}

export function getFileImportCheckpoint(
	syncState: SyncState | null | undefined,
	userEmail: string
): FileImportCheckpoint | undefined {
	return syncState?.fileImport?.[userEmail];
}

export function createFileImportProgressContext(
	syncState: SyncState | null | undefined,
	userEmail: string,
	onCheckpoint: (checkpoint: FileImportCheckpoint) => Promise<void>,
	options?: { dedupOnly?: boolean }
): FileImportProgressContext {
	const existing = getFileImportCheckpoint(syncState, userEmail);
	return {
		resumeAfterIndex: existing?.complete ? Number.MAX_SAFE_INTEGER : (existing?.lastGlobalIndex ?? -1),
		dedupOnly: options?.dedupOnly,
		stopSignal: options?.dedupOnly ? { stopped: false } : undefined,
		onMessageHandled: onCheckpoint,
	};
}

/**
 * Tracks monotonic message index across a file import and supports fast resume.
 */
export class FileImportIndexTracker {
	private nextIndex = 0;

	constructor(private readonly resumeAfterIndex: number) {}

	/** Returns true when this message should be skipped (already handled). */
	shouldSkip(): boolean {
		const index = this.nextIndex;
		this.nextIndex += 1;
		return index <= this.resumeAfterIndex;
	}

	currentIndex(): number {
		return Math.max(0, this.nextIndex - 1);
	}
}
