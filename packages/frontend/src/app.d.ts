import type { User } from '@open-archiver/types';
import type { SessionUser } from '$lib/server/session';

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			user: Omit<User, 'passwordHash'> | null;
			sessionUser: SessionUser | null;
			accessToken: string | null;
			enterpriseMode: boolean | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
