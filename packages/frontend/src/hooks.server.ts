import type { Handle } from '@sveltejs/kit';
import { jwtVerify } from 'jose';
import type { AuthTokenPayload } from '@open-archiver/types';
import { sessionUserFromPayload, AUTH_COOKIE_NAME } from '$lib/server/session';
import 'dotenv/config';

const JWT_SECRET_ENCODED = new TextEncoder().encode(process.env.JWT_SECRET);

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(AUTH_COOKIE_NAME);

	if (token) {
		try {
			const { payload } = await jwtVerify<AuthTokenPayload>(token, JWT_SECRET_ENCODED);
			event.locals.sessionUser = sessionUserFromPayload(payload);
			event.locals.user = {
				id: payload.sub as string,
				email: payload.email,
				first_name: null,
				last_name: null,
				role: null,
				createdAt: new Date(),
			};
			event.locals.accessToken = token;
		} catch (error) {
			console.error('JWT verification failed:', error);
			event.locals.sessionUser = null;
			event.locals.user = null;
			event.locals.accessToken = null;
		}
	} else {
		event.locals.sessionUser = null;
		event.locals.user = null;
		event.locals.accessToken = null;
	}
	if (import.meta.env.VITE_ENTERPRISE_MODE === true) {
		event.locals.enterpriseMode = true;
	} else {
		event.locals.enterpriseMode = false;
	}

	return resolve(event);
};
