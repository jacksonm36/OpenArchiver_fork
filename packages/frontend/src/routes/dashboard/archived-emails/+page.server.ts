import { api } from '$lib/server/api';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import type { ArchiveFolderNode, IngestionSource, PaginatedArchivedEmails } from '@open-archiver/types';

export const load: PageServerLoad = async (event) => {
	const { url } = event;
	const ingestionSourceId = url.searchParams.get('ingestionSourceId');
	const folderPath = url.searchParams.get('path');
	const page = url.searchParams.get('page') || '1';
	const limit = url.searchParams.get('limit') || '10';

	const sourcesResponse = await api('/ingestion-sources', event);
	const sourcesResponseText = await sourcesResponse.json();
	let ingestionSources: IngestionSource[] = sourcesResponseText;
	if (!sourcesResponse.ok) {
		if (sourcesResponse.status === 403) {
			ingestionSources = [];
		} else {
			return error(
				sourcesResponse.status,
				sourcesResponseText.message || 'Failed to load ingestion source.'
			);
		}
	}

	let archivedEmails: PaginatedArchivedEmails = {
		items: [],
		total: 0,
		page: 1,
		limit: 10,
	};
	let folderTree: ArchiveFolderNode[] = [];
	let allMailTotal = 0;

	// Use the provided ingestionSourceId, or default to the first one if it's not provided.
	const selectedIngestionSourceId = ingestionSourceId || ingestionSources[0]?.id;

	if (selectedIngestionSourceId) {
		const pathQuery = folderPath ? `&path=${encodeURIComponent(folderPath)}` : '';
		const emailsResponse = await api(
			`/archived-emails/ingestion-source/${selectedIngestionSourceId}?page=${page}&limit=${limit}${pathQuery}`,
			event
		);
		const responseText = await emailsResponse.json();
		if (!emailsResponse.ok) {
			return error(
				emailsResponse.status,
				responseText.message || 'Failed to load archived emails.'
			);
		}
		archivedEmails = responseText;

		const foldersResponse = await api(
			`/archived-emails/ingestion-source/${selectedIngestionSourceId}/folders`,
			event
		);
		const foldersText = await foldersResponse.json();
		if (foldersResponse.ok) {
			folderTree = foldersText;
		}

		if (folderPath) {
			const allResponse = await api(
				`/archived-emails/ingestion-source/${selectedIngestionSourceId}?page=1&limit=1`,
				event
			);
			const allText = await allResponse.json();
			if (allResponse.ok) {
				allMailTotal = allText.total;
			}
		} else {
			allMailTotal = archivedEmails.total;
		}
	}

	return {
		ingestionSources,
		archivedEmails,
		selectedIngestionSourceId,
		folderTree,
		selectedFolderPath: folderPath,
		allMailTotal,
	};
};
