CREATE TABLE "relay_device_authorizations" (
	"device_code_hash" varchar(64) PRIMARY KEY,
	"user_code" varchar(16) NOT NULL,
	"client_id" varchar(191) NOT NULL,
	"scope" text NOT NULL,
	"code_challenge" varchar(128) NOT NULL,
	"status" varchar(16) NOT NULL,
	"user_id" varchar(255),
	"callback_state" varchar(64),
	"redirect_uri" text,
	"authorization_code" text,
	"device_name" text,
	"device_platform" varchar(128),
	"client_version" varchar(64),
	"request_ip" varchar(64),
	"request_location" varchar(191),
	"poll_interval_seconds" integer NOT NULL,
	"last_polled_at" varchar(64),
	"expires_at" varchar(64) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);

--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_device_authorizations_user_code" ON "relay_device_authorizations" ("user_code");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_device_authorizations_callback_state" ON "relay_device_authorizations" ("callback_state");
--> statement-breakpoint
CREATE INDEX "idx_relay_device_authorizations_expires_at" ON "relay_device_authorizations" ("expires_at");
