/**
 * Strips directory components and dangerous characters from an uploaded filename.
 */
export function sanitizeUploadFilename(filename: string, maxLength = 200): string {
	const base =
		filename
			.replace(/\\/g, '/')
			.split('/')
			.pop()
			?.replace(/\0/g, '')
			.replace(/\.\./g, '')
			.trim()
			.slice(0, maxLength) ?? '';

	if (!base || base === '.' || base === '..') {
		return 'upload.bin';
	}
	return base;
}
