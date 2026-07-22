ALTER TABLE "sessions" ADD COLUMN "is_local" boolean;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "connection_kind" varchar(20);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_connection_kind_check" CHECK ("sessions"."connection_kind" IS NULL OR "sessions"."connection_kind" IN ('direct', 'relay', 'unknown'));