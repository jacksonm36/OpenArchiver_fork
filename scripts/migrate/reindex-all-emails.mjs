#!/usr/bin/env node
/**
 * Queues a full Meilisearch re-index for all archived emails.
 * Required after migrating to the fork (new index fields: tags, hasAttachments).
 *
 * Usage (from repository root, with .env loaded):
 *   node --env-file=.env scripts/migrate/reindex-all-emails.mjs
 *   REINDEX_BATCH_SIZE=50 node --env-file=.env scripts/migrate/reindex-all-emails.mjs
 */
import 'dotenv/config';
import postgres from 'postgres';
import { Queue } from 'bullmq';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error('DATABASE_URL is not set');
	process.exit(1);
}

const batchSize = Math.max(1, parseInt(process.env.REINDEX_BATCH_SIZE || '50', 10));

const connection = {
	host: process.env.REDIS_HOST || 'localhost',
	port: parseInt(process.env.REDIS_PORT || '6379', 10),
	password: process.env.REDIS_PASSWORD || undefined,
	username: process.env.REDIS_USER || undefined,
};

if (process.env.REDIS_TLS_ENABLED === 'true') {
	connection.tls = { rejectUnauthorized: false };
}

const sql = postgres(databaseUrl, { max: 1 });
const indexingQueue = new Queue('indexing', { connection });

try {
	const rows = await sql`SELECT id FROM archived_emails ORDER BY archived_at ASC`;
	const total = rows.length;

	if (total === 0) {
		console.log('No archived emails found — nothing to reindex.');
		process.exit(0);
	}

	console.log(`Marking ${total} emails for re-index...`);
	await sql`UPDATE archived_emails SET is_indexed = false`;

	let queued = 0;
	for (let offset = 0; offset < total; offset += batchSize) {
		const slice = rows.slice(offset, offset + batchSize);
		const emails = slice.map((row) => ({ archivedEmailId: row.id }));
		await indexingQueue.add('index-email-batch', { emails });
		queued += emails.length;
		console.log(`Queued ${queued}/${total}`);
	}

	console.log(`Done. ${queued} emails queued for indexing. Ensure indexing workers are running.`);
} finally {
	await indexingQueue.close();
	await sql.end();
}
