/** Resume position for PST / EML zip / Mbox file imports. */
export interface FileImportCheckpoint {
	/** 0-based index of the last handled message (imported or dedup-skipped). */
	lastGlobalIndex: number;
	lastMessageId?: string;
	/** PST folder path or zip entry path when available. */
	lastPath?: string;
	/** Set when the file was fully processed. */
	complete?: boolean;
}

export type SyncState = {
	google?: {
		[userEmail: string]: {
			historyId: string;
		};
	};
	microsoft?: {
		[userEmail: string]: {
			deltaTokens: { [folderId: string]: string };
		};
	};
	imap?: {
		[mailboxPath: string]: {
			maxUid: number;
		};
	};
	/** Per-mailbox resume checkpoints for file-based imports. */
	fileImport?: {
		[userEmail: string]: FileImportCheckpoint;
	};
	lastSyncTimestamp?: string;
	statusMessage?: string;
};

/** How a resumed file import should behave after an error. */
export type ResumeImportMode = 'import' | 'dedup';

export interface ResumeImportDto {
	/**
	 * `import` — continue storing new messages from the last checkpoint (default).
	 * `dedup` — fast-forward through already-archived messages only (checkpoint + duplicate skip).
	 */
	mode?: ResumeImportMode;
}

export type IngestionProvider =
	| 'google_workspace'
	| 'microsoft_365'
	| 'generic_imap'
	| 'pst_import'
	| 'eml_import'
	| 'mbox_import'
	| 'smtp_journaling';

export type IngestionStatus =
	| 'active'
	| 'paused'
	| 'error'
	| 'pending_auth'
	| 'syncing'
	| 'importing'
	| 'auth_success'
	| 'imported'
	| 'partially_active'; // For sources with merged children where some are active and others are not

export interface BaseIngestionCredentials {
	type: IngestionProvider;
}

export interface GenericImapCredentials extends BaseIngestionCredentials {
	type: 'generic_imap';
	host: string;
	port: number;
	secure: boolean;
	allowInsecureCert: boolean;
	username: string;
	password?: string;
}

export interface GoogleWorkspaceCredentials extends BaseIngestionCredentials {
	type: 'google_workspace';
	/**
	 * The full JSON content of the Google Service Account key.
	 * This should be a stringified JSON object.
	 */
	serviceAccountKeyJson: string;
	/**
	 * The email of the super-admin user to impersonate for domain-wide operations.
	 */
	impersonatedAdminEmail: string;
}

export interface Microsoft365Credentials extends BaseIngestionCredentials {
	type: 'microsoft_365';
	clientId: string;
	clientSecret: string;
	tenantId: string;
}

export interface PSTImportCredentials extends BaseIngestionCredentials {
	type: 'pst_import';
	uploadedFileName?: string;
	uploadedFilePath?: string;
	localFilePath?: string;
}

export interface EMLImportCredentials extends BaseIngestionCredentials {
	type: 'eml_import';
	uploadedFileName?: string;
	uploadedFilePath?: string;
	localFilePath?: string;
}

export interface MboxImportCredentials extends BaseIngestionCredentials {
	type: 'mbox_import';
	uploadedFileName?: string;
	uploadedFilePath?: string;
	localFilePath?: string;
}

export interface SmtpJournalingCredentials extends BaseIngestionCredentials {
	type: 'smtp_journaling';
	/** The ID of the journaling_sources row that owns this ingestion source */
	journalingSourceId: string;
}

// Discriminated union for all possible credential types
export type IngestionCredentials =
	| GenericImapCredentials
	| GoogleWorkspaceCredentials
	| Microsoft365Credentials
	| PSTImportCredentials
	| EMLImportCredentials
	| MboxImportCredentials
	| SmtpJournalingCredentials;

export interface IngestionSource {
	id: string;
	name: string;
	provider: IngestionProvider;
	status: IngestionStatus;
	createdAt: Date;
	updatedAt: Date;
	credentials: IngestionCredentials;
	lastSyncStartedAt?: Date | null;
	lastSyncFinishedAt?: Date | null;
	lastSyncStatusMessage?: string | null;
	syncState?: SyncState | null;
	/** When true, the raw EML file is stored without any modification (no attachment
	 * stripping). Required for GoBD / SEC 17a-4 compliance. Defaults to false. */
	preserveOriginalFile: boolean;
	/** Stream file-import attachments to disk in fixed-size chunks (low RAM). Default true. */
	streamAttachmentsOnImport: boolean;
	/** The ID of the root ingestion source this child is merged into.
	 *  Null or undefined when this source is a standalone root. */
	mergedIntoId?: string | null;
}

/**
 * Represents an ingestion source with sensitive credential information removed.
 * This type is safe to use in client-side applications or API responses
 * where exposing credentials would be a security risk.
 */
export type SafeIngestionSource = Omit<IngestionSource, 'credentials'>;

export interface CreateIngestionSourceDto {
	name: string;
	provider: IngestionProvider;
	providerConfig: Record<string, any>;
	/** Store the unmodified raw EML for GoBD compliance. Defaults to false. */
	preserveOriginalFile?: boolean;
	/** Stream PST/file attachments to temp files during import. Defaults to true. */
	streamAttachmentsOnImport?: boolean;
	/** Merge this new source into an existing root source's group. */
	mergedIntoId?: string;
}

/** Server-side file import configuration exposed to the UI. */
export interface IImportSettings {
	localPathOnly: boolean;
	maxUploadMb: number;
	allowedRoots: string[];
	suggestedImportDir: string;
}

export interface IImportDirectoryEntry {
	name: string;
	path: string;
	isDirectory: boolean;
	sizeBytes?: number;
}

export interface IImportDirectoryListing {
	directory: string;
	allowedRoots: string[];
	entries: IImportDirectoryEntry[];
}

export interface UpdateIngestionSourceDto {
	name?: string;
	provider?: IngestionProvider;
	status?: IngestionStatus;
	providerConfig?: Record<string, any>;
	lastSyncStartedAt?: Date;
	lastSyncFinishedAt?: Date;
	lastSyncStatusMessage?: string;
	syncState?: SyncState;
	/** Set or clear the merge parent. Use null to unmerge. */
	mergedIntoId?: string | null;
	preserveOriginalFile?: boolean;
	streamAttachmentsOnImport?: boolean;
}

export interface IngestionQueueJobSummary {
	queue: 'ingestion' | 'indexing';
	id: string;
	name: string;
	state: string;
	failedReason?: string;
	stacktrace?: string[];
	timestamp?: number;
}

export interface IngestionDiagnostics {
	sourceId: string;
	status: IngestionStatus;
	provider: IngestionProvider;
	lastSyncStatusMessage?: string | null;
	lastSyncStartedAt?: string | null;
	lastSyncFinishedAt?: string | null;
	archivedEmailCount: number;
	indexedEmailCount: number;
	pendingIndexCount: number;
	activeSyncSession: {
		id: string;
		isInitialImport: boolean;
		totalMailboxes: number;
		completedMailboxes: number;
		failedMailboxes: number;
		errorMessages: string[];
		lastActivityAt: string;
	} | null;
	queue: {
		ingestionActive: number;
		ingestionWaiting: number;
		indexingActive: number;
		indexingWaiting: number;
		recentFailures: IngestionQueueJobSummary[];
	};
	progress: {
		phase: 'idle' | 'importing' | 'indexing' | 'complete' | 'error';
		mailboxPercent: number | null;
		indexingPercent: number | null;
		label: string;
		isIndeterminate: boolean;
	};
	/** Present when a file-based import can resume from a saved checkpoint. */
	resume?: {
		available: boolean;
		lastGlobalIndex: number | null;
		lastMessageId?: string | null;
		lastPath?: string | null;
	};
}

export interface IContinuousSyncJob {
	ingestionSourceId: string;
}

export interface IInitialImportJob {
	ingestionSourceId: string;
	resumeMode?: ResumeImportMode;
}

export interface IProcessMailboxJob {
	ingestionSourceId: string;
	userEmail: string;
	/** ID of the SyncSession tracking this sync cycle's progress */
	sessionId: string;
	/** When set on a resumed file import, controls import vs dedup-only fast-forward. */
	resumeMode?: ResumeImportMode;
	/** True when dispatched from the initial-import master job. */
	isInitialImport?: boolean;
}

export interface IPstProcessingJob {
	ingestionSourceId: string;
	filePath: string;
	originalFilename: string;
}

export type MailboxUser = {
	id: string;
	primaryEmail: string;
	displayName: string;
};

export type ProcessMailboxError = {
	error: boolean;
	message: string;
};
