import { api } from '$lib/server/api';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireSuperAdmin } from '$lib/server/requireSuperAdmin';

export const GET: RequestHandler = async (event) => {
	requireSuperAdmin(event);

	const queueName = event.url.searchParams.get('queue');
	const status = event.url.searchParams.get('status') || 'failed';
	const limit = event.url.searchParams.get('limit') || '5';

	if (!queueName) {
		throw error(400, 'queue is required');
	}

	const response = await api(
		`/jobs/queues/${encodeURIComponent(queueName)}?status=${encodeURIComponent(status)}&limit=${encodeURIComponent(limit)}`,
		event
	);

	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		throw error(response.status, body.message || 'Failed to fetch queue jobs');
	}

	return new Response(response.body, {
		status: response.status,
		headers: {
			'Content-Type': 'application/json',
		},
	});
};
