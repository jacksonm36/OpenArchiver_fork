import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clearAuthCookie } from '$lib/server/session';

export const POST: RequestHandler = async ({ cookies }) => {
	clearAuthCookie(cookies);
	return json({ success: true });
};
