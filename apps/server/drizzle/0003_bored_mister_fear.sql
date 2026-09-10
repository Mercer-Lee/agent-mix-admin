CREATE TYPE "public"."mcp_server_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."mcp_tool_risk" AS ENUM('read', 'sensitive_read', 'write', 'critical');--> statement-breakpoint
CREATE TABLE "agent_tool_bindings" (
	"agent_subject_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	"created_by_subject_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tool_bindings_agent_subject_id_tool_id_pk" PRIMARY KEY("agent_subject_id","tool_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(100) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"endpoint_url" varchar(2048) NOT NULL,
	"auth_header_name" varchar(100),
	"auth_env_var" varchar(100),
	"status" "mcp_server_status" DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_slug_format_check" CHECK ("mcp_servers"."slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
	CONSTRAINT "mcp_servers_endpoint_url_check" CHECK ("mcp_servers"."endpoint_url" ~ '^https?://'),
	CONSTRAINT "mcp_servers_auth_pair_check" CHECK (("mcp_servers"."auth_header_name" is null) = ("mcp_servers"."auth_env_var" is null))
);
--> statement-breakpoint
CREATE TABLE "mcp_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"input_schema" jsonb NOT NULL,
	"output_schema" jsonb,
	"risk" "mcp_tool_risk" DEFAULT 'read' NOT NULL,
	"required_permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tools_name_format_check" CHECK ("mcp_tools"."name" ~ '^[a-zA-Z0-9_-]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "agent_tool_bindings" ADD CONSTRAINT "agent_tool_bindings_agent_subject_id_agents_subject_id_fk" FOREIGN KEY ("agent_subject_id") REFERENCES "public"."agents"("subject_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_bindings" ADD CONSTRAINT "agent_tool_bindings_tool_id_mcp_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."mcp_tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_bindings" ADD CONSTRAINT "agent_tool_bindings_created_by_subject_id_subjects_id_fk" FOREIGN KEY ("created_by_subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tools" ADD CONSTRAINT "mcp_tools_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_tool_bindings_tool_idx" ON "agent_tool_bindings" USING btree ("tool_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_slug_uidx" ON "mcp_servers" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tools_server_name_uidx" ON "mcp_tools" USING btree ("server_id","name");--> statement-breakpoint
CREATE INDEX "mcp_tools_enabled_idx" ON "mcp_tools" USING btree ("enabled");