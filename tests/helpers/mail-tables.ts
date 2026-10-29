/**
 * The two tables Mail reads and writes with raw SQL (scheduled send and
 * follow-up reminders), for tests on an in-memory SQLite database. Same
 * columns as the Payload collections ScheduledEmails and MailFollowUps.
 */
const ts = "text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL";

export const SCHEDULED_EMAILS_TABLE: string[] = [
  `CREATE TABLE \`scheduled_emails\` (
    \`id\` integer PRIMARY KEY NOT NULL,
    \`owner_id\` integer NOT NULL,
    \`account\` text,
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
    \`updated_at\` ${ts},
    \`created_at\` ${ts},
    FOREIGN KEY (\`owner_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null
  )`,
];

export const MAIL_FOLLOW_UPS_TABLE: string[] = [
  `CREATE TABLE \`mail_follow_ups\` (
    \`id\` integer PRIMARY KEY NOT NULL,
    \`owner_id\` integer NOT NULL,
    \`account\` text,
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
    \`updated_at\` ${ts},
    \`created_at\` ${ts},
    FOREIGN KEY (\`owner_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE set null,
    FOREIGN KEY (\`client_id\`) REFERENCES \`clients\`(\`id\`) ON UPDATE no action ON DELETE set null
  )`,
  "CREATE UNIQUE INDEX `mail_follow_ups_sent_message_id_idx` ON `mail_follow_ups` (`sent_message_id`)",
];
