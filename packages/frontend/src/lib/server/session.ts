import type { Cookies } from '@sveltejs/kit';
import type { AuthTokenPayload } from '@open-archiver/types';

export const AUTH_COOKIE_NAME = 'accessToken';
const AUTH_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export type SessionUser = {
	id: string;
	email: string;
	roles: string[];
};

export function setAuthCookie(cookies: Cookies, accessToken: string): void {
	cookies.set(AUTH_COOKIE_NAME, accessToken, {
		path: '/',
		httpOnly: true,
		sameSite: 'strict',
		secure: process.env.NODE_ENV === 'production',
		maxAge: AUTH_MAX_AGE_SECONDS,
	});
}

export function clearAuthCookie(cookies: Cookies): void {
	cookies.delete(AUTH_COOKIE_NAME, { path: '/' });
}

export function sessionUserFromPayload(payload: AuthTokenPayload): SessionUser {
	return {
		id: payload.sub as string,
		email: payload.email,
		roles: payload.roles ?? [],
	};
}

export function isSuperAdmin(user: SessionUser | null | undefined): boolean {
	return user?.roles.includes('Super Admin') ?? false;
}
