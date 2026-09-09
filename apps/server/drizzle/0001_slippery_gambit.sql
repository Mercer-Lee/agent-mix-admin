CREATE TYPE "public"."model_check_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."model_profile_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('queued', 'running', 'completed', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."conversation_message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'published');--> statement-breakpoint
CREATE TABLE "agent_department_access_grants" (
	"agent_subject_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"include_descendants" boolean DEFAULT false NOT NULL,
	"created_by_subject_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_department_access_grants_agent_subject_id_department_id_pk" PRIMARY KEY("agent_subject_id","department_id")
);
--> statement-breakpoint
CREATE TABLE "agent_role_access_grants" (
	"agent_subject_id" uuid NOT NULL,
	"role_subject_id" uuid NOT NULL,
	"created_by_subject_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_role_access_grants_agent_subject_id_role_subject_id_pk" PRIMARY KEY("agent_subject_id","role_subject_id")
);
--> statement-breakpoint
CREATE TABLE "agent_user_access_grants" (
	"agent_subject_id" uuid NOT NULL,
	"user_subject_id" uuid NOT NULL,
	"created_by_subject_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_user_access_grants_agent_subject_id_user_subject_id_pk" PRIMARY KEY("agent_subject_id","user_subject_id")
);
--> statement-breakpoint
CREATE TABLE "model_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_profile_id" uuid NOT NULL,
	"requested_by_subject_id" uuid,
	"status" "model_check_status" DEFAULT 'queued' NOT NULL,
	"latency_ms" integer,
	"usage" jsonb,
	"error_code" varchar(64),
	"error_message" varchar(240),
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_checks_latency_check" CHECK ("model_checks"."latency_ms" is null or "model_checks"."latency_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "model_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(64) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"provider" varchar(32) DEFAULT 'openai-compatible' NOT NULL,
	"connection" varchar(32) DEFAULT 'default' NOT NULL,
	"model_id" varchar(200) NOT NULL,
	"status" "model_profile_status" DEFAULT 'active' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_profiles_key_format_check" CHECK ("model_profiles"."key" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
	CONSTRAINT "model_profiles_provider_check" CHECK ("model_profiles"."provider" = 'openai-compatible'),
	CONSTRAINT "model_profiles_connection_check" CHECK ("model_profiles"."connection" = 'default'),
	CONSTRAINT "model_profiles_model_id_check" CHECK (length(btrim("model_profiles"."model_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "agent_runtimes" (
	"agent_subject_id" uuid PRIMARY KEY NOT NULL,
	"model_profile_id" uuid NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"temperature" double precision DEFAULT 0.2 NOT NULL,
	"max_output_tokens" integer DEFAULT 2048 NOT NULL,
	"max_steps" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runtimes_temperature_check" CHECK ("agent_runtimes"."temperature" >= 0 and "agent_runtimes"."temperature" <= 2),
	CONSTRAINT "agent_runtimes_max_output_tokens_check" CHECK ("agent_runtimes"."max_output_tokens" >= 1 and "agent_runtimes"."max_output_tokens" <= 131072),
	CONSTRAINT "agent_runtimes_max_steps_check" CHECK ("agent_runtimes"."max_steps" >= 1 and "agent_runtimes"."max_steps" <= 5)
);
--> statement-breakpoint
CREATE TABLE "agent_run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" varchar(128) NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"type" varchar(100) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_run_events_sequence_check" CHECK ("agent_run_events"."sequence" >= 0),
	CONSTRAINT "agent_run_events_attempt_check" CHECK ("agent_run_events"."attempt" >= 1 and "agent_run_events"."attempt" <= 2)
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"requested_by_subject_id" uuid NOT NULL,
	"agent_subject_id" uuid NOT NULL,
	"model_profile_id" uuid NOT NULL,
	"user_message_id" uuid NOT NULL,
	"assistant_message_id" uuid,
	"idempotency_key" uuid NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"status" "agent_run_status" DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"execution_snapshot" jsonb NOT NULL,
	"usage" jsonb,
	"finish_reason" varchar(64),
	"error_code" varchar(64),
	"error_message" varchar(240),
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_attempt_check" CHECK ("agent_runs"."attempt" >= 0 and "agent_runs"."attempt" <= 2)
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "conversation_message_role" NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_subject_id" uuid NOT NULL,
	"agent_subject_id" uuid NOT NULL,
	"title" varchar(200) DEFAULT 'New conversation' NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"model_check_id" uuid,
	"topic" varchar(100) NOT NULL,
	"deduplication_key" varchar(128) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" varchar(128),
	"published_at" timestamp with time zone,
	"last_error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_single_owner_check" CHECK (("outbox_events"."run_id" is null) <> ("outbox_events"."model_check_id" is null)),
	CONSTRAINT "outbox_events_attempts_check" CHECK ("outbox_events"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_department_access_grants" ADD CONSTRAINT "agent_department_access_grants_agent_subject_id_agents_subject_id_fk" FOREIGN KEY ("agent_subject_id") REFERENCES "public"."agents"("subject_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_department_access_grants" ADD CONSTRAINT "agent_department_access_grants_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_department_access_grants" ADD CONSTRAINT "agent_department_access_grants_created_by_subject_id_subjects_id_fk" FOREIGN KEY ("created_by_subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_role_access_grants" ADD CONSTRAINT "agent_role_access_grants_agent_subject_id_agents_subject_id_fk" FOREIGN KEY ("agent_subject_id") REFERENCES "public"."agents"("subject_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_role_access_grants" ADD CONSTRAINT "agent_role_access_grants_role_subject_id_roles_subject_id_fk" FOREIGN KEY ("role_subject_id") REFERENCES "public"."roles"("subject_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_role_access_grants" ADD CONSTRAINT "agent_role_access_grants_created_by_subject_id_subjects_id_fk" FOREIGN KEY ("created_by_subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_user_access_grants" ADD CONSTRAINT "agent_user_access_grants_agent_subject_id_agents_subject_id_fk" FOREIGN KEY ("agent_subject_id") REFERENCES "public"."agents"("subject_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_user_access_grants" ADD CONSTRAINT "agent_user_access_grants_user_subject_id_users_subject_id_fk" FOREIGN KEY ("user_subject_id") REFERENCES "public"."users"("subject_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_user_access_grants" ADD CONSTRAINT "agent_user_access_grants_created_by_subject_id_subjects_id_fk" FOREIGN KEY ("created_by_subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_checks" ADD CONSTRAINT "model_checks_model_profile_id_model_profiles_id_fk" FOREIGN KEY ("model_profile_id") REFERENCES "public"."model_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_checks" ADD CONSTRAINT "model_checks_requested_by_subject_id_subjects_id_fk" FOREIGN KEY ("requested_by_subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtimes" ADD CONSTRAINT "agent_runtimes_agent_subject_id_agents_subject_id_fk" FOREIGN KEY ("agent_subject_id") REFERENCES "public"."agents"("subject_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtimes" ADD CONSTRAINT "agent_runtimes_model_profile_id_model_profiles_id_fk" FOREIGN KEY ("model_profile_id") REFERENCES "public"."model_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_requested_by_subject_id_users_subject_id_fk" FOREIGN KEY ("requested_by_subject_id") REFERENCES "public"."users"("subject_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_subject_id_agents_subject_id_fk" FOREIGN KEY ("agent_subject_id") REFERENCES "public"."agents"("subject_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_model_profile_id_model_profiles_id_fk" FOREIGN KEY ("model_profile_id") REFERENCES "public"."model_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_message_id_conversation_messages_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_assistant_message_id_conversation_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_subject_id_users_subject_id_fk" FOREIGN KEY ("user_subject_id") REFERENCES "public"."users"("subject_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_subject_id_agents_subject_id_fk" FOREIGN KEY ("agent_subject_id") REFERENCES "public"."agents"("subject_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_model_check_id_model_checks_id_fk" FOREIGN KEY ("model_check_id") REFERENCES "public"."model_checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_department_access_department_idx" ON "agent_department_access_grants" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "agent_role_access_role_idx" ON "agent_role_access_grants" USING btree ("role_subject_id");--> statement-breakpoint
CREATE INDEX "agent_user_access_user_idx" ON "agent_user_access_grants" USING btree ("user_subject_id");--> statement-breakpoint
CREATE INDEX "model_checks_profile_created_idx" ON "model_checks" USING btree ("model_profile_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "model_profiles_key_uidx" ON "model_profiles" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_events_event_id_uidx" ON "agent_run_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "agent_run_events_run_attempt_sequence_idx" ON "agent_run_events" USING btree ("run_id","attempt","sequence");--> statement-breakpoint
CREATE INDEX "agent_run_events_run_id_idx" ON "agent_run_events" USING btree ("run_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_request_idempotency_uidx" ON "agent_runs" USING btree ("requested_by_subject_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_user_message_uidx" ON "agent_runs" USING btree ("user_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_assistant_message_uidx" ON "agent_runs" USING btree ("assistant_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_one_active_per_conversation_uidx" ON "agent_runs" USING btree ("conversation_id") WHERE "agent_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "agent_runs_conversation_created_idx" ON "agent_runs" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_status_queued_idx" ON "agent_runs" USING btree ("status","queued_at");--> statement-breakpoint
CREATE INDEX "conversation_messages_conversation_created_idx" ON "conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "conversations_user_updated_idx" ON "conversations" USING btree ("user_subject_id","updated_at");--> statement-breakpoint
CREATE INDEX "conversations_agent_idx" ON "conversations" USING btree ("agent_subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_deduplication_uidx" ON "outbox_events" USING btree ("deduplication_key");--> statement-breakpoint
CREATE INDEX "outbox_events_dispatch_idx" ON "outbox_events" USING btree ("status","available_at");--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "users" u JOIN "subjects" s ON s."id" = u."subject_id" WHERE s."type" <> 'user'
	) THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Existing users rows do not match subjects.type';
	END IF;
	IF EXISTS (
		SELECT 1 FROM "roles" r JOIN "subjects" s ON s."id" = r."subject_id" WHERE s."type" <> 'role'
	) THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Existing roles rows do not match subjects.type';
	END IF;
	IF EXISTS (
		SELECT 1 FROM "agents" a JOIN "subjects" s ON s."id" = a."subject_id" WHERE s."type" <> 'agent'
	) THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Existing agents rows do not match subjects.type';
	END IF;
	IF EXISTS (
		SELECT 1
		FROM "subject_roles" sr
		JOIN "subjects" s ON s."id" = sr."subject_id"
		WHERE s."type" NOT IN ('user', 'agent')
	) THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Existing role-to-role assignments are not supported';
	END IF;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "agentmix_enforce_subject_subtype"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	actual_type "subject_type";
BEGIN
	SELECT "type" INTO actual_type FROM "subjects" WHERE "id" = NEW."subject_id";
	IF actual_type IS DISTINCT FROM TG_ARGV[0]::"subject_type" THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = format('%s.subject_id must reference a subject of type %s', TG_TABLE_NAME, TG_ARGV[0]);
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "users_subject_subtype_trigger"
BEFORE INSERT OR UPDATE OF "subject_id" ON "users"
FOR EACH ROW EXECUTE FUNCTION "agentmix_enforce_subject_subtype"('user');--> statement-breakpoint
CREATE TRIGGER "roles_subject_subtype_trigger"
BEFORE INSERT OR UPDATE OF "subject_id" ON "roles"
FOR EACH ROW EXECUTE FUNCTION "agentmix_enforce_subject_subtype"('role');--> statement-breakpoint
CREATE TRIGGER "agents_subject_subtype_trigger"
BEFORE INSERT OR UPDATE OF "subject_id" ON "agents"
FOR EACH ROW EXECUTE FUNCTION "agentmix_enforce_subject_subtype"('agent');--> statement-breakpoint
CREATE FUNCTION "agentmix_enforce_subject_type_update"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."type" = OLD."type" THEN
		RETURN NEW;
	END IF;
	IF EXISTS (SELECT 1 FROM "users" WHERE "subject_id" = NEW."id") AND NEW."type" <> 'user' THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A user subtype cannot change its subject type';
	END IF;
	IF EXISTS (SELECT 1 FROM "roles" WHERE "subject_id" = NEW."id") AND NEW."type" <> 'role' THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A role subtype cannot change its subject type';
	END IF;
	IF EXISTS (SELECT 1 FROM "agents" WHERE "subject_id" = NEW."id") AND NEW."type" <> 'agent' THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An agent subtype cannot change its subject type';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "subjects_type_update_trigger"
BEFORE UPDATE OF "type" ON "subjects"
FOR EACH ROW EXECUTE FUNCTION "agentmix_enforce_subject_type_update"();--> statement-breakpoint
CREATE FUNCTION "agentmix_enforce_role_holder_type"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	holder_type "subject_type";
BEGIN
	SELECT "type" INTO holder_type FROM "subjects" WHERE "id" = NEW."subject_id";
	IF holder_type IS NULL OR holder_type NOT IN ('user', 'agent') THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'subject_roles.subject_id must reference a user or agent; role nesting is not supported';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "subject_roles_holder_type_trigger"
BEFORE INSERT OR UPDATE OF "subject_id" ON "subject_roles"
FOR EACH ROW EXECUTE FUNCTION "agentmix_enforce_role_holder_type"();--> statement-breakpoint
CREATE FUNCTION "agentmix_enforce_run_snapshot_immutable"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD."execution_snapshot" IS DISTINCT FROM NEW."execution_snapshot" THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'agent_runs.execution_snapshot is immutable';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "agent_runs_snapshot_immutable_trigger"
BEFORE UPDATE OF "execution_snapshot" ON "agent_runs"
FOR EACH ROW EXECUTE FUNCTION "agentmix_enforce_run_snapshot_immutable"();--> statement-breakpoint
CREATE FUNCTION "agentmix_protect_system_agent"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD."is_system" THEN
			RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'System agents cannot be deleted';
		END IF;
		RETURN OLD;
	END IF;
	IF OLD."is_system" AND NOT NEW."is_system" THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'System agents cannot lose system status';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "agents_protect_system_trigger"
BEFORE DELETE OR UPDATE OF "is_system" ON "agents"
FOR EACH ROW EXECUTE FUNCTION "agentmix_protect_system_agent"();
