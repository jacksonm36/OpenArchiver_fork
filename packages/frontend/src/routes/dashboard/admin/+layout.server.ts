import type { LayoutServerLoad } from './$types';
import { requireSuperAdmin } from '$lib/server/requireSuperAdmin';

export const load: LayoutServerLoad = async (event) => {
	requireSuperAdmin(event);
	return {};
};
