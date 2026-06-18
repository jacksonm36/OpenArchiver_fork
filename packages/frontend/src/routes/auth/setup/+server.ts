import { env } from '$env/dynamic/private';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setAuthCookie } from '$lib/server/session';
import type { LoginResponse } from '@open-archiver/types';

const BACKEND_URL = `http://localhost:${env.PORT_BACKEND || 4000}`;

export const POST: RequestHandler = async ({ request, cookies }) => {
	let body: Record<string, string>;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid request body');
	}

	const response = await fetch(`${BACKEND_URL}/v1/auth/setup`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const errBody = await response.json().catch(() => ({}));
		throw error(response.status, errBody.message || 'Setup failed');
	}

	const loginData: LoginResponse = await response.json();
	setAuthCookie(cookies, loginData.accessToken);

	return json({ user: loginData.user });
};
