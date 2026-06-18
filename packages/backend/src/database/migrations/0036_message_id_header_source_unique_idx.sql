DELETE FROM archived_emails AS newer
USING archived_emails AS older
WHERE newer.id > older.id
	AND newer.message_id_header IS NOT NULL
	AND newer.message_id_header = older.message_id_header
	AND newer.ingestion_source_id = older.ingestion_source_id;--> statement-breakpoint
DROP INDEX IF EXISTS "msgid_header_source_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "message_id_header_source_unique_idx" ON "archived_emails" USING btree ("message_id_header","ingestion_source_id") WHERE "message_id_header" IS NOT NULL;
