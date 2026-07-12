CREATE TABLE "device_location_overrides" (
	"server_user_id" uuid NOT NULL,
	"device_id" varchar(255) NOT NULL,
	"city" varchar(255) NOT NULL,
	"region" varchar(255),
	"country" varchar(100) NOT NULL,
	"latitude" real NOT NULL,
	"longitude" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_location_overrides_server_user_id_device_id_pk" PRIMARY KEY("server_user_id","device_id"),
	CONSTRAINT "device_location_overrides_latitude_check" CHECK ("device_location_overrides"."latitude" BETWEEN -90 AND 90),
	CONSTRAINT "device_location_overrides_longitude_check" CHECK ("device_location_overrides"."longitude" BETWEEN -180 AND 180)
);
--> statement-breakpoint
ALTER TABLE "device_location_overrides" ADD CONSTRAINT "device_location_overrides_server_user_id_server_users_id_fk" FOREIGN KEY ("server_user_id") REFERENCES "public"."server_users"("id") ON DELETE cascade ON UPDATE no action;