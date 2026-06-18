import { writable } from 'svelte/store';
import type { User } from '@open-archiver/types';

interface AuthState {
	user: Omit<User, 'passwordHash'> | null;
}

const initialValue: AuthState = {
	user: null,
};

const createAuthStore = () => {
	const { subscribe, set } = writable<AuthState>(initialValue);

	return {
		subscribe,
		login: (user: Omit<User, 'passwordHash'>) => {
			set({ user });
		},
		logout: () => {
			set(initialValue);
		},
		syncWithServer: (user: Omit<User, 'passwordHash'> | null) => {
			if (user) {
				set({ user });
			} else {
				set(initialValue);
			}
		},
	};
};

export const authStore = createAuthStore();
