import { error, type RequestEvent } from '@sveltejs/kit';
import { isSuperAdmin } from './session';

export function requireSuperAdmin(event: RequestEvent): void {
	if (!event.locals.user) {
		throw error(401, 'Unauthorized');
	}
	if (!isSuperAdmin(event.locals.sessionUser)) {
		throw error(403, 'Super Admin role is required');
	}
}
