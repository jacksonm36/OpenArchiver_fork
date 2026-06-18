export interface UploadProgress {
	loaded: number;
	total: number;
	percent: number;
}

export interface UploadResult {
	filePath: string;
	originalFilename: string;
}

/**
 * Uploads a file with progress events. Session auth uses the HttpOnly cookie
 * via the SvelteKit API proxy.
 */
export function uploadFileWithProgress(
	file: File,
	onProgress?: (progress: UploadProgress) => void
): Promise<UploadResult> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		const formData = new FormData();
		formData.append('file', file);

		xhr.open('POST', '/api/v1/upload');
		xhr.withCredentials = true;

		xhr.upload.onprogress = (event) => {
			if (!onProgress) return;
			const total = event.lengthComputable ? event.total : file.size;
			const loaded = event.loaded;
			const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
			onProgress({ loaded, total, percent });
		};

		xhr.onload = () => {
			let result: Record<string, string> = {};
			try {
				result = JSON.parse(xhr.responseText);
			} catch {
				reject(new Error('Upload failed: invalid server response'));
				return;
			}

			if (xhr.status >= 200 && xhr.status < 300 && result.filePath) {
				resolve({
					filePath: result.filePath,
					originalFilename: file.name,
				});
				return;
			}

			reject(new Error(result.message || `Upload failed (${xhr.status})`));
		};

		xhr.onerror = () => {
			reject(new Error('Upload failed: network error'));
		};

		xhr.send(formData);
	});
}

export function formatUploadBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
