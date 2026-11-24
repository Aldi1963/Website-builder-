-- +goose Up
-- 00001: skema awal — replika persis hasil GORM AutoMigrate atas
-- server/internal/database/models/models.go (33 tabel).
-- Dibangkitkan dari pg_dump skema referensi AutoMigrate lalu diverifikasi
-- dengan diff pg_dump (lihat docs/database.md). Sengaja TANPA foreign key,
-- mengikuti AutoMigrate: model tidak mendeklarasikan FK.
-- Perhatian: nama kolom aneh (seoog_image, s_eofavicon, git_hub_configs)
-- adalah hasil penamaan GORM dan dipertahankan apa adanya.

CREATE TABLE agent_contexts (
    id BIGSERIAL PRIMARY KEY,
    project_id bigint NOT NULL,
    intent character varying(30),
    active_feature character varying(255),
    target_page character varying(255),
    target_files text,
    last_plan text,
    pending_question text,
    last_error text,
    updated_at timestamp with time zone
);

CREATE TABLE agent_runs (
    id BIGSERIAL PRIMARY KEY,
    project_id bigint NOT NULL,
    user_id bigint NOT NULL,
    mode character varying(30) NOT NULL,
    status character varying(20) NOT NULL,
    phase character varying(40),
    request text,
    summary text,
    error text,
    attempt bigint DEFAULT 0,
    current_output text,
    intent character varying(30),
    assumptions text,
    changed_files text,
    checks text,
    next_steps text,
    error_code character varying(60),
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone
);

CREATE TABLE agent_tool_calls (
    id BIGSERIAL PRIMARY KEY,
    run_id bigint NOT NULL,
    tool character varying(60) NOT NULL,
    phase character varying(40),
    status character varying(20) NOT NULL,
    input text,
    output text,
    error text,
    created_at timestamp with time zone
);

CREATE TABLE ai_configs (
    id BIGSERIAL PRIMARY KEY,
    base_url character varying(500),
    api_key character varying(500),
    model character varying(100)
);

CREATE TABLE ai_proposals (
    id BIGSERIAL PRIMARY KEY,
    project_id bigint NOT NULL,
    files text,
    created_at timestamp with time zone
);

CREATE TABLE ai_usages (
    id BIGSERIAL PRIMARY KEY,
    user_id bigint NOT NULL,
    tokens bigint,
    model character varying(100),
    created_at timestamp with time zone
);

CREATE TABLE app_cron_jobs (
    id BIGSERIAL PRIMARY KEY,
    project_id bigint NOT NULL,
    name character varying(255) NOT NULL,
    schedule character varying(100) NOT NULL,
    url character varying(1000) NOT NULL,
    method character varying(10) DEFAULT 'GET'::character varying,
    active boolean DEFAULT true,
    last_run_at timestamp with time zone,
    created_at timestamp with time zone
);

CREATE TABLE app_files (
    id BIGSERIAL PRIMARY KEY,
    project_id bigint NOT NULL,
    name character varying(255) NOT NULL,
    path character varying(500),
    size bigint,
    created_at timestamp with time zone
);

CREATE TABLE audit_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id bigint,
    action character varying(100),
    detail character varying(500),
    ip character varying(50),
    created_at timestamp with time zone
);

CREATE TABLE blocked_words (
    id BIGSERIAL PRIMARY KEY,
    word character varying(100)
);

CREATE TABLE chat_messages (
    id BIGSERIAL PRIMARY KEY,
    session_id bigint NOT NULL,
    role character varying(20) NOT NULL,
    content text,
    created_at timestamp with time zone
);

CREATE TABLE chat_sessions (
    id BIGSERIAL PRIMARY KEY,
    project_id bigint NOT NULL,
    title character varying(255),
    created_at timestamp with time zone
);

CREATE TABLE deployments (
    id BIGSERIAL PRIMARY KEY,
    project_id bigint NOT NULL,
    user_id bigint NOT NULL,
    status character varying(20) DEFAULT 'ready'::character varying,
    url character varying(255),
    files text,
    created_at timestamp with time zone
);

CREATE TABLE domains (
    id BIGSERIAL PRIMARY KEY,
    project_id bigint,
    user_id bigint NOT NULL,
    domain character varying(255) NOT NULL,
    verified boolean DEFAULT false,
    created_at timestamp with time zone
);

CREATE TABLE file_comments (
    id BIGSERIAL PRIMARY KEY,
    project_id bigint NOT NULL,
    file_path character varying(255),
    line bigint DEFAULT 0,
    user_id bigint,
    user_name character varying(100),
    body text,
    resolved boolean DEFAULT false,
    created_at timestamp with time zone
);

CREATE TABLE form_submissions (
    id BIGSERIAL PRIMARY KEY,
    project_id bigint NOT NULL,
    data text,
    ip character varying(50),
    created_at timestamp with time zone
);

CREATE TABLE git_hub_configs (
    id BIGSERIAL PRIMARY KEY,
    user_id bigint NOT NULL,
    token character varying(500),
    repo character varying(255)
);

CREATE TABLE notifications (
    id BIGSERIAL PRIMARY KEY,
    user_id bigint NOT NULL,
    title character varying(255),
    body character varying(500),
    read boolean DEFAULT false,
    created_at timestamp with time zone
);

CREATE TABLE password_resets (
    id BIGSERIAL PRIMARY KEY,
    user_id bigint NOT NULL,
    token character varying(64),
    expires_at timestamp with time zone,
    used boolean DEFAULT false
);

CREATE TABLE payments (
    id BIGSERIAL PRIMARY KEY,
    user_id bigint NOT NULL,
    order_id character varying(100),
    plan character varying(20),
    amount bigint,
    status character varying(20) DEFAULT 'pending'::character varying,
    pay_url character varying(500),
    created_at timestamp with time zone
);

CREATE TABLE platform_settings (
    key character varying(100) NOT NULL,
    value text
);

CREATE TABLE project_envs (
    id BIGSERIAL PRIMARY KEY,
    project_id bigint NOT NULL,
    key character varying(100) NOT NULL,
    value text
);

CREATE TABLE project_members (
    id BIGSERIAL PRIMARY KEY,
    project_id bigint NOT NULL,
    user_id bigint NOT NULL,
    role character varying(20) DEFAULT 'viewer'::character varying,
    created_at timestamp with time zone
);

CREATE TABLE project_migrations (
    id BIGSERIAL PRIMARY KEY,
    project_id bigint NOT NULL,
    name character varying(255),
    up_sql text,
    down_sql text,
    status character varying(30),
    error text,
    applied_at timestamp with time zone,
    rolled_back_at timestamp with time zone,
    created_at timestamp with time zone
);

CREATE TABLE project_versions (
    id BIGSERIAL PRIMARY KEY,
    project_id bigint NOT NULL,
    label character varying(255),
    files text,
    created_at timestamp with time zone
);

CREATE TABLE project_webhooks (
    id BIGSERIAL PRIMARY KEY,
    project_id bigint NOT NULL,
    url character varying(500),
    events character varying(255) DEFAULT 'deploy'::character varying,
    secret character varying(64),
    created_at timestamp with time zone
);

CREATE TABLE projects (
    id BIGSERIAL PRIMARY KEY,
    user_id bigint NOT NULL,
    name character varying(255) NOT NULL,
    slug character varying(100) NOT NULL,
    framework character varying(20) DEFAULT 'react'::character varying,
    files text DEFAULT '{}'::text,
    published boolean DEFAULT false,
    publish_state character varying(20) DEFAULT 'draft'::character varying,
    build_status character varying(20) DEFAULT 'unknown'::character varying,
    build_error text DEFAULT ''::text,
    built_at timestamp with time zone,
    published_at timestamp with time zone,
    memory text DEFAULT ''::text,
    blueprint text DEFAULT ''::text,
    share_token character varying(64) DEFAULT ''::character varying,
    site_password character varying(255) DEFAULT ''::character varying,
    seo_title character varying(255) DEFAULT ''::character varying,
    seo_desc character varying(500) DEFAULT ''::character varying,
    seoog_image character varying(500) DEFAULT ''::character varying,
    s_eofavicon character varying(500) DEFAULT ''::character varying,
    form_token character varying(64) DEFAULT ''::character varying,
    form_enabled boolean DEFAULT true,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);

CREATE TABLE subscriptions (
    id BIGSERIAL PRIMARY KEY,
    user_id bigint NOT NULL,
    plan character varying(20) DEFAULT 'free'::character varying,
    status character varying(20) DEFAULT 'active'::character varying,
    expires_at timestamp with time zone,
    created_at timestamp with time zone
);

CREATE TABLE templates (
    id BIGSERIAL PRIMARY KEY,
    owner_id bigint,
    name character varying(255) NOT NULL,
    description text,
    category character varying(50),
    framework character varying(20) DEFAULT 'react'::character varying,
    files text,
    uses bigint DEFAULT 0,
    featured boolean DEFAULT false,
    created_at timestamp with time zone
);

CREATE TABLE user_api_keys (
    id BIGSERIAL PRIMARY KEY,
    user_id bigint NOT NULL,
    name character varying(100),
    key_hash character varying(64),
    prefix character varying(12),
    last_used timestamp with time zone,
    created_at timestamp with time zone
);

CREATE TABLE user_totps (
    user_id BIGSERIAL PRIMARY KEY,
    secret character varying(100),
    enabled boolean DEFAULT false,
    created_at timestamp with time zone
);

CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    name character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    password character varying(255),
    avatar character varying(500) DEFAULT ''::character varying,
    is_admin boolean DEFAULT false,
    suspended boolean DEFAULT false,
    referral_code character varying(20),
    referred_by_id bigint,
    created_at timestamp with time zone
);

CREATE TABLE visit_stats (
    id BIGSERIAL PRIMARY KEY,
    project_id bigint NOT NULL,
    date character varying(10),
    count bigint DEFAULT 0
);

ALTER TABLE platform_settings ADD CONSTRAINT platform_settings_pkey PRIMARY KEY (key);

CREATE UNIQUE INDEX idx_agent_contexts_project_id ON agent_contexts (project_id);
CREATE INDEX idx_agent_runs_project_id ON agent_runs (project_id);
CREATE INDEX idx_agent_runs_status ON agent_runs (status);
CREATE INDEX idx_agent_runs_user_id ON agent_runs (user_id);
CREATE INDEX idx_agent_tool_calls_run_id ON agent_tool_calls (run_id);
CREATE INDEX idx_ai_proposals_project_id ON ai_proposals (project_id);
CREATE INDEX idx_ai_usages_user_id ON ai_usages (user_id);
CREATE INDEX idx_app_cron_jobs_project_id ON app_cron_jobs (project_id);
CREATE INDEX idx_app_files_project_id ON app_files (project_id);
CREATE INDEX idx_audit_logs_user_id ON audit_logs (user_id);
CREATE UNIQUE INDEX idx_blocked_words_word ON blocked_words (word);
CREATE INDEX idx_chat_messages_session_id ON chat_messages (session_id);
CREATE INDEX idx_chat_sessions_project_id ON chat_sessions (project_id);
CREATE INDEX idx_deployments_project_id ON deployments (project_id);
CREATE INDEX idx_deployments_user_id ON deployments (user_id);
CREATE INDEX idx_domains_project_id ON domains (project_id);
CREATE INDEX idx_domains_user_id ON domains (user_id);
CREATE INDEX idx_file_comments_file_path ON file_comments (file_path);
CREATE INDEX idx_file_comments_project_id ON file_comments (project_id);
CREATE INDEX idx_file_comments_user_id ON file_comments (user_id);
CREATE INDEX idx_form_submissions_project_id ON form_submissions (project_id);
CREATE UNIQUE INDEX idx_git_hub_configs_user_id ON git_hub_configs (user_id);
CREATE INDEX idx_notifications_user_id ON notifications (user_id);
CREATE UNIQUE INDEX idx_password_resets_token ON password_resets (token);
CREATE INDEX idx_password_resets_user_id ON password_resets (user_id);
CREATE UNIQUE INDEX idx_payments_order_id ON payments (order_id);
CREATE INDEX idx_payments_user_id ON payments (user_id);
CREATE INDEX idx_project_envs_project_id ON project_envs (project_id);
CREATE INDEX idx_project_members_project_id ON project_members (project_id);
CREATE INDEX idx_project_members_user_id ON project_members (user_id);
CREATE INDEX idx_project_migrations_project_id ON project_migrations (project_id);
CREATE INDEX idx_project_versions_project_id ON project_versions (project_id);
CREATE INDEX idx_project_webhooks_project_id ON project_webhooks (project_id);
CREATE INDEX idx_projects_form_token ON projects (form_token);
CREATE UNIQUE INDEX idx_projects_slug ON projects (slug);
CREATE INDEX idx_projects_user_id ON projects (user_id);
CREATE UNIQUE INDEX idx_subscriptions_user_id ON subscriptions (user_id);
CREATE INDEX idx_templates_owner_id ON templates (owner_id);
CREATE UNIQUE INDEX idx_user_api_keys_key_hash ON user_api_keys (key_hash);
CREATE INDEX idx_user_api_keys_user_id ON user_api_keys (user_id);
CREATE UNIQUE INDEX idx_users_email ON users (email);
CREATE UNIQUE INDEX idx_users_referral_code ON users (referral_code);
CREATE INDEX idx_users_referred_by_id ON users (referred_by_id);
CREATE INDEX idx_visit_stats_date ON visit_stats (date);
CREATE INDEX idx_visit_stats_project_id ON visit_stats (project_id);

-- +goose Down
DROP TABLE IF EXISTS visit_stats CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS user_totps CASCADE;
DROP TABLE IF EXISTS user_api_keys CASCADE;
DROP TABLE IF EXISTS templates CASCADE;
DROP TABLE IF EXISTS subscriptions CASCADE;
DROP TABLE IF EXISTS projects CASCADE;
DROP TABLE IF EXISTS project_webhooks CASCADE;
DROP TABLE IF EXISTS project_versions CASCADE;
DROP TABLE IF EXISTS project_migrations CASCADE;
DROP TABLE IF EXISTS project_members CASCADE;
DROP TABLE IF EXISTS project_envs CASCADE;
DROP TABLE IF EXISTS platform_settings CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS password_resets CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS git_hub_configs CASCADE;
DROP TABLE IF EXISTS form_submissions CASCADE;
DROP TABLE IF EXISTS file_comments CASCADE;
DROP TABLE IF EXISTS domains CASCADE;
DROP TABLE IF EXISTS deployments CASCADE;
DROP TABLE IF EXISTS chat_sessions CASCADE;
DROP TABLE IF EXISTS chat_messages CASCADE;
DROP TABLE IF EXISTS blocked_words CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS app_files CASCADE;
DROP TABLE IF EXISTS app_cron_jobs CASCADE;
DROP TABLE IF EXISTS ai_usages CASCADE;
DROP TABLE IF EXISTS ai_proposals CASCADE;
DROP TABLE IF EXISTS ai_configs CASCADE;
DROP TABLE IF EXISTS agent_tool_calls CASCADE;
DROP TABLE IF EXISTS agent_runs CASCADE;
DROP TABLE IF EXISTS agent_contexts CASCADE;
