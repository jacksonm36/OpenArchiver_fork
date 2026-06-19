/**
 * One-shot: point a PST ingestion source at a local path and queue resume-import.
 * Usage (inside container): node scripts/admin-resume-pst-import.mjs <sourceId> <localPath>
 */
import { IngestionService } from '../packages/backend/dist/services/IngestionService.js';
import { UserService } from '../packages/backend/dist/services/UserService.js';

const sourceId = process.argv[2];
const localPath = process.argv[3];

if (!sourceId || !localPath) {
	console.error('Usage: node scripts/admin-resume-pst-import.mjs <sourceId> <localPath>');
	process.exit(1);
}

const userService = new UserService();
const users = await userService.findAll();
const actor = users[0];
if (!actor) {
	console.error('No users found');
	process.exit(1);
}

const source = await IngestionService.findById(sourceId);
if (!source) {
	console.error('Ingestion source not found:', sourceId);
	process.exit(1);
}

const credentials = source.credentials;
if (!credentials || credentials.type !== 'pst_import') {
	console.error('Source is not a PST import');
	process.exit(1);
}

await IngestionService.update(
	sourceId,
	{
		providerConfig: {
			...credentials,
			type: 'pst_import',
			localFilePath: localPath,
			uploadedFilePath: '',
			uploadedFileName: '',
		},
	},
	actor,
	'127.0.0.1'
);

await IngestionService.triggerResumeImport(sourceId, 'import', actor, '127.0.0.1');
console.log('Resume queued for', sourceId, 'path', localPath);
