import { Request, Response } from 'express';
import { SearchService } from '../../services/SearchService';
import type { MatchingStrategy, SearchFieldScope, SearchFilters } from '@open-archiver/types';
import { hasStructuralFilters } from '../../helpers/searchFilterBuilder';

function parseSearchFilters(query: Request['query']): SearchFilters {
	const filters: SearchFilters = {};

	const stringFields = ['from', 'to', 'cc', 'bcc', 'subject', 'body', 'dateFrom', 'dateTo', 'ingestionSourceId'] as const;
	for (const field of stringFields) {
		const value = query[field];
		if (typeof value === 'string' && value.trim()) {
			filters[field] = value.trim();
		}
	}

	if (typeof query.tags === 'string' && query.tags.trim()) {
		filters.tags = query.tags
			.split(',')
			.map((tag) => tag.trim())
			.filter(Boolean);
	}

	if (query.hasAttachments === 'true') {
		filters.hasAttachments = true;
	}

	if (typeof query.scopes === 'string' && query.scopes.trim()) {
		filters.scopes = query.scopes
			.split(',')
			.map((scope) => scope.trim())
			.filter(Boolean) as SearchFieldScope[];
	}

	return filters;
}

function hasTextFilters(filters: SearchFilters): boolean {
	return Boolean(
		filters.from ||
			filters.to ||
			filters.cc ||
			filters.bcc ||
			filters.subject ||
			filters.body
	);
}

export class SearchController {
	private searchService: SearchService;

	constructor() {
		this.searchService = new SearchService();
	}

	public search = async (req: Request, res: Response): Promise<void> => {
		try {
			const { keywords, page, limit, matchingStrategy } = req.query;
			const userId = req.user?.sub;

			if (!userId) {
				res.status(401).json({ message: req.t('errors.unauthorized') });
				return;
			}

			const filters = parseSearchFilters(req.query);
			const query = typeof keywords === 'string' ? keywords : '';
			const hasCriteria =
				query.trim().length > 0 || hasStructuralFilters(filters) || hasTextFilters(filters);

			if (!hasCriteria) {
				res.status(400).json({ message: req.t('search.keywordsRequired') });
				return;
			}

			const results = await this.searchService.searchEmails(
				{
					query,
					filters: Object.keys(filters).length > 0 ? filters : undefined,
					page: page ? parseInt(page as string) : 1,
					limit: limit ? parseInt(limit as string) : 10,
					matchingStrategy: (matchingStrategy as MatchingStrategy) || 'last',
				},
				userId,
				req.ip || 'unknown'
			);

			res.status(200).json(results);
		} catch (error) {
			const message = error instanceof Error ? error.message : req.t('errors.unknown');
			res.status(500).json({ message });
		}
	};

	public getTags = async (req: Request, res: Response): Promise<void> => {
		try {
			const userId = req.user?.sub;

			if (!userId) {
				res.status(401).json({ message: req.t('errors.unauthorized') });
				return;
			}

			const tags = await this.searchService.getAvailableTags(userId);
			res.status(200).json({ tags });
		} catch (error) {
			const message = error instanceof Error ? error.message : req.t('errors.unknown');
			res.status(500).json({ message });
		}
	};
}
