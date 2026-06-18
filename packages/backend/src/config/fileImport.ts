import 'dotenv/config';

function readMaxUploadMb(): number {
	const raw = process.env.FILE_IMPORT_MAX_UPLOAD_MB?.trim();
	if (raw === '0') {
		return 0;
	}
	if (!raw) {
		return 2048;
	}
	const parsed = parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2048;
}

const maxUploadMb = readMaxUploadMb();
const localPathOnly =
	process.env.FILE_IMPORT_LOCAL_PATH_ONLY === 'true' || maxUploadMb === 0;

export const fileImportConfig = {
	/** When true, browser uploads are disabled; use server local paths only. */
	localPathOnly,
	/** Max browser upload size in MB. 0 disables uploads. Default 2048 (2 GB). */
	maxUploadMb: localPathOnly ? 0 : maxUploadMb,
	maxUploadBytes: localPathOnly ? 0 : maxUploadMb * 1024 * 1024,
};
