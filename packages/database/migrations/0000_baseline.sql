-- GENERATED FILE — DO NOT EDIT BY HAND.
--
-- Regenerate with: pnpm --filter @haive/database baseline:generate --force
--
-- The genesis migration. This is the ONLY file permitted to create the whole schema, and it is
-- what the runner applies to a fresh database. Everything in migrations/pre-baseline/ predates
-- it and is never executed — see that directory's README for why replaying it is unsafe.
--
-- FROZEN once committed. Its sha256 is recorded in schema_migrations on every install that has
-- run it, so an edit here — including a comment — hard-fails every one of them with a checksum
-- mismatch. It legitimately falls behind the schema barrel the moment the next numbered
-- migration lands; that is correct and is why the CI schema-parity job proves END-STATE
-- equivalence against `drizzle-kit push --force` rather than regenerating and diffing this file.
--
-- Regenerating is a deliberate schema re-cut, never part of a feature. A re-cut must ship as a
-- LATER numbered baseline that adoption stamps rather than runs, or every existing install is
-- asked to re-create tables it already has.

CREATE TYPE "public"."user_role" AS ENUM('admin', 'user');
CREATE TYPE "public"."user_status" AS ENUM('active', 'deactivated');
CREATE TYPE "public"."cli_auth_mode" AS ENUM('subscription', 'api_key');
CREATE TYPE "public"."cli_auth_status" AS ENUM('unknown', 'ok', 'auth_expired', 'auth_denied', 'rate_limited', 'network_error', 'timeout', 'unknown_error');
CREATE TYPE "public"."cli_provider_name" AS ENUM('claude-code', 'codex', 'gemini', 'amp', 'zai', 'antigravity', 'ollama', 'muse', 'grok', 'openrouter');
CREATE TYPE "public"."cli_sandbox_build_status" AS ENUM('idle', 'building', 'ready', 'failed');
CREATE TYPE "public"."repo_source" AS ENUM('local_path', 'git_https', 'github_https', 'github_oauth', 'gitlab_https', 'upload', 'blank');
CREATE TYPE "public"."repo_status" AS ENUM('cloning', 'ready', 'error');
CREATE TYPE "public"."agent_mining_status" AS ENUM('pending', 'running', 'done', 'failed');
CREATE TYPE "public"."cli_invocation_mode" AS ENUM('cli', 'subagent_emulated', 'agent_mining', 'dag_parallel');
CREATE TYPE "public"."step_status" AS ENUM('pending', 'running', 'waiting_form', 'waiting_cli', 'done', 'failed', 'skipped');
CREATE TYPE "public"."task_status" AS ENUM('created', 'queued', 'running', 'paused', 'waiting_user', 'waiting_pr', 'completed', 'failed', 'cancelled');
CREATE TYPE "public"."workflow_type" AS ENUM('onboarding', 'workflow', 'env_replicate', 'onboarding_upgrade', 'kb_author', 'run_app', 'plan_build', 'plan_chat', 'advisory', 'plan_sequence', 'plan_merge');
CREATE TYPE "public"."dag_agent_role" AS ENUM('coder', 'reviewer', 'issue_advisor', 'replanner');
CREATE TYPE "public"."dag_issue_outcome" AS ENUM('pending', 'running', 'completed', 'completed_with_debt', 'failed_unrecoverable');
CREATE TYPE "public"."review_finding_disposition" AS ENUM('open', 'fixed', 'recurred', 'dismissed_human', 'dismissed_refuted', 'accepted_risk');
CREATE TYPE "public"."review_severity" AS ENUM('critical', 'high', 'medium', 'low');
CREATE TYPE "public"."container_purpose" AS ENUM('task', 'cli_login');
CREATE TYPE "public"."container_runtime" AS ENUM('clawker', 'dockerode');
CREATE TYPE "public"."container_status" AS ENUM('creating', 'running', 'stopped', 'destroyed', 'error');
CREATE TYPE "public"."env_template_status" AS ENUM('pending', 'building', 'ready', 'failed');
CREATE TYPE "public"."artifact_source" AS ENUM('onboarding', 'upgrade', 'rollback', 'backfill');
CREATE TYPE "public"."custom_bundle_item_kind" AS ENUM('agent', 'skill');
CREATE TYPE "public"."custom_bundle_item_source_format" AS ENUM('claude-md', 'codex-toml', 'gemini-md');
CREATE TYPE "public"."custom_bundle_source_type" AS ENUM('zip', 'git');
CREATE TYPE "public"."custom_bundle_status" AS ENUM('active', 'syncing', 'failed');
CREATE TYPE "public"."price_feed" AS ENUM('openrouter', 'litellm', 'manual', 'ollama');
CREATE TYPE "public"."plan_code_link_role" AS ENUM('implements', 'covers');
CREATE TYPE "public"."plan_edge_kind" AS ENUM('depends_on', 'affects', 'implements');
CREATE TYPE "public"."plan_node_kind" AS ENUM('component', 'decision', 'research', 'external');
CREATE TYPE "public"."plan_node_origin" AS ENUM('user', 'llm', 'import');
CREATE TYPE "public"."plan_node_status" AS ENUM('todo', 'in_progress', 'blocked_human', 'done', 'not_applicable');
CREATE TYPE "public"."plan_node_task_role" AS ENUM('implements', 'touched');
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "system_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(255) NOT NULL,
	"encrypted_value" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "user_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"key_name" varchar(255) NOT NULL,
	"encrypted_value" text NOT NULL,
	"encrypted_dek" text NOT NULL,
	"fingerprint" varchar(64),
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_encrypted" text NOT NULL,
	"email_blind_index" varchar(64) NOT NULL,
	"password_hash" text NOT NULL,
	"name" text,
	"phone_encrypted" text,
	"git_name" text,
	"git_email" text,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"token_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "cli_package_versions" (
	"name" "cli_provider_name" PRIMARY KEY NOT NULL,
	"versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"latest_version" text,
	"fetched_at" timestamp,
	"fetch_error" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "cli_provider_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"secret_name" varchar(255) NOT NULL,
	"encrypted_value" text NOT NULL,
	"encrypted_dek" text NOT NULL,
	"fingerprint" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "cli_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" "cli_provider_name" NOT NULL,
	"label" varchar(255) NOT NULL,
	"executable_path" text,
	"wrapper_path" text,
	"wrapper_content" text,
	"env_vars" jsonb,
	"cli_args" jsonb,
	"supports_subagents" boolean DEFAULT false NOT NULL,
	"network_policy" jsonb DEFAULT '{"mode":"full","domains":[],"ips":[]}'::jsonb NOT NULL,
	"egress_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auth_mode" "cli_auth_mode" DEFAULT 'subscription' NOT NULL,
	"cli_version" text,
	"effort_level" text,
	"model" text,
	"modelfile" text,
	"model_provision_status" text DEFAULT 'idle' NOT NULL,
	"model_provision_error" text,
	"model_limits" jsonb,
	"sandbox_dockerfile_extra" text,
	"sandbox_image_tag" text,
	"sandbox_image_build_status" "cli_sandbox_build_status" DEFAULT 'idle' NOT NULL,
	"sandbox_image_build_error" text,
	"sandbox_image_built_at" timestamp,
	"enabled" boolean DEFAULT true NOT NULL,
	"isolate_auth" boolean DEFAULT false NOT NULL,
	"disable_thinking" boolean DEFAULT false NOT NULL,
	"auth_status" "cli_auth_status" DEFAULT 'unknown' NOT NULL,
	"auth_last_checked_at" timestamp,
	"auth_message" text,
	"rules_content" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "openrouter_model_cache" (
	"name" "cli_provider_name" PRIMARY KEY NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp,
	"fetch_error" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "user_step_cli_preferences" (
	"user_id" uuid NOT NULL,
	"step_id" varchar(128) NOT NULL,
	"cli_provider_id" uuid NOT NULL,
	"explicit" boolean DEFAULT false NOT NULL,
	"effort_level" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "user_step_cli_role_preferences" (
	"user_id" uuid NOT NULL,
	"step_id" varchar(128) NOT NULL,
	"role" varchar(32) NOT NULL,
	"cli_provider_id" uuid NOT NULL,
	"explicit" boolean DEFAULT false NOT NULL,
	"effort_level" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "repo_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" varchar(255) NOT NULL,
	"host" varchar(255) NOT NULL,
	"username_encrypted" text NOT NULL,
	"secret_encrypted" text NOT NULL,
	"encrypted_dek" text NOT NULL,
	"git_name" text,
	"git_email" text,
	"provider" varchar(32),
	"api_base_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "repo_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text,
	"branch" varchar(255) DEFAULT 'main',
	"filename" text NOT NULL,
	"archive_format" varchar(16) NOT NULL,
	"total_size" bigint NOT NULL,
	"bytes_received" bigint DEFAULT 0 NOT NULL,
	"chunk_size" integer NOT NULL,
	"archive_path" text NOT NULL,
	"status" varchar(16) DEFAULT 'uploading' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"source" "repo_source" NOT NULL,
	"local_path" text,
	"remote_url" text,
	"branch" varchar(255) DEFAULT 'main',
	"status" "repo_status" DEFAULT 'ready' NOT NULL,
	"status_message" text,
	"detected_framework" varchar(64),
	"detected_languages" jsonb,
	"file_tree" jsonb,
	"scope_exclude_globs" jsonb,
	"onboarding_environment" jsonb,
	"onboarding_tooling" jsonb,
	"onboarded_at" timestamp,
	"kb_synced_commit" varchar(40),
	"plan_synced_commit" varchar(40),
	"storage_path" text,
	"size_bytes" integer,
	"credentials_secret_id" uuid,
	"applicable_template_ids" text[],
	"writable" boolean DEFAULT false NOT NULL,
	"rtk_enabled" boolean DEFAULT true NOT NULL,
	"rtk_version" text,
	"lsp_server_versions" jsonb,
	"chrome_devtools_mcp_version" text,
	"lsp_servers" text[],
	"secret_mask_enabled" boolean DEFAULT true NOT NULL,
	"secret_mask_allow" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secret_mask_deny_extend" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pr_workflow_enabled" boolean DEFAULT true NOT NULL,
	"step_guidance_enabled" boolean DEFAULT true NOT NULL,
	"review_dimensions" text[],
	"rag_embed_degraded_at" timestamp,
	"rag_embed_degraded_reason" text,
	"rag_embed_lexical_only" boolean DEFAULT false NOT NULL,
	"app_auth" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "db_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"dump_format" varchar(16) NOT NULL,
	"total_size" bigint NOT NULL,
	"bytes_received" bigint DEFAULT 0 NOT NULL,
	"chunk_size" integer NOT NULL,
	"dump_path" text NOT NULL,
	"status" varchar(16) DEFAULT 'uploading' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "cli_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"task_step_id" uuid,
	"summary_for_step_id" uuid,
	"cli_provider_id" uuid,
	"mode" "cli_invocation_mode" NOT NULL,
	"prompt" text NOT NULL,
	"env_vars" jsonb,
	"exit_code" integer,
	"raw_output" text,
	"stream_log" text,
	"status_message" varchar(256),
	"agent_title" varchar(256),
	"steerable" boolean DEFAULT false NOT NULL,
	"consumed_at" timestamp,
	"parsed_output" jsonb,
	"token_usage" jsonb,
	"cost" jsonb,
	"model_identity" jsonb,
	"effort" jsonb,
	"provider_fatal_class" text,
	"timeout_ms" integer,
	"duration_ms" integer,
	"container_id" varchar(255),
	"error_message" text,
	"started_at" timestamp,
	"ended_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"superseded_at" timestamp
);

CREATE TABLE "task_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"task_step_id" uuid,
	"event_type" varchar(64) NOT NULL,
	"payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "task_step_agent_minings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_step_id" uuid NOT NULL,
	"agent_id" varchar(128) NOT NULL,
	"agent_title" varchar(256),
	"cli_provider_id" uuid,
	"status" "agent_mining_status" DEFAULT 'pending' NOT NULL,
	"cli_invocation_id" uuid,
	"output" jsonb,
	"raw_output" text,
	"error_message" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"timeout_attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp,
	"user_retry_requested_at" timestamp,
	"started_at" timestamp,
	"ended_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "task_step_cli_touched" (
	"task_id" uuid NOT NULL,
	"step_id" varchar(128) NOT NULL,
	"role" varchar(32) DEFAULT 'default' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "task_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"step_id" varchar(128) NOT NULL,
	"step_index" double precision NOT NULL,
	"run_seq" integer,
	"round" integer DEFAULT 0 NOT NULL,
	"title" varchar(512) NOT NULL,
	"status" "step_status" DEFAULT 'pending' NOT NULL,
	"detect_output" jsonb,
	"form_schema" jsonb,
	"form_values" jsonb,
	"output" jsonb,
	"iterations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"iteration_count" integer DEFAULT 0 NOT NULL,
	"status_message" text,
	"warning_message" text,
	"summary" text,
	"error_message" text,
	"error_hint" jsonb,
	"degraded_note" text,
	"ai_fix_context" jsonb,
	"merge_resolve_state" jsonb,
	"local_model_override" boolean DEFAULT false NOT NULL,
	"pause_form_on_retry" boolean DEFAULT false NOT NULL,
	"cli_timeout_override_ms" integer,
	"cli_timeout_learned_ms" integer,
	"started_at" timestamp,
	"ended_at" timestamp,
	"idle_ms" integer DEFAULT 0 NOT NULL,
	"waiting_started_at" timestamp,
	"user_active_ms" integer DEFAULT 0 NOT NULL,
	"carried_work_ms" integer DEFAULT 0 NOT NULL,
	"carried_idle_ms" integer DEFAULT 0 NOT NULL,
	"carried_user_active_ms" integer DEFAULT 0 NOT NULL,
	"context_left_percent" integer,
	"context_tokens" integer,
	"context_window_size" integer,
	"usage_five_hour_pct" integer,
	"usage_seven_day_pct" integer,
	"usage_daily_pct" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "task_user_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_step_id" uuid NOT NULL,
	"question_id" varchar(128) NOT NULL,
	"answer_type" varchar(32) NOT NULL,
	"answer_value" jsonb,
	"answered_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"repository_id" uuid,
	"cli_provider_id" uuid,
	"summary_cli_provider_id" uuid,
	"env_template_id" uuid,
	"db_upload_id" uuid,
	"parent_task_id" uuid,
	"type" "workflow_type" NOT NULL,
	"title" varchar(512) NOT NULL,
	"description" text,
	"status" "task_status" DEFAULT 'created' NOT NULL,
	"current_step_id" varchar(128),
	"current_step_index" double precision DEFAULT 0 NOT NULL,
	"container_id" varchar(255),
	"worktree_path" text,
	"worktree_branch" text,
	"model_identity" jsonb,
	"commit_sha" text,
	"changed_paths" jsonb,
	"pr_provider" varchar(32),
	"pr_url" text,
	"pr_number" text,
	"pr_state" text,
	"pr_merged_at" timestamp,
	"pr_finalize_mode" text,
	"pr_poll_error" text,
	"pr_credential_id" uuid,
	"memory_limit_mb" integer,
	"cpu_limit_milli" integer,
	"metadata" jsonb,
	"simplify_code" boolean DEFAULT false NOT NULL,
	"adversarial_qa_level" text,
	"broad_audit" boolean DEFAULT true NOT NULL,
	"review_dimensions" text[],
	"debug_mode" boolean DEFAULT false NOT NULL,
	"expose_db_port" boolean DEFAULT false NOT NULL,
	"direct_access" boolean DEFAULT false NOT NULL,
	"awaiting_allowance_provider_id" uuid,
	"awaiting_provider_reason" varchar(16),
	"awaiting_provider_since" timestamp,
	"allowance_reset_at" timestamp,
	"allowance_replenished_at" timestamp,
	"allowance_auto_resume_count" integer DEFAULT 0 NOT NULL,
	"allowance_auto_resumed_at" timestamp,
	"estimated_time_hours" double precision,
	"ai_estimated_time_hours" double precision,
	"ai_estimate_low_hours" double precision,
	"ai_estimate_high_hours" double precision,
	"execution_path" varchar(32),
	"step_loop_limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auto_continue" boolean DEFAULT true NOT NULL,
	"ignore_saved_step_clis" boolean DEFAULT false NOT NULL,
	"summary_llm_enabled" boolean DEFAULT true NOT NULL,
	"cli_choice_recorded" boolean DEFAULT false NOT NULL,
	"summary_cli_choice_recorded" boolean DEFAULT false NOT NULL,
	"pre_answers" jsonb,
	"current_round" integer DEFAULT 0 NOT NULL,
	"max_fix_rounds" integer DEFAULT 5 NOT NULL,
	"orchestration_epoch" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"paused_at" timestamp,
	"vote_score" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "dag_agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dag_issue_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"role" "dag_agent_role" NOT NULL,
	"iteration" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"cli_invocation_id" uuid,
	"output" jsonb,
	"raw_output" text,
	"consumed_at" timestamp,
	"started_at" timestamp,
	"ended_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "task_dag_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dag_plan_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"issue_key" varchar(64) NOT NULL,
	"level" integer NOT NULL,
	"title" varchar(512) NOT NULL,
	"description" text,
	"spec_sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"estimated_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provides" text,
	"guidance" jsonb,
	"worktree_path" text,
	"sandbox_worktree_path" text,
	"branch_name" varchar(256),
	"outcome" "dag_issue_outcome" DEFAULT 'pending' NOT NULL,
	"cli_invocation_id" uuid,
	"infra_retries" integer DEFAULT 0 NOT NULL,
	"review_infra_retries" integer DEFAULT 0 NOT NULL,
	"files_modified" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"debt_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"concerns" text,
	"raw_output" text,
	"error_message" text,
	"review_status" varchar(32),
	"inner_iteration" integer DEFAULT 0 NOT NULL,
	"stuck_count" integer DEFAULT 0 NOT NULL,
	"reviewer_verdict" jsonb,
	"advisor_invocations" integer DEFAULT 0 NOT NULL,
	"last_advisor_action" varchar(32),
	"retry_context" jsonb,
	"parent_issue_id" uuid,
	"resolution" varchar(32),
	"merge_status" varchar(32),
	"merged_at" timestamp,
	"started_at" timestamp,
	"ended_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "task_dag_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dag_plan_id" uuid NOT NULL,
	"level" integer NOT NULL,
	"issue_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"phase" varchar(32) DEFAULT 'pending' NOT NULL,
	"merge_state" jsonb,
	"checkpointed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "task_dag_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"task_step_id" uuid NOT NULL,
	"mode" varchar(16) NOT NULL,
	"rationale" text,
	"max_parallel" integer DEFAULT 1 NOT NULL,
	"levels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"plan_json" jsonb,
	"replan_count" integer DEFAULT 0 NOT NULL,
	"auto_resolve_conflicts" boolean DEFAULT false NOT NULL,
	"review_enabled" boolean DEFAULT false NOT NULL,
	"replanner_invocations" integer DEFAULT 0 NOT NULL,
	"last_replanner_action" varchar(32),
	"replanner_invocation_id" uuid,
	"escalation_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"debt_aggregate" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "review_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"task_step_id" uuid,
	"cli_invocation_id" uuid,
	"step_id" varchar(128) NOT NULL,
	"round" integer DEFAULT 0 NOT NULL,
	"reviewer_id" varchar(128) NOT NULL,
	"severity" "review_severity" NOT NULL,
	"path" text,
	"line_start" integer,
	"line_end" integer,
	"issue" text NOT NULL,
	"fix" text,
	"fingerprint" varchar(64) NOT NULL,
	"blocking" boolean DEFAULT false NOT NULL,
	"recurrence_count" integer DEFAULT 0 NOT NULL,
	"disposition" "review_finding_disposition" DEFAULT 'open' NOT NULL,
	"disposition_at" timestamp,
	"disposition_source" varchar(128),
	"raw" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "task_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"stored_path" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"content_type" varchar(128),
	"description" text,
	"expanded_from_id" uuid,
	"expanded_at" timestamp,
	"expansion_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"action" varchar(64) NOT NULL,
	"target_type" varchar(64) NOT NULL,
	"target_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "containers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid,
	"purpose" "container_purpose" DEFAULT 'task' NOT NULL,
	"cli_provider_id" uuid,
	"runtime" "container_runtime" DEFAULT 'clawker' NOT NULL,
	"docker_container_id" varchar(255),
	"name" varchar(255),
	"status" "container_status" DEFAULT 'creating' NOT NULL,
	"mount_paths" jsonb,
	"env_vars" jsonb,
	"pid" integer,
	"attached_ws_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"destroyed_at" timestamp
);

CREATE TABLE "browser_version_cache" (
	"browser" varchar(32) PRIMARY KEY NOT NULL,
	"versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp,
	"fetch_error" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "env_dep_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"repository_id" uuid,
	"name" varchar(255) NOT NULL,
	"step_id" text DEFAULT '01-declare-deps' NOT NULL,
	"values" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "env_template_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"env_template_id" uuid NOT NULL,
	"path" text NOT NULL,
	"contents" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "env_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"repository_id" uuid,
	"name" varchar(255) NOT NULL,
	"base_image" varchar(255) NOT NULL,
	"declared_deps" jsonb,
	"generated_dockerfile" text,
	"dockerfile_hash" varchar(64),
	"image_tag" varchar(255),
	"built_image_id" varchar(255),
	"status" "env_template_status" DEFAULT 'pending' NOT NULL,
	"last_built_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "runtime_version_cache" (
	"runtime" varchar(32) PRIMARY KEY NOT NULL,
	"versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp,
	"fetch_error" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "onboarding_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"disk_path" text NOT NULL,
	"template_id" text NOT NULL,
	"template_kind" text NOT NULL,
	"template_schema_version" integer NOT NULL,
	"template_content_hash" varchar(64) NOT NULL,
	"written_hash" varchar(64) NOT NULL,
	"written_content" text,
	"last_observed_disk_hash" varchar(64),
	"user_modified" boolean DEFAULT false NOT NULL,
	"form_values_snapshot" jsonb,
	"source_step_id" varchar(128) NOT NULL,
	"source" "artifact_source" DEFAULT 'onboarding' NOT NULL,
	"haive_version" varchar(32),
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"superseded_at" timestamp,
	"bundle_item_id" uuid
);

CREATE TABLE "template_manifest_cache" (
	"template_id" varchar(128) PRIMARY KEY NOT NULL,
	"template_kind" text NOT NULL,
	"schema_version" integer NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"set_hash" varchar(64) NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "tool_package_versions" (
	"name" text PRIMARY KEY NOT NULL,
	"versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"latest_version" text,
	"latest_sha256" text,
	"fetched_at" timestamp,
	"fetch_error" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "custom_bundle_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bundle_id" uuid NOT NULL,
	"kind" "custom_bundle_item_kind" NOT NULL,
	"source_format" "custom_bundle_item_source_format" NOT NULL,
	"source_path" text NOT NULL,
	"normalized_spec" jsonb NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "custom_bundle_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"bundle_id" uuid,
	"repository_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"enabled_kinds" text[] DEFAULT ARRAY['agent','skill']::text[] NOT NULL,
	"filename" text NOT NULL,
	"archive_format" varchar(16) NOT NULL,
	"total_size" bigint NOT NULL,
	"bytes_received" bigint DEFAULT 0 NOT NULL,
	"chunk_size" integer NOT NULL,
	"archive_path" text NOT NULL,
	"status" varchar(16) DEFAULT 'uploading' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "custom_bundles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"source_type" "custom_bundle_source_type" NOT NULL,
	"archive_filename" text,
	"archive_path" text,
	"archive_format" varchar(16),
	"git_url" text,
	"git_branch" varchar(255),
	"git_credentials_id" uuid,
	"storage_root" text NOT NULL,
	"enabled_kinds" text[] DEFAULT ARRAY['agent','skill']::text[] NOT NULL,
	"last_sync_at" timestamp,
	"last_sync_commit" varchar(40),
	"last_sync_error" text,
	"status" "custom_bundle_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "terminal_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"container_id" uuid NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"full_log" text DEFAULT '' NOT NULL,
	"byte_count" integer DEFAULT 0 NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL
);

CREATE TABLE "rag_query_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"query" text NOT NULL,
	"top_k" integer,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"kb_hits" integer DEFAULT 0 NOT NULL,
	"code_hits" integer DEFAULT 0 NOT NULL,
	"runbook_hits" integer DEFAULT 0 NOT NULL,
	"learning_hits" integer DEFAULT 0 NOT NULL,
	"global_hits" integer DEFAULT 0 NOT NULL,
	"max_rrf" double precision DEFAULT 0 NOT NULL,
	"max_dense" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "user_ide_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"settings_json" text DEFAULT '{}' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "user_notification_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"sound_enabled" boolean DEFAULT true NOT NULL,
	"usage_alert_enabled" boolean DEFAULT true NOT NULL,
	"sound_path" text,
	"sound_mime" varchar(64),
	"sound_filename" varchar(255),
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "user_ui_prefs" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"settings_json" text DEFAULT '{}' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "usage_window_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_name" varchar(64) NOT NULL,
	"five_hour_pct" integer,
	"five_hour_reset_at" timestamp,
	"seven_day_pct" integer,
	"seven_day_reset_at" timestamp,
	"daily_pct" integer,
	"daily_reset_at" timestamp,
	"status" varchar(16) DEFAULT 'ok' NOT NULL,
	"error_message" text,
	"fetched_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "cli_model_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "cli_provider_name",
	"model_key" text NOT NULL,
	"source" "price_feed" NOT NULL,
	"rates" jsonb NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"note" text,
	"effective_from" timestamp DEFAULT now() NOT NULL,
	"effective_to" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "cli_pricing_sync" (
	"name" "cli_provider_name" PRIMARY KEY NOT NULL,
	"auto_update_enabled" boolean DEFAULT true NOT NULL,
	"preferred_feed" "price_feed",
	"fetched_at" timestamp,
	"fetch_error" text,
	"price_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "fx_rates" (
	"rate_date" date NOT NULL,
	"currency" varchar(3) NOT NULL,
	"usd_per_unit" double precision NOT NULL,
	"source" varchar(16) DEFAULT 'ecb' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "step_guidance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"step_id" text NOT NULL,
	"scope" text NOT NULL,
	"repository_id" uuid,
	"facets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_family" text,
	"cause" text NOT NULL,
	"guidance" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"fingerprint" text NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"source_task_id" uuid,
	"source_step_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "plan_mirror_state" (
	"repository_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"written_revision" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"written_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "plan_mirror_state_revision_nonnegative" CHECK ("plan_mirror_state"."revision" >= 0),
	CONSTRAINT "plan_mirror_state_written_nonnegative" CHECK ("plan_mirror_state"."written_revision" >= 0),
	CONSTRAINT "plan_mirror_state_written_not_ahead" CHECK ("plan_mirror_state"."written_revision" <= "plan_mirror_state"."revision")
);

CREATE TABLE "plan_node_code_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"repo_path" text NOT NULL,
	"symbol" text,
	"role" "plan_code_link_role" DEFAULT 'implements' NOT NULL,
	"evidence" text,
	"derived_at_commit" varchar(40),
	"confidence" real,
	"stale" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "plan_node_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"from_node_id" uuid NOT NULL,
	"to_node_id" uuid NOT NULL,
	"kind" "plan_edge_kind" NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "plan_node_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"task_id" uuid,
	"cli_provider_id" uuid,
	"role" varchar(16) NOT NULL,
	"body" text NOT NULL,
	"patch_json" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "plan_node_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"role" "plan_node_task_role" DEFAULT 'implements' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "plan_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"parent_id" uuid,
	"path" text NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"title" varchar(512) NOT NULL,
	"kind" "plan_node_kind" DEFAULT 'component' NOT NULL,
	"body" text,
	"status" "plan_node_status" DEFAULT 'todo' NOT NULL,
	"done_at" timestamp,
	"taskable" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"last_reviewed_at" timestamp,
	"created_by" "plan_node_origin" DEFAULT 'user' NOT NULL,
	"source_task_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "user_plan_node_reads" (
	"user_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"last_read_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_plan_node_reads_user_id_node_id_pk" PRIMARY KEY("user_id","node_id")
);

ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "user_secrets" ADD CONSTRAINT "user_secrets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "cli_provider_secrets" ADD CONSTRAINT "cli_provider_secrets_provider_id_cli_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."cli_providers"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "cli_providers" ADD CONSTRAINT "cli_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "user_step_cli_preferences" ADD CONSTRAINT "user_step_cli_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "user_step_cli_preferences" ADD CONSTRAINT "user_step_cli_preferences_cli_provider_id_cli_providers_id_fk" FOREIGN KEY ("cli_provider_id") REFERENCES "public"."cli_providers"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "user_step_cli_role_preferences" ADD CONSTRAINT "user_step_cli_role_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "user_step_cli_role_preferences" ADD CONSTRAINT "user_step_cli_role_preferences_cli_provider_id_cli_providers_id_fk" FOREIGN KEY ("cli_provider_id") REFERENCES "public"."cli_providers"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "repo_credentials" ADD CONSTRAINT "repo_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "repo_uploads" ADD CONSTRAINT "repo_uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_credentials_secret_id_repo_credentials_id_fk" FOREIGN KEY ("credentials_secret_id") REFERENCES "public"."repo_credentials"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "db_uploads" ADD CONSTRAINT "db_uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "cli_invocations" ADD CONSTRAINT "cli_invocations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "cli_invocations" ADD CONSTRAINT "cli_invocations_task_step_id_task_steps_id_fk" FOREIGN KEY ("task_step_id") REFERENCES "public"."task_steps"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "cli_invocations" ADD CONSTRAINT "cli_invocations_summary_for_step_id_task_steps_id_fk" FOREIGN KEY ("summary_for_step_id") REFERENCES "public"."task_steps"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "cli_invocations" ADD CONSTRAINT "cli_invocations_cli_provider_id_cli_providers_id_fk" FOREIGN KEY ("cli_provider_id") REFERENCES "public"."cli_providers"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_step_id_task_steps_id_fk" FOREIGN KEY ("task_step_id") REFERENCES "public"."task_steps"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "task_step_agent_minings" ADD CONSTRAINT "task_step_agent_minings_task_step_id_task_steps_id_fk" FOREIGN KEY ("task_step_id") REFERENCES "public"."task_steps"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "task_step_agent_minings" ADD CONSTRAINT "task_step_agent_minings_cli_provider_id_cli_providers_id_fk" FOREIGN KEY ("cli_provider_id") REFERENCES "public"."cli_providers"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "task_step_cli_touched" ADD CONSTRAINT "task_step_cli_touched_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "task_steps" ADD CONSTRAINT "task_steps_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "task_user_inputs" ADD CONSTRAINT "task_user_inputs_task_step_id_task_steps_id_fk" FOREIGN KEY ("task_step_id") REFERENCES "public"."task_steps"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_cli_provider_id_cli_providers_id_fk" FOREIGN KEY ("cli_provider_id") REFERENCES "public"."cli_providers"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_summary_cli_provider_id_cli_providers_id_fk" FOREIGN KEY ("summary_cli_provider_id") REFERENCES "public"."cli_providers"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_env_template_id_env_templates_id_fk" FOREIGN KEY ("env_template_id") REFERENCES "public"."env_templates"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_db_upload_id_db_uploads_id_fk" FOREIGN KEY ("db_upload_id") REFERENCES "public"."db_uploads"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_awaiting_allowance_provider_id_cli_providers_id_fk" FOREIGN KEY ("awaiting_allowance_provider_id") REFERENCES "public"."cli_providers"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "dag_agent_runs" ADD CONSTRAINT "dag_agent_runs_dag_issue_id_task_dag_issues_id_fk" FOREIGN KEY ("dag_issue_id") REFERENCES "public"."task_dag_issues"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "dag_agent_runs" ADD CONSTRAINT "dag_agent_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "task_dag_issues" ADD CONSTRAINT "task_dag_issues_dag_plan_id_task_dag_plans_id_fk" FOREIGN KEY ("dag_plan_id") REFERENCES "public"."task_dag_plans"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "task_dag_issues" ADD CONSTRAINT "task_dag_issues_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "task_dag_levels" ADD CONSTRAINT "task_dag_levels_dag_plan_id_task_dag_plans_id_fk" FOREIGN KEY ("dag_plan_id") REFERENCES "public"."task_dag_plans"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "task_dag_plans" ADD CONSTRAINT "task_dag_plans_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "task_dag_plans" ADD CONSTRAINT "task_dag_plans_task_step_id_task_steps_id_fk" FOREIGN KEY ("task_step_id") REFERENCES "public"."task_steps"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_task_step_id_task_steps_id_fk" FOREIGN KEY ("task_step_id") REFERENCES "public"."task_steps"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_cli_invocation_id_cli_invocations_id_fk" FOREIGN KEY ("cli_invocation_id") REFERENCES "public"."cli_invocations"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_expanded_from_id_task_attachments_id_fk" FOREIGN KEY ("expanded_from_id") REFERENCES "public"."task_attachments"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "containers" ADD CONSTRAINT "containers_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "containers" ADD CONSTRAINT "containers_cli_provider_id_cli_providers_id_fk" FOREIGN KEY ("cli_provider_id") REFERENCES "public"."cli_providers"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "env_dep_presets" ADD CONSTRAINT "env_dep_presets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "env_dep_presets" ADD CONSTRAINT "env_dep_presets_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "env_template_files" ADD CONSTRAINT "env_template_files_env_template_id_env_templates_id_fk" FOREIGN KEY ("env_template_id") REFERENCES "public"."env_templates"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "env_templates" ADD CONSTRAINT "env_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "env_templates" ADD CONSTRAINT "env_templates_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "onboarding_artifacts" ADD CONSTRAINT "onboarding_artifacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "onboarding_artifacts" ADD CONSTRAINT "onboarding_artifacts_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "onboarding_artifacts" ADD CONSTRAINT "onboarding_artifacts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "onboarding_artifacts" ADD CONSTRAINT "onboarding_artifacts_bundle_item_id_custom_bundle_items_id_fk" FOREIGN KEY ("bundle_item_id") REFERENCES "public"."custom_bundle_items"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "custom_bundle_items" ADD CONSTRAINT "custom_bundle_items_bundle_id_custom_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."custom_bundles"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "custom_bundle_uploads" ADD CONSTRAINT "custom_bundle_uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "custom_bundle_uploads" ADD CONSTRAINT "custom_bundle_uploads_bundle_id_custom_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."custom_bundles"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "custom_bundle_uploads" ADD CONSTRAINT "custom_bundle_uploads_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "custom_bundles" ADD CONSTRAINT "custom_bundles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "custom_bundles" ADD CONSTRAINT "custom_bundles_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "custom_bundles" ADD CONSTRAINT "custom_bundles_git_credentials_id_repo_credentials_id_fk" FOREIGN KEY ("git_credentials_id") REFERENCES "public"."repo_credentials"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "rag_query_log" ADD CONSTRAINT "rag_query_log_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "user_ide_settings" ADD CONSTRAINT "user_ide_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "user_notification_settings" ADD CONSTRAINT "user_notification_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "user_ui_prefs" ADD CONSTRAINT "user_ui_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "usage_window_snapshots" ADD CONSTRAINT "usage_window_snapshots_provider_id_cli_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."cli_providers"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "usage_window_snapshots" ADD CONSTRAINT "usage_window_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "step_guidance" ADD CONSTRAINT "step_guidance_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "step_guidance" ADD CONSTRAINT "step_guidance_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "plan_mirror_state" ADD CONSTRAINT "plan_mirror_state_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plan_node_code_links" ADD CONSTRAINT "plan_node_code_links_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plan_node_code_links" ADD CONSTRAINT "plan_node_code_links_node_id_plan_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."plan_nodes"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plan_node_edges" ADD CONSTRAINT "plan_node_edges_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plan_node_edges" ADD CONSTRAINT "plan_node_edges_from_node_id_plan_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."plan_nodes"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plan_node_edges" ADD CONSTRAINT "plan_node_edges_to_node_id_plan_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."plan_nodes"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plan_node_messages" ADD CONSTRAINT "plan_node_messages_node_id_plan_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."plan_nodes"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plan_node_messages" ADD CONSTRAINT "plan_node_messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "plan_node_messages" ADD CONSTRAINT "plan_node_messages_cli_provider_id_cli_providers_id_fk" FOREIGN KEY ("cli_provider_id") REFERENCES "public"."cli_providers"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "plan_node_tasks" ADD CONSTRAINT "plan_node_tasks_node_id_plan_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."plan_nodes"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plan_node_tasks" ADD CONSTRAINT "plan_node_tasks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plan_nodes" ADD CONSTRAINT "plan_nodes_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plan_nodes" ADD CONSTRAINT "plan_nodes_parent_id_plan_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."plan_nodes"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "plan_nodes" ADD CONSTRAINT "plan_nodes_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "user_plan_node_reads" ADD CONSTRAINT "user_plan_node_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "user_plan_node_reads" ADD CONSTRAINT "user_plan_node_reads_node_id_plan_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."plan_nodes"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens" USING btree ("user_id");
CREATE UNIQUE INDEX "system_secrets_key_idx" ON "system_secrets" USING btree ("key");
CREATE INDEX "user_secrets_user_id_idx" ON "user_secrets" USING btree ("user_id");
CREATE UNIQUE INDEX "user_secrets_user_key_idx" ON "user_secrets" USING btree ("user_id","key_name");
CREATE UNIQUE INDEX "users_email_blind_index_idx" ON "users" USING btree ("email_blind_index");
CREATE INDEX "cli_provider_secrets_provider_id_idx" ON "cli_provider_secrets" USING btree ("provider_id");
CREATE UNIQUE INDEX "cli_provider_secrets_provider_name_idx" ON "cli_provider_secrets" USING btree ("provider_id","secret_name");
CREATE INDEX "cli_providers_user_id_idx" ON "cli_providers" USING btree ("user_id");
CREATE UNIQUE INDEX "user_step_cli_pref_pk" ON "user_step_cli_preferences" USING btree ("user_id","step_id");
CREATE UNIQUE INDEX "user_step_cli_role_pref_pk" ON "user_step_cli_role_preferences" USING btree ("user_id","step_id","role");
CREATE INDEX "repo_credentials_user_id_idx" ON "repo_credentials" USING btree ("user_id");
CREATE INDEX "repo_credentials_host_idx" ON "repo_credentials" USING btree ("host");
CREATE INDEX "repo_uploads_user_id_idx" ON "repo_uploads" USING btree ("user_id");
CREATE INDEX "repo_uploads_status_idx" ON "repo_uploads" USING btree ("status");
CREATE INDEX "repositories_user_id_idx" ON "repositories" USING btree ("user_id");
CREATE INDEX "repositories_status_idx" ON "repositories" USING btree ("status");
CREATE INDEX "db_uploads_user_id_idx" ON "db_uploads" USING btree ("user_id");
CREATE INDEX "db_uploads_status_idx" ON "db_uploads" USING btree ("status");
CREATE INDEX "cli_invocations_task_id_idx" ON "cli_invocations" USING btree ("task_id");
CREATE INDEX "cli_invocations_task_step_id_idx" ON "cli_invocations" USING btree ("task_step_id");
CREATE INDEX "cli_invocations_started_at_idx" ON "cli_invocations" USING btree ("started_at");
CREATE INDEX "cli_invocations_ended_at_idx" ON "cli_invocations" USING btree ("ended_at");
CREATE UNIQUE INDEX "cli_invocations_one_live_per_step_idx" ON "cli_invocations" USING btree ("task_step_id") WHERE "cli_invocations"."ended_at" is null and "cli_invocations"."superseded_at" is null and "cli_invocations"."mode" <> 'agent_mining' and "cli_invocations"."mode" <> 'dag_parallel';
CREATE INDEX "task_events_task_id_idx" ON "task_events" USING btree ("task_id");
CREATE INDEX "task_events_event_type_idx" ON "task_events" USING btree ("event_type");
CREATE INDEX "task_step_agent_minings_task_step_id_idx" ON "task_step_agent_minings" USING btree ("task_step_id");
CREATE UNIQUE INDEX "task_step_agent_minings_step_agent_idx" ON "task_step_agent_minings" USING btree ("task_step_id","agent_id");
CREATE UNIQUE INDEX "task_step_cli_touched_pk" ON "task_step_cli_touched" USING btree ("task_id","step_id","role");
CREATE INDEX "task_step_cli_touched_task_id_idx" ON "task_step_cli_touched" USING btree ("task_id");
CREATE INDEX "task_steps_task_id_idx" ON "task_steps" USING btree ("task_id");
CREATE UNIQUE INDEX "task_steps_task_step_round_idx" ON "task_steps" USING btree ("task_id","step_id","round");
CREATE INDEX "task_user_inputs_task_step_id_idx" ON "task_user_inputs" USING btree ("task_step_id");
CREATE INDEX "tasks_user_id_idx" ON "tasks" USING btree ("user_id");
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");
CREATE INDEX "tasks_repository_id_idx" ON "tasks" USING btree ("repository_id");
CREATE INDEX "tasks_env_template_id_idx" ON "tasks" USING btree ("env_template_id");
CREATE INDEX "tasks_parent_task_id_idx" ON "tasks" USING btree ("parent_task_id");
CREATE INDEX "tasks_user_completed_at_idx" ON "tasks" USING btree ("user_id","completed_at");
CREATE INDEX "tasks_status_completed_at_idx" ON "tasks" USING btree ("status","completed_at");
CREATE INDEX "dag_agent_runs_issue_idx" ON "dag_agent_runs" USING btree ("dag_issue_id");
CREATE INDEX "dag_agent_runs_task_idx" ON "dag_agent_runs" USING btree ("task_id");
CREATE INDEX "task_dag_issues_plan_id_idx" ON "task_dag_issues" USING btree ("dag_plan_id");
CREATE INDEX "task_dag_issues_task_level_idx" ON "task_dag_issues" USING btree ("task_id","level");
CREATE UNIQUE INDEX "task_dag_issues_plan_issue_idx" ON "task_dag_issues" USING btree ("dag_plan_id","issue_key");
CREATE INDEX "task_dag_levels_plan_id_idx" ON "task_dag_levels" USING btree ("dag_plan_id");
CREATE UNIQUE INDEX "task_dag_levels_plan_level_idx" ON "task_dag_levels" USING btree ("dag_plan_id","level");
CREATE INDEX "task_dag_plans_task_id_idx" ON "task_dag_plans" USING btree ("task_id");
CREATE UNIQUE INDEX "task_dag_plans_task_step_idx" ON "task_dag_plans" USING btree ("task_step_id");
CREATE INDEX "review_findings_task_id_idx" ON "review_findings" USING btree ("task_id");
CREATE INDEX "review_findings_task_fingerprint_idx" ON "review_findings" USING btree ("task_id","fingerprint");
CREATE INDEX "review_findings_task_step_id_idx" ON "review_findings" USING btree ("task_step_id");
CREATE UNIQUE INDEX "review_findings_dedupe_idx" ON "review_findings" USING btree ("task_id","task_step_id","round","fingerprint");
CREATE INDEX "task_attachments_task_id_idx" ON "task_attachments" USING btree ("task_id");
CREATE INDEX "task_attachments_user_id_idx" ON "task_attachments" USING btree ("user_id");
CREATE INDEX "task_attachments_expanded_from_idx" ON "task_attachments" USING btree ("expanded_from_id");
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id");
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_id");
CREATE INDEX "audit_events_created_idx" ON "audit_events" USING btree ("created_at");
CREATE INDEX "audit_events_action_idx" ON "audit_events" USING btree ("action");
CREATE INDEX "containers_task_id_idx" ON "containers" USING btree ("task_id");
CREATE INDEX "containers_status_idx" ON "containers" USING btree ("status");
CREATE INDEX "containers_cli_provider_id_idx" ON "containers" USING btree ("cli_provider_id");
CREATE INDEX "env_dep_presets_repository_id_idx" ON "env_dep_presets" USING btree ("repository_id");
CREATE UNIQUE INDEX "env_dep_presets_repo_step_name_idx" ON "env_dep_presets" USING btree ("repository_id","step_id","name");
CREATE UNIQUE INDEX "env_dep_presets_global_step_name_idx" ON "env_dep_presets" USING btree ("user_id","step_id","name") WHERE "env_dep_presets"."repository_id" IS NULL;
CREATE INDEX "env_template_files_template_id_idx" ON "env_template_files" USING btree ("env_template_id");
CREATE INDEX "env_templates_user_id_idx" ON "env_templates" USING btree ("user_id");
CREATE INDEX "env_templates_repository_id_idx" ON "env_templates" USING btree ("repository_id");
CREATE UNIQUE INDEX "env_templates_user_hash_idx" ON "env_templates" USING btree ("user_id","dockerfile_hash");
CREATE INDEX "onboarding_artifacts_repo_id_idx" ON "onboarding_artifacts" USING btree ("repository_id");
CREATE INDEX "onboarding_artifacts_task_id_idx" ON "onboarding_artifacts" USING btree ("task_id");
CREATE INDEX "onboarding_artifacts_superseded_idx" ON "onboarding_artifacts" USING btree ("superseded_at");
CREATE INDEX "onboarding_artifacts_bundle_item_idx" ON "onboarding_artifacts" USING btree ("bundle_item_id");
CREATE UNIQUE INDEX "onboarding_artifacts_repo_path_live_idx" ON "onboarding_artifacts" USING btree ("repository_id","disk_path") WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX "custom_bundle_items_bundle_path_idx" ON "custom_bundle_items" USING btree ("bundle_id","source_path");
CREATE INDEX "custom_bundle_items_bundle_kind_idx" ON "custom_bundle_items" USING btree ("bundle_id","kind");
CREATE INDEX "custom_bundle_uploads_user_id_idx" ON "custom_bundle_uploads" USING btree ("user_id");
CREATE INDEX "custom_bundle_uploads_status_idx" ON "custom_bundle_uploads" USING btree ("status");
CREATE INDEX "custom_bundles_repository_id_idx" ON "custom_bundles" USING btree ("repository_id");
CREATE INDEX "custom_bundles_user_repo_idx" ON "custom_bundles" USING btree ("user_id","repository_id");
CREATE INDEX "terminal_sessions_user_id_idx" ON "terminal_sessions" USING btree ("user_id");
CREATE INDEX "terminal_sessions_container_id_idx" ON "terminal_sessions" USING btree ("container_id");
CREATE INDEX "rag_query_log_task_created_idx" ON "rag_query_log" USING btree ("task_id","created_at");
CREATE UNIQUE INDEX "usage_window_provider_idx" ON "usage_window_snapshots" USING btree ("provider_id");
CREATE INDEX "usage_window_user_idx" ON "usage_window_snapshots" USING btree ("user_id");
CREATE UNIQUE INDEX "cli_model_prices_live_idx" ON "cli_model_prices" USING btree ("provider","model_key","source") WHERE "cli_model_prices"."effective_to" is null;
CREATE INDEX "cli_model_prices_lookup_idx" ON "cli_model_prices" USING btree ("model_key","effective_from");
CREATE UNIQUE INDEX "fx_rates_date_currency_idx" ON "fx_rates" USING btree ("rate_date","currency");
CREATE UNIQUE INDEX "step_guidance_repo_fp_idx" ON "step_guidance" USING btree ("step_id","repository_id","fingerprint") WHERE "step_guidance"."repository_id" IS NOT NULL;
CREATE UNIQUE INDEX "step_guidance_global_fp_idx" ON "step_guidance" USING btree ("step_id","fingerprint") WHERE "step_guidance"."repository_id" IS NULL;
CREATE INDEX "step_guidance_step_status_idx" ON "step_guidance" USING btree ("step_id","status");
CREATE INDEX "plan_mirror_state_dirty_idx" ON "plan_mirror_state" USING btree ("repository_id") WHERE "plan_mirror_state"."written_revision" < "plan_mirror_state"."revision";
CREATE INDEX "plan_node_code_links_node_idx" ON "plan_node_code_links" USING btree ("node_id");
CREATE INDEX "plan_node_code_links_repo_path_idx" ON "plan_node_code_links" USING btree ("repository_id","repo_path");
CREATE UNIQUE INDEX "plan_node_code_links_unique_idx" ON "plan_node_code_links" USING btree ("node_id","repo_path",coalesce("symbol", ''));
CREATE UNIQUE INDEX "plan_node_edges_unique_idx" ON "plan_node_edges" USING btree ("from_node_id","to_node_id","kind");
CREATE INDEX "plan_node_edges_from_idx" ON "plan_node_edges" USING btree ("from_node_id");
CREATE INDEX "plan_node_edges_to_idx" ON "plan_node_edges" USING btree ("to_node_id");
CREATE INDEX "plan_node_edges_repo_idx" ON "plan_node_edges" USING btree ("repository_id");
CREATE INDEX "plan_node_messages_node_created_idx" ON "plan_node_messages" USING btree ("node_id","created_at");
CREATE UNIQUE INDEX "plan_node_tasks_unique_idx" ON "plan_node_tasks" USING btree ("node_id","task_id");
CREATE INDEX "plan_node_tasks_task_idx" ON "plan_node_tasks" USING btree ("task_id");
CREATE UNIQUE INDEX "plan_nodes_one_root_per_repo_idx" ON "plan_nodes" USING btree ("repository_id") WHERE "plan_nodes"."parent_id" IS NULL;
CREATE INDEX "plan_nodes_repo_parent_ordinal_idx" ON "plan_nodes" USING btree ("repository_id","parent_id","ordinal");
CREATE INDEX "plan_nodes_path_idx" ON "plan_nodes" USING btree ("path" text_pattern_ops);
