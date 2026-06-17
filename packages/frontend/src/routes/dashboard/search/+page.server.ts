import type { PageServerLoad, RequestEvent } from './$types';
import { api } from '$lib/server/api';
import type { SearchResult } from '@open-archiver/types';
import {
	buildSearchQueryString,
	hasActiveSearch,
	parseSearchParams,
	type SearchFormState,
} from '$lib/searchParams';

async function performSearch(state: SearchFormState, event: RequestEvent) {
	if (!hasActiveSearch(state)) {
		return {
			searchResult: null,
			...state,
		};
	}

	try {
		const queryString = buildSearchQueryString({ ...state, page: state.page });
		const searchResponse = await api(`/search?${queryString}&limit=10`, event, { method: 'GET' });

		if (!searchResponse.ok) {
			const error = await searchResponse.json();
			return {
				searchResult: null,
				...state,
				error: error.message,
			};
		}

		const searchResult = (await searchResponse.json()) as SearchResult;
		return { searchResult, ...state };
	} catch (error) {
		return {
			searchResult: null,
			...state,
			error: error instanceof Error ? error.message : 'Unknown error',
		};
	}
}

export const load: PageServerLoad = async (event) => {
	const state = parseSearchParams(event.url);

	try {
		const tagsResponse = await api('/search/tags', event, { method: 'GET' });
		let availableTags: string[] = [];
		if (tagsResponse.ok) {
			const tagsBody = await tagsResponse.json();
			availableTags = tagsBody.tags ?? [];
		}

		if (!hasActiveSearch(state)) {
			return { ...state, searchResult: null, availableTags };
		}

		const result = await performSearch(state, event);
		return { ...result, availableTags: result.availableTags ?? availableTags };
	} catch (error) {
		return {
			...state,
			searchResult: null,
			availableTags: [],
			error: error instanceof Error ? error.message : 'Unknown error',
		};
	}
};
