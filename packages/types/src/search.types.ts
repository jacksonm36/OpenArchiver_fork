import type { EmailDocument } from './email.types';

export type MatchingStrategy = 'last' | 'all' | 'frequency';

/** Fields the main keyword query can be limited to (Thunderbird-style scope toggles). */
export type SearchFieldScope = 'from' | 'to' | 'cc' | 'bcc' | 'subject' | 'body' | 'attachments';

export interface SearchFilters {
	/** Partial or full sender address. */
	from?: string;
	/** Partial or full recipient address. */
	to?: string;
	cc?: string;
	bcc?: string;
	/** Words in the subject line. */
	subject?: string;
	/** Words in the message body. */
	body?: string;
	/** Inclusive start date (YYYY-MM-DD). */
	dateFrom?: string;
	/** Inclusive end date (YYYY-MM-DD). */
	dateTo?: string;
	/** Match emails that have any of these tags/labels. */
	tags?: string[];
	/** Only emails with attachments. */
	hasAttachments?: boolean;
	ingestionSourceId?: string;
	/** Limit which attributes the keyword query searches. Empty = all fields. */
	scopes?: SearchFieldScope[];
}

export interface SearchQuery {
	query: string;
	filters?: SearchFilters;
	page?: number;
	limit?: number;
	matchingStrategy?: MatchingStrategy;
}

export interface SearchHit extends EmailDocument {
	_matchesPosition?: {
		[key: string]: { start: number; length: number; indices?: number[] }[];
	};
	_formatted?: Partial<EmailDocument>;
}

export interface SearchResult {
	hits: SearchHit[];
	total: number;
	page: number;
	limit: number;
	totalPages: number;
	processingTimeMs: number;
}
