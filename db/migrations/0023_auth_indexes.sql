CREATE INDEX "login_attempts_user_at" ON "login_attempts" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_device" ON "sessions" USING btree ("device_id");