CREATE TABLE "supplier_contact" (
	"supplier" text PRIMARY KEY NOT NULL,
	"email" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
