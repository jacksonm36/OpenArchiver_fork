/**
 * Lightweight Message-ID extraction from raw EML bytes (no mailparser).
 * Used to skip full parsing on duplicate file-import messages.
 */
const MESSAGE_ID_HEADER = /^Message-ID:\s*(.+)$/im;
const MAX_HEADER_SCAN = 64 * 1024;

function normalizeMessageId(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
		return trimmed;
	}
	return trimmed;
}

export function extractMessageIdFromEmlBytes(buffer: Buffer): string | null {
	const scanLength = Math.min(buffer.length, MAX_HEADER_SCAN);
	const headerSection = buffer.toString('utf8', 0, scanLength);
	const match = headerSection.match(MESSAGE_ID_HEADER);
	if (!match?.[1]) {
		return null;
	}
	return normalizeMessageId(match[1]);
}
