import { api } from '$lib/server/api';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireSuperAdmin } from '$lib/server/requireSuperAdmin';

export const GET: RequestHandler = async (event) => {
	requireSuperAdmin(event);

	const since = event.url.searchParams.get('since');
	const path = since ? `/jobs/monitor?since=${encodeURIComponent(since)}` : '/jobs/monitor';
	const response = await api(path, event);

	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		throw error(response.status, body.message || 'Failed to fetch monitor data');
	}

	return new Response(response.body, {
		status: response.status,
		headers: {
			'Content-Type': 'application/json',
		},
	});
};
