import { createHash } from 'crypto';
import { createReadStream } from 'fs';

/** SHA-256 hash of a file without loading it entirely into memory. */
export async function hashFile(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		const stream = createReadStream(filePath);
		stream.on('data', (chunk) => hash.update(chunk));
		stream.on('end', () => resolve(hash.digest('hex')));
		stream.on('error', reject);
	});
}
