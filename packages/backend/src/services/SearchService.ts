import { Index, MeiliSearch, SearchParams } from 'meilisearch';
import { config } from '../config';
import type {
	SearchQuery,
	SearchResult,
	EmailDocument,
	TopSender,
} from '@open-archiver/types';
import { FilterBuilder } from './FilterBuilder';
import { AuditService } from './AuditService';
import { IngestionService } from './IngestionService';
import {
	buildMeiliFilterParts,
	buildSearchText,
	hasStructuralFilters,
	resolveAttributesToSearchOn,
} from '../helpers/searchFilterBuilder';

export class SearchService {
	private client: MeiliSearch;
	private auditService: AuditService;

	constructor() {
		this.client = new MeiliSearch({
			host: config.search.host,
			apiKey: config.search.apiKey,
		});
		this.auditService = new AuditService();
	}

	public async getIndex<T extends Record<string, any>>(name: string): Promise<Index<T>> {
		return this.client.index<T>(name);
	}

	public async addDocuments<T extends Record<string, any>>(
		indexName: string,
		documents: T[],
		primaryKey?: string
	) {
		const index = await this.getIndex<T>(indexName);
		if (primaryKey) {
			index.update({ primaryKey });
		}
		return index.addDocuments(documents);
	}

	public async search<T extends Record<string, any>>(
		indexName: string,
		query: string,
		options?: any
	) {
		const index = await this.getIndex<T>(indexName);
		return index.search(query, options);
	}

	public async deleteDocuments(indexName: string, ids: string[]) {
		const index = await this.getIndex(indexName);
		return index.deleteDocuments(ids);
	}

	public async deleteDocumentsByFilter(indexName: string, filter: string | string[]) {
		const index = await this.getIndex(indexName);
		return index.deleteDocuments({ filter });
	}

	public async searchEmails(
		dto: SearchQuery,
		userId: string,
		actorIp: string
	): Promise<SearchResult> {
		const { query: keywords = '', filters, page = 1, limit = 10, matchingStrategy = 'last' } = dto;
		const index = await this.getIndex<EmailDocument>('emails');

		const { query, fieldAttributes } = buildSearchText(keywords, filters);
		const hasKeywords = Boolean(keywords.trim());

		if (!query && !hasStructuralFilters(filters)) {
			throw new Error('Search requires keywords or at least one filter');
		}

		const effectiveStrategy =
			query.split(/\s+/).filter(Boolean).length > 1 ? 'all' : matchingStrategy;

		const searchParams: SearchParams = {
			limit,
			offset: (page - 1) * limit,
			attributesToHighlight: ['*'],
			showMatchesPosition: true,
			sort: ['timestamp:desc'],
			matchingStrategy: effectiveStrategy,
		};

		const attributesToSearchOn = resolveAttributesToSearchOn(
			filters,
			fieldAttributes,
			hasKeywords
		);
		if (attributesToSearchOn?.length) {
			searchParams.attributesToSearchOn = attributesToSearchOn;
		}

		if (filters) {
			const filterParts = await buildMeiliFilterParts(filters, (sourceId) =>
				IngestionService.findGroupSourceIds(sourceId)
			);
			if (filterParts.length > 0) {
				searchParams.filter = filterParts.join(' AND ');
			}
		}

		const { searchFilter } = await FilterBuilder.create(userId, 'archive', 'read');
		if (searchFilter) {
			if (searchParams.filter) {
				searchParams.filter = `${searchParams.filter} AND ${searchFilter}`;
			} else {
				searchParams.filter = searchFilter;
			}
		}

		const searchResults = await index.search(query, searchParams);

		await this.auditService.createAuditLog({
			actorIdentifier: userId,
			actionType: 'SEARCH',
			targetType: 'ArchivedEmail',
			targetId: '',
			actorIp,
			details: {
				query: keywords,
				filters,
				page,
				limit,
				matchingStrategy: effectiveStrategy,
			},
		});

		return {
			hits: searchResults.hits,
			total: searchResults.estimatedTotalHits ?? searchResults.hits.length,
			page,
			limit,
			totalPages: Math.ceil(
				(searchResults.estimatedTotalHits ?? searchResults.hits.length) / limit
			),
			processingTimeMs: searchResults.processingTimeMs,
		};
	}

	public async getAvailableTags(userId: string): Promise<string[]> {
		const index = await this.getIndex<EmailDocument>('emails');
		const { searchFilter } = await FilterBuilder.create(userId, 'archive', 'read');

		const searchResults = await index.search('', {
			facets: ['tags'],
			limit: 0,
			filter: searchFilter || undefined,
		});

		const distribution = searchResults.facetDistribution?.tags;
		if (!distribution) return [];

		return Object.keys(distribution).sort((a, b) => a.localeCompare(b));
	}

	public async getTopSenders(limit = 10): Promise<TopSender[]> {
		const index = await this.getIndex<EmailDocument>('emails');
		const searchResults = await index.search('', {
			facets: ['from'],
			limit: 0,
		});

		if (!searchResults.facetDistribution?.from) {
			return [];
		}

		const sortedSenders = Object.entries(searchResults.facetDistribution.from)
			.sort(([, countA], [, countB]) => countB - countA)
			.slice(0, limit)
			.map(([sender, count]) => ({ sender, count }));

		return sortedSenders;
	}

	public async configureEmailIndex() {
		const index = await this.getIndex('emails');
		await index.updateSettings({
			searchableAttributes: [
				'subject',
				'body',
				'from',
				'to',
				'cc',
				'bcc',
				'tags',
				'attachments.filename',
				'attachments.content',
				'userEmail',
			],
			filterableAttributes: [
				'from',
				'to',
				'cc',
				'bcc',
				'timestamp',
				'tags',
				'hasAttachments',
				'ingestionSourceId',
				'userEmail',
			],
			sortableAttributes: ['timestamp'],
		});
	}
}
