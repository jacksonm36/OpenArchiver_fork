import type { SearchFieldScope, SearchFilters } from '@open-archiver/types';

export interface SearchFormState {
	keywords: string;
	filters: SearchFilters;
	matchingStrategy: 'last' | 'all' | 'frequency';
	page: number;
}

export const DEFAULT_SEARCH_STATE: SearchFormState = {
	keywords: '',
	filters: {},
	matchingStrategy: 'last',
	page: 1,
};

export function parseSearchParams(url: URL): SearchFormState {
	const keywords = url.searchParams.get('keywords') || '';
	const matchingStrategy =
		(url.searchParams.get('matchingStrategy') as SearchFormState['matchingStrategy']) || 'last';
	const page = parseInt(url.searchParams.get('page') || '1', 10);

	const filters: SearchFilters = {};
	const stringFields = ['from', 'to', 'cc', 'bcc', 'subject', 'body', 'dateFrom', 'dateTo'] as const;
	for (const field of stringFields) {
		const value = url.searchParams.get(field);
		if (value?.trim()) {
			filters[field] = value.trim();
		}
	}

	const tags = url.searchParams.get('tags');
	if (tags?.trim()) {
		filters.tags = tags
			.split(',')
			.map((tag) => tag.trim())
			.filter(Boolean);
	}

	if (url.searchParams.get('hasAttachments') === 'true') {
		filters.hasAttachments = true;
	}

	const scopes = url.searchParams.get('scopes');
	if (scopes?.trim()) {
		filters.scopes = scopes
			.split(',')
			.map((scope) => scope.trim())
			.filter(Boolean) as SearchFieldScope[];
	}

	return { keywords, filters, matchingStrategy, page };
}

export function buildSearchQueryString(state: SearchFormState): string {
	const params = new URLSearchParams();

	if (state.keywords.trim()) {
		params.set('keywords', state.keywords.trim());
	}

	const { filters } = state;
	const stringFields = ['from', 'to', 'cc', 'bcc', 'subject', 'body', 'dateFrom', 'dateTo'] as const;
	for (const field of stringFields) {
		const value = filters[field];
		if (value?.trim()) {
			params.set(field, value.trim());
		}
	}

	if (filters.tags?.length) {
		params.set('tags', filters.tags.join(','));
	}

	if (filters.hasAttachments) {
		params.set('hasAttachments', 'true');
	}

	if (filters.scopes?.length) {
		params.set('scopes', filters.scopes.join(','));
	}

	if (state.matchingStrategy !== 'last') {
		params.set('matchingStrategy', state.matchingStrategy);
	}

	if (state.page > 1) {
		params.set('page', String(state.page));
	}

	return params.toString();
}

export function hasActiveSearch(state: SearchFormState): boolean {
	if (state.keywords.trim()) return true;
	const { filters } = state;
	return Boolean(
		filters.from ||
			filters.to ||
			filters.cc ||
			filters.bcc ||
			filters.subject ||
			filters.body ||
			filters.dateFrom ||
			filters.dateTo ||
			filters.tags?.length ||
			filters.hasAttachments
	);
}
