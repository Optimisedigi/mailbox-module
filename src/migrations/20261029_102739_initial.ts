import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`users_feature_access\` (
  	\`order\` integer NOT NULL,
  	\`parent_id\` integer NOT NULL,
  	\`value\` text,
  	\`id\` integer PRIMARY KEY NOT NULL,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`users_feature_access_order_idx\` ON \`users_feature_access\` (\`order\`);`)
  await db.run(sql`CREATE INDEX \`users_feature_access_parent_idx\` ON \`users_feature_access\` (\`parent_id\`);`)
  await db.run(sql`CREATE TABLE \`users_sessions\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` text PRIMARY KEY NOT NULL,
  	\`created_at\` text,
  	\`expires_at\` text NOT NULL,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`users_sessions_order_idx\` ON \`users_sessions\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`users_sessions_parent_id_idx\` ON \`users_sessions\` (\`_parent_id\`);`)
  await db.run(sql`CREATE TABLE \`users\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`name\` text NOT NULL,
  	\`role\` text DEFAULT 'user' NOT NULL,
  	\`gmail_connected\` integer DEFAULT false,
  	\`gmail_email\` text,
  	\`gmail_access_token\` text,
  	\`gmail_refresh_token\` text,
  	\`gmail_token_expiry\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`email\` text NOT NULL,
  	\`reset_password_token\` text,
  	\`reset_password_expiration\` text,
  	\`salt\` text,
  	\`hash\` text,
  	\`reset_password_requested_at\` text,
  	\`login_attempts\` numeric DEFAULT 0,
  	\`lock_until\` text
  );
  `)
  await db.run(sql`CREATE INDEX \`users_updated_at_idx\` ON \`users\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`users_created_at_idx\` ON \`users\` (\`created_at\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`users_email_idx\` ON \`users\` (\`email\`);`)
  await db.run(sql`CREATE TABLE \`clients_additional_contacts\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` text PRIMARY KEY NOT NULL,
  	\`name\` text NOT NULL,
  	\`email\` text,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`clients\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`clients_additional_contacts_order_idx\` ON \`clients_additional_contacts\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`clients_additional_contacts_parent_id_idx\` ON \`clients_additional_contacts\` (\`_parent_id\`);`)
  await db.run(sql`CREATE TABLE \`clients\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`name\` text NOT NULL,
  	\`website_url\` text,
  	\`contact_email\` text,
  	\`is_active\` integer DEFAULT true,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`clients_updated_at_idx\` ON \`clients\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`clients_created_at_idx\` ON \`clients\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`client_emails\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`gmail_message_id\` text NOT NULL,
  	\`gmail_thread_id\` text NOT NULL,
  	\`client_id\` integer NOT NULL,
  	\`owner_id\` integer,
  	\`direction\` text DEFAULT 'inbound',
  	\`matched_by\` text DEFAULT 'auto',
  	\`matched_on\` text,
  	\`from\` text,
  	\`to\` text,
  	\`cc\` text,
  	\`subject\` text,
  	\`date\` text,
  	\`body\` text,
  	\`gmail_link\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`client_id\`) REFERENCES \`clients\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`owner_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`client_emails_gmail_message_id_idx\` ON \`client_emails\` (\`gmail_message_id\`);`)
  await db.run(sql`CREATE INDEX \`client_emails_gmail_thread_id_idx\` ON \`client_emails\` (\`gmail_thread_id\`);`)
  await db.run(sql`CREATE INDEX \`client_emails_client_idx\` ON \`client_emails\` (\`client_id\`);`)
  await db.run(sql`CREATE INDEX \`client_emails_owner_idx\` ON \`client_emails\` (\`owner_id\`);`)
  await db.run(sql`CREATE INDEX \`client_emails_date_idx\` ON \`client_emails\` (\`date\`);`)
  await db.run(sql`CREATE INDEX \`client_emails_updated_at_idx\` ON \`client_emails\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`client_emails_created_at_idx\` ON \`client_emails\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`client_email_summaries\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`client_id\` integer NOT NULL,
  	\`email_id\` integer NOT NULL,
  	\`owner_id\` integer,
  	\`summary\` text NOT NULL,
  	\`email_date\` text,
  	\`model\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`client_id\`) REFERENCES \`clients\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`email_id\`) REFERENCES \`client_emails\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`owner_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`client_email_summaries_client_idx\` ON \`client_email_summaries\` (\`client_id\`);`)
  await db.run(sql`CREATE INDEX \`client_email_summaries_email_idx\` ON \`client_email_summaries\` (\`email_id\`);`)
  await db.run(sql`CREATE INDEX \`client_email_summaries_owner_idx\` ON \`client_email_summaries\` (\`owner_id\`);`)
  await db.run(sql`CREATE INDEX \`client_email_summaries_email_date_idx\` ON \`client_email_summaries\` (\`email_date\`);`)
  await db.run(sql`CREATE INDEX \`client_email_summaries_updated_at_idx\` ON \`client_email_summaries\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`client_email_summaries_created_at_idx\` ON \`client_email_summaries\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`client_email_briefs\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`client_id\` integer NOT NULL,
  	\`owner_id\` integer,
  	\`account\` text,
  	\`brief\` text,
  	\`email_count\` numeric DEFAULT 0,
  	\`first_email_date\` text,
  	\`last_email_date\` text,
  	\`last_pulled_at\` text,
  	\`model\` text,
  	\`filter_key\` text,
  	\`message_ids\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`client_id\`) REFERENCES \`clients\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`owner_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`client_email_briefs_client_idx\` ON \`client_email_briefs\` (\`client_id\`);`)
  await db.run(sql`CREATE INDEX \`client_email_briefs_owner_idx\` ON \`client_email_briefs\` (\`owner_id\`);`)
  await db.run(sql`CREATE INDEX \`client_email_briefs_account_idx\` ON \`client_email_briefs\` (\`account\`);`)
  await db.run(sql`CREATE INDEX \`client_email_briefs_last_pulled_at_idx\` ON \`client_email_briefs\` (\`last_pulled_at\`);`)
  await db.run(sql`CREATE INDEX \`client_email_briefs_updated_at_idx\` ON \`client_email_briefs\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`client_email_briefs_created_at_idx\` ON \`client_email_briefs\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`client_email_pull_settings\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`client_id\` integer NOT NULL,
  	\`use_client_contacts\` integer DEFAULT true,
  	\`senders\` text,
  	\`keywords\` text,
  	\`match_mode\` text DEFAULT 'any',
  	\`updated_by_id\` integer,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`client_id\`) REFERENCES \`clients\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`updated_by_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`client_email_pull_settings_client_idx\` ON \`client_email_pull_settings\` (\`client_id\`);`)
  await db.run(sql`CREATE INDEX \`client_email_pull_settings_updated_by_idx\` ON \`client_email_pull_settings\` (\`updated_by_id\`);`)
  await db.run(sql`CREATE INDEX \`client_email_pull_settings_updated_at_idx\` ON \`client_email_pull_settings\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`client_email_pull_settings_created_at_idx\` ON \`client_email_pull_settings\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`mail_ai_requests\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`user_id\` integer,
  	\`action\` text NOT NULL,
  	\`gmail_message_id\` text,
  	\`client_id\` integer,
  	\`email_count\` numeric NOT NULL,
  	\`model\` text,
  	\`status\` text DEFAULT 'ok',
  	\`error\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`client_id\`) REFERENCES \`clients\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`mail_ai_requests_user_idx\` ON \`mail_ai_requests\` (\`user_id\`);`)
  await db.run(sql`CREATE INDEX \`mail_ai_requests_gmail_message_id_idx\` ON \`mail_ai_requests\` (\`gmail_message_id\`);`)
  await db.run(sql`CREATE INDEX \`mail_ai_requests_client_idx\` ON \`mail_ai_requests\` (\`client_id\`);`)
  await db.run(sql`CREATE INDEX \`mail_ai_requests_updated_at_idx\` ON \`mail_ai_requests\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`mail_ai_requests_created_at_idx\` ON \`mail_ai_requests\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`mail_sync_states\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`user_id\` integer NOT NULL,
  	\`gmail_address\` text,
  	\`history_id\` text,
  	\`last_sync_at\` text,
  	\`last_error\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`mail_sync_states_user_idx\` ON \`mail_sync_states\` (\`user_id\`);`)
  await db.run(sql`CREATE INDEX \`mail_sync_states_updated_at_idx\` ON \`mail_sync_states\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`mail_sync_states_created_at_idx\` ON \`mail_sync_states\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`mail_accounts\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`owner_id\` integer NOT NULL,
  	\`email\` text NOT NULL,
  	\`access_token\` text,
  	\`refresh_token\` text,
  	\`token_expiry\` text,
  	\`history_id\` text,
  	\`last_sync_at\` text,
  	\`last_error\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`owner_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`mail_accounts_owner_idx\` ON \`mail_accounts\` (\`owner_id\`);`)
  await db.run(sql`CREATE INDEX \`mail_accounts_email_idx\` ON \`mail_accounts\` (\`email\`);`)
  await db.run(sql`CREATE INDEX \`mail_accounts_updated_at_idx\` ON \`mail_accounts\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`mail_accounts_created_at_idx\` ON \`mail_accounts\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`scheduled_emails\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`owner_id\` integer NOT NULL,
  	\`status\` text DEFAULT 'pending' NOT NULL,
  	\`scheduled_for\` text NOT NULL,
  	\`to\` text,
  	\`cc\` text,
  	\`subject\` text,
  	\`reply_to_message_id\` text,
  	\`content\` text,
  	\`attempts\` numeric DEFAULT 0,
  	\`last_error\` text,
  	\`sent_at\` text,
  	\`sent_message_id\` text,
  	\`account\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`owner_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`scheduled_emails_owner_idx\` ON \`scheduled_emails\` (\`owner_id\`);`)
  await db.run(sql`CREATE INDEX \`scheduled_emails_status_idx\` ON \`scheduled_emails\` (\`status\`);`)
  await db.run(sql`CREATE INDEX \`scheduled_emails_scheduled_for_idx\` ON \`scheduled_emails\` (\`scheduled_for\`);`)
  await db.run(sql`CREATE INDEX \`scheduled_emails_updated_at_idx\` ON \`scheduled_emails\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`scheduled_emails_created_at_idx\` ON \`scheduled_emails\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`mail_follow_ups\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`owner_id\` integer NOT NULL,
  	\`client_id\` integer,
  	\`gmail_thread_id\` text,
  	\`sent_message_id\` text,
  	\`to\` text,
  	\`subject\` text,
  	\`sent_at\` text,
  	\`remind_at\` text,
  	\`status\` text DEFAULT 'waiting',
  	\`notified_at\` text,
  	\`last_checked_at\` text,
  	\`account\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`owner_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`client_id\`) REFERENCES \`clients\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`mail_follow_ups_owner_idx\` ON \`mail_follow_ups\` (\`owner_id\`);`)
  await db.run(sql`CREATE INDEX \`mail_follow_ups_client_idx\` ON \`mail_follow_ups\` (\`client_id\`);`)
  await db.run(sql`CREATE INDEX \`mail_follow_ups_gmail_thread_id_idx\` ON \`mail_follow_ups\` (\`gmail_thread_id\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`mail_follow_ups_sent_message_id_idx\` ON \`mail_follow_ups\` (\`sent_message_id\`);`)
  await db.run(sql`CREATE INDEX \`mail_follow_ups_remind_at_idx\` ON \`mail_follow_ups\` (\`remind_at\`);`)
  await db.run(sql`CREATE INDEX \`mail_follow_ups_status_idx\` ON \`mail_follow_ups\` (\`status\`);`)
  await db.run(sql`CREATE INDEX \`mail_follow_ups_updated_at_idx\` ON \`mail_follow_ups\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`mail_follow_ups_created_at_idx\` ON \`mail_follow_ups\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`notifications\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`recipient_id\` integer NOT NULL,
  	\`kind\` text NOT NULL,
  	\`title\` text NOT NULL,
  	\`body\` text,
  	\`url\` text,
  	\`related_client_id\` integer,
  	\`read_at\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	FOREIGN KEY (\`recipient_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null,
  	FOREIGN KEY (\`related_client_id\`) REFERENCES \`clients\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`notifications_recipient_idx\` ON \`notifications\` (\`recipient_id\`);`)
  await db.run(sql`CREATE INDEX \`notifications_related_client_idx\` ON \`notifications\` (\`related_client_id\`);`)
  await db.run(sql`CREATE INDEX \`notifications_updated_at_idx\` ON \`notifications\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`notifications_created_at_idx\` ON \`notifications\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`ai_credentials\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`provider\` text NOT NULL,
  	\`kind\` text NOT NULL,
  	\`data\` text NOT NULL,
  	\`force_fallback\` integer DEFAULT false,
  	\`last_refreshed_at\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`ai_credentials_provider_idx\` ON \`ai_credentials\` (\`provider\`);`)
  await db.run(sql`CREATE INDEX \`ai_credentials_updated_at_idx\` ON \`ai_credentials\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`ai_credentials_created_at_idx\` ON \`ai_credentials\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`ai_auth_events\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`provider\` text NOT NULL,
  	\`kind\` text NOT NULL,
  	\`message\` text,
  	\`agent_name\` text,
  	\`model_attempted\` text,
  	\`model_served\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`ai_auth_events_provider_idx\` ON \`ai_auth_events\` (\`provider\`);`)
  await db.run(sql`CREATE INDEX \`ai_auth_events_kind_idx\` ON \`ai_auth_events\` (\`kind\`);`)
  await db.run(sql`CREATE INDEX \`ai_auth_events_updated_at_idx\` ON \`ai_auth_events\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`ai_auth_events_created_at_idx\` ON \`ai_auth_events\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`payload_kv\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`key\` text NOT NULL,
  	\`data\` text NOT NULL
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`payload_kv_key_idx\` ON \`payload_kv\` (\`key\`);`)
  await db.run(sql`CREATE TABLE \`payload_locked_documents\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`global_slug\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_global_slug_idx\` ON \`payload_locked_documents\` (\`global_slug\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_updated_at_idx\` ON \`payload_locked_documents\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_created_at_idx\` ON \`payload_locked_documents\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`payload_locked_documents_rels\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`order\` integer,
  	\`parent_id\` integer NOT NULL,
  	\`path\` text NOT NULL,
  	\`clients_id\` integer,
  	\`notifications_id\` integer,
  	\`users_id\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`payload_locked_documents\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`clients_id\`) REFERENCES \`clients\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`notifications_id\`) REFERENCES \`notifications\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`users_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_order_idx\` ON \`payload_locked_documents_rels\` (\`order\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_parent_idx\` ON \`payload_locked_documents_rels\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_path_idx\` ON \`payload_locked_documents_rels\` (\`path\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_clients_id_idx\` ON \`payload_locked_documents_rels\` (\`clients_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_notifications_id_idx\` ON \`payload_locked_documents_rels\` (\`notifications_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_users_id_idx\` ON \`payload_locked_documents_rels\` (\`users_id\`);`)
  await db.run(sql`CREATE TABLE \`payload_preferences\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`key\` text,
  	\`value\` text,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`payload_preferences_key_idx\` ON \`payload_preferences\` (\`key\`);`)
  await db.run(sql`CREATE INDEX \`payload_preferences_updated_at_idx\` ON \`payload_preferences\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`payload_preferences_created_at_idx\` ON \`payload_preferences\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`payload_preferences_rels\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`order\` integer,
  	\`parent_id\` integer NOT NULL,
  	\`path\` text NOT NULL,
  	\`users_id\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`payload_preferences\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`users_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`payload_preferences_rels_order_idx\` ON \`payload_preferences_rels\` (\`order\`);`)
  await db.run(sql`CREATE INDEX \`payload_preferences_rels_parent_idx\` ON \`payload_preferences_rels\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_preferences_rels_path_idx\` ON \`payload_preferences_rels\` (\`path\`);`)
  await db.run(sql`CREATE INDEX \`payload_preferences_rels_users_id_idx\` ON \`payload_preferences_rels\` (\`users_id\`);`)
  await db.run(sql`CREATE TABLE \`payload_migrations\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`name\` text,
  	\`batch\` numeric,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`payload_migrations_updated_at_idx\` ON \`payload_migrations\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`payload_migrations_created_at_idx\` ON \`payload_migrations\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`mail_settings\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`email_assistant_model\` text,
  	\`writing_style\` text,
  	\`voice_api_key_enabled\` integer,
  	\`updated_at\` text,
  	\`created_at\` text
  );
  `)
  await db.run(sql`CREATE TABLE \`calendar_auth\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`refresh_token\` text,
  	\`connected_email\` text,
  	\`connected_at\` text,
  	\`updated_at\` text,
  	\`created_at\` text
  );
  `)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE \`users_feature_access\`;`)
  await db.run(sql`DROP TABLE \`users_sessions\`;`)
  await db.run(sql`DROP TABLE \`users\`;`)
  await db.run(sql`DROP TABLE \`clients_additional_contacts\`;`)
  await db.run(sql`DROP TABLE \`clients\`;`)
  await db.run(sql`DROP TABLE \`client_emails\`;`)
  await db.run(sql`DROP TABLE \`client_email_summaries\`;`)
  await db.run(sql`DROP TABLE \`client_email_briefs\`;`)
  await db.run(sql`DROP TABLE \`client_email_pull_settings\`;`)
  await db.run(sql`DROP TABLE \`mail_ai_requests\`;`)
  await db.run(sql`DROP TABLE \`mail_sync_states\`;`)
  await db.run(sql`DROP TABLE \`mail_accounts\`;`)
  await db.run(sql`DROP TABLE \`scheduled_emails\`;`)
  await db.run(sql`DROP TABLE \`mail_follow_ups\`;`)
  await db.run(sql`DROP TABLE \`notifications\`;`)
  await db.run(sql`DROP TABLE \`ai_credentials\`;`)
  await db.run(sql`DROP TABLE \`ai_auth_events\`;`)
  await db.run(sql`DROP TABLE \`payload_kv\`;`)
  await db.run(sql`DROP TABLE \`payload_locked_documents\`;`)
  await db.run(sql`DROP TABLE \`payload_locked_documents_rels\`;`)
  await db.run(sql`DROP TABLE \`payload_preferences\`;`)
  await db.run(sql`DROP TABLE \`payload_preferences_rels\`;`)
  await db.run(sql`DROP TABLE \`payload_migrations\`;`)
  await db.run(sql`DROP TABLE \`mail_settings\`;`)
  await db.run(sql`DROP TABLE \`calendar_auth\`;`)
}
