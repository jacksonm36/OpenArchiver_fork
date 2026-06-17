import type { SearchFieldScope, SearchFilters } from '@open-archiver/types';

const FIELD_ATTR_MAP: Record<string, string> = {
	from: 'from',
	to: 'to',
	cc: 'cc',
	bcc: 'bcc',
	subject: 'subject',
	body: 'body',
};

const SCOPE_ATTR_MAP: Record<SearchFieldScope, string[]> = {
	from: ['from'],
	to: ['to'],
	cc: ['cc'],
	bcc: ['bcc'],
	subject: ['subject'],
	body: ['body'],
	attachments: ['attachments.filename', 'attachments.content'],
};

export function escapeMeiliString(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function dateToTimestampStart(isoDate: string): number {
	return new Date(`${isoDate}T00:00:00`).getTime();
}

function dateToTimestampEnd(isoDate: string): number {
	return new Date(`${isoDate}T23:59:59.999`).getTime();
}

export function expandScopes(scopes: SearchFieldScope[]): string[] {
	return scopes.flatMap((scope) => SCOPE_ATTR_MAP[scope] ?? []);
}

/** Keys used for full-text search, not Meilisearch structural filters. */
const TEXT_FILTER_KEYS = new Set(['from', 'to', 'cc', 'bcc', 'subject', 'body', 'scopes']);

export function hasStructuralFilters(filters?: SearchFilters): boolean {
	if (!filters) return false;
	return Boolean(
		filters.dateFrom ||
			filters.dateTo ||
			(filters.tags && filters.tags.length > 0) ||
			filters.hasAttachments ||
			filters.ingestionSourceId
	);
}

export function buildSearchText(
	keywords: string,
	filters?: SearchFilters
): { query: string; fieldAttributes: string[] } {
	const terms: string[] = [];
	const fieldAttributes: string[] = [];

	if (keywords.trim()) {
		terms.push(keywords.trim());
	}

	if (filters) {
		for (const [key, attr] of Object.entries(FIELD_ATTR_MAP)) {
			const value = filters[key as keyof SearchFilters];
			if (typeof value === 'string' && value.trim()) {
				terms.push(value.trim());
				fieldAttributes.push(attr);
			}
		}
	}

	return { query: terms.join(' '), fieldAttributes };
}

export function resolveAttributesToSearchOn(
	filters: SearchFilters | undefined,
	fieldAttributes: string[],
	hasKeywords: boolean
): string[] | undefined {
	if (filters?.scopes?.length) {
		return expandScopes(filters.scopes);
	}

	if (fieldAttributes.length > 0 && !hasKeywords) {
		return [...new Set(fieldAttributes)];
	}

	return undefined;
}

export function buildMeiliFilterParts(
	filters: SearchFilters,
	ingestionGroupResolver?: (sourceId: string) => Promise<string[]>
): Promise<string[]> {
	return buildMeiliFilterPartsAsync(filters, ingestionGroupResolver);
}

async function buildMeiliFilterPartsAsync(
	filters: SearchFilters,
	ingestionGroupResolver?: (sourceId: string) => Promise<string[]>
): Promise<string[]> {
	const filterParts: string[] = [];

	for (const [key, value] of Object.entries(filters)) {
		if (TEXT_FILTER_KEYS.has(key)) continue;

		if (key === 'dateFrom' && typeof value === 'string') {
			filterParts.push(`timestamp >= ${dateToTimestampStart(value)}`);
		} else if (key === 'dateTo' && typeof value === 'string') {
			filterParts.push(`timestamp <= ${dateToTimestampEnd(value)}`);
		} else if (key === 'tags' && Array.isArray(value) && value.length > 0) {
			const tagList = value.map((tag) => `'${escapeMeiliString(tag)}'`).join(', ');
			filterParts.push(`tags IN [${tagList}]`);
		} else if (key === 'hasAttachments' && value === true) {
			filterParts.push('hasAttachments = true');
		} else if (key === 'ingestionSourceId' && typeof value === 'string' && ingestionGroupResolver) {
			const groupIds = await ingestionGroupResolver(value);
			if (groupIds.length === 1) {
				filterParts.push(`ingestionSourceId = '${escapeMeiliString(groupIds[0])}'`);
			} else {
				const inList = groupIds.map((id) => `'${escapeMeiliString(id)}'`).join(', ');
				filterParts.push(`ingestionSourceId IN [${inList}]`);
			}
		}
	}

	return filterParts;
}
