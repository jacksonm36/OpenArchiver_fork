const BASE_URL = '/api/v1';

/**
 * Client-side API wrapper. Authentication uses the HttpOnly session cookie;
 * the SvelteKit API proxy attaches the Bearer token server-side.
 */
export const api = async (url: string, options: RequestInit = {}): Promise<Response> => {
	const defaultHeaders: HeadersInit = {};

	if (!(options.body instanceof FormData)) {
		defaultHeaders['Content-Type'] = 'application/json';
	}

	const mergedOptions: RequestInit = {
		...options,
		credentials: 'same-origin',
		headers: {
			...defaultHeaders,
			...options.headers,
		},
	};

	return fetch(`${BASE_URL}${url}`, mergedOptions);
};
