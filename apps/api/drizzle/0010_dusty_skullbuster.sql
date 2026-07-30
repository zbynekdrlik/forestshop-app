ALTER TABLE "pairing" DROP CONSTRAINT "pairing_confirmed_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "pairing" ADD CONSTRAINT "pairing_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pairing_confirmed_by_idx" ON "pairing" USING btree ("confirmed_by");