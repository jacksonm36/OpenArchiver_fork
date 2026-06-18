import { env } from '$env/dynamic/private';
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { AUTH_COOKIE_NAME } from '$lib/server/session';

const BACKEND_URL = `http://localhost:${env.PORT_BACKEND || 4000}`;

const STRIPPED_REQUEST_HEADERS = new Set([
	'connection',
	'cookie',
	'host',
	'keep-alive',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
]);

const handleRequest: RequestHandler = async ({ request, params, fetch, cookies }) => {
	const url = new URL(request.url);
	const slug = params.slug || '';
	const targetUrl = `${BACKEND_URL}/${slug}${url.search}`;

	try {
		const headers = new Headers();
		for (const [key, value] of request.headers.entries()) {
			if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) {
				headers.set(key, value);
			}
		}

		const sessionToken = cookies.get(AUTH_COOKIE_NAME);
		if (sessionToken && !headers.has('authorization')) {
			headers.set('Authorization', `Bearer ${sessionToken}`);
		}

		const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

		const proxyRequest = new Request(targetUrl, {
			method: request.method,
			headers,
			body: hasBody ? request.body : null,
			duplex: hasBody ? 'half' : undefined,
		} as RequestInit);

		return await fetch(proxyRequest);
	} catch (error: any) {
		console.error('Proxy request failed:', error);

		const statusCode = error?.status || 500;
		const message =
			error?.body?.message || error?.message || 'Failed to connect to the backend service.';

		return json(
			{
				status: 'error',
				statusCode: statusCode,
				message: message,
				errors: null,
			},
			{ status: statusCode }
		);
	}
};

export const GET = handleRequest;
export const POST = handleRequest;
export const PUT = handleRequest;
export const PATCH = handleRequest;
export const DELETE = handleRequest;
