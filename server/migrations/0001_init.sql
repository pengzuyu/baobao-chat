-- 0001：终态基线（2026-11-16 squash，D28 会话拍板：无升级场景，收口为单 baseline）。
-- 由 dev 库（已应用 0001-0038 全链终态）pg_dump 导出整理，**替代原 0002-0038 全部增量**：
--   * 原 0011/0013/0019/0021/0026/0027/0033 七个迁移建的表已随瘦身二阶段被 0035 删除——
--     基线不含（doc/file_share/meeting/bot 全域）；
--   * 0009→0037_kb、0003→0023 等「建了再改列」一律落为终态定义；
--   * 运行时月分区 message_YYYY_MM 与 schema_migrations 不入基线（前者服务端按月自建，
--     后者迁移器自举）。
-- 执行通道：bbc-server 内嵌 Migrate（单通道权威；compose init 只做 pg 等待+扩展）。
-- 语义：仅面向全新库执行（无 IF NOT EXISTS；已存库由 schema_migrations 版本记录
-- 或 Probe=public.users 兜底跳过——见 internal/platform/pgxpool/migrate.go）。
-- 域速查：认证 users/role/user_role/user_dept/dept/tenant/device/refresh_token |
-- IM conversation(+member/apply/state)/message(+favorite/receipt)/group_setting/
--   sticker(+set)/sensitive_word | 通知 user_notification(+notify_pref)/admin_notice |
-- 文件 file/transfer_record | KB kb_*(两维度博客化终态,D24) | 邮件 mail_* |
-- AI ai_provider/ai_route_rule/ai_usage_hourly | Agent agent_session_backup/
--   agent_tool_policy | 生态 eco_app(+version/install)/eco_rollout/eco_skill(+install)/
--   eco_expert/eco_plugin(+version/install) | 管理审计 admin_audit_action |
-- ACL resource_acl | OIDC oidc_client/auth_request/grant/refresh_token/access_token/
--   web_session（D28 批次 Q1，0038 终态）

BEGIN;
--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_audit_action; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit_action (
    id bigint NOT NULL,
    tenant_id bigint DEFAULT 1 NOT NULL,
    operator_id bigint NOT NULL,
    action text NOT NULL,
    target text DEFAULT ''::text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_notice; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_notice (
    id bigint NOT NULL,
    tenant_id bigint DEFAULT 1 NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    created_by bigint NOT NULL,
    reach integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_session_backup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_session_backup (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    user_id bigint NOT NULL,
    local_session_id text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    enc_alg text NOT NULL,
    key_envelope text NOT NULL,
    size bigint NOT NULL,
    idempotency_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_tool_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_tool_policy (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    subject text NOT NULL,
    allowed boolean DEFAULT true NOT NULL,
    risk_override text DEFAULT '{}'::text NOT NULL,
    config text DEFAULT '{}'::text NOT NULL,
    updated_by bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_provider; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_provider (
    id bigint NOT NULL,
    tenant_id bigint,
    name text NOT NULL,
    kind text NOT NULL,
    endpoints jsonb DEFAULT '[]'::jsonb NOT NULL,
    api_key_ref text,
    health jsonb DEFAULT '{}'::jsonb NOT NULL,
    quota jsonb DEFAULT '{}'::jsonb NOT NULL,
    pricing jsonb DEFAULT '{}'::jsonb NOT NULL,
    status smallint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_user_id bigint,
    models jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT ai_provider_kind_check CHECK ((kind = ANY (ARRAY['openai_compatible'::text, 'vllm'::text, 'bge_embed'::text, 'bge_reranker'::text, 'mock'::text])))
);


--
-- Name: ai_route_rule; Type: TABLE; Schema: public; Owner: -
-- 2026-11-26 对话档位单档化：tier=对话默认档 default + 能力档 embed/rerank（原快/强双档退役；
-- 全新能力口径不做数据迁移——存量库需重建或手工改本约束）
--

CREATE TABLE public.ai_route_rule (
    id bigint NOT NULL,
    tenant_id bigint,
    version integer NOT NULL,
    tier text NOT NULL,
    candidates jsonb DEFAULT '[]'::jsonb NOT NULL,
    overrides jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    created_by bigint NOT NULL,
    approved_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_route_rule_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text]))),
    CONSTRAINT ai_route_rule_tier_check CHECK ((tier = ANY (ARRAY['default'::text, 'embed'::text, 'rerank'::text])))
);


--
-- Name: ai_usage_hourly; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_usage_hourly (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    hour_bucket timestamp with time zone NOT NULL,
    user_id bigint DEFAULT 0 NOT NULL,
    svc_subject text DEFAULT ''::text NOT NULL,
    session_id text DEFAULT ''::text NOT NULL,
    scene text NOT NULL,
    tier text NOT NULL,
    provider_id bigint NOT NULL,
    requests bigint DEFAULT 0 NOT NULL,
    prompt_tokens bigint DEFAULT 0 NOT NULL,
    completion_tokens bigint DEFAULT 0 NOT NULL,
    total_tokens bigint DEFAULT 0 NOT NULL,
    errors bigint DEFAULT 0 NOT NULL,
    degraded_count bigint DEFAULT 0 NOT NULL,
    est_cost numeric(14,6) DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: conversation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    type smallint NOT NULL,
    name text,
    avatar_file_id bigint,
    owner_id bigint,
    latest_seq bigint DEFAULT 0 NOT NULL,
    last_msg_digest jsonb,
    last_msg_ts timestamp with time zone,
    member_count integer DEFAULT 0 NOT NULL,
    status smallint DEFAULT 1 NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: conversation_apply; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_apply (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    conv_id bigint NOT NULL,
    user_id bigint NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    status smallint DEFAULT 1 NOT NULL,
    handled_by bigint,
    handled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: conversation_member; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_member (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    conv_id bigint NOT NULL,
    user_id bigint NOT NULL,
    role smallint DEFAULT 3 NOT NULL,
    join_at timestamp with time zone DEFAULT now() NOT NULL,
    join_by bigint,
    mute_until timestamp with time zone,
    status smallint DEFAULT 1 NOT NULL
);


--
-- Name: dept; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dept (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    parent_id bigint,
    name text NOT NULL,
    path text NOT NULL,
    sort integer DEFAULT 0 NOT NULL,
    status smallint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: device; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    user_id bigint NOT NULL,
    device_name text,
    os text,
    did text NOT NULL,
    last_active_at timestamp with time zone,
    trusted boolean DEFAULT false NOT NULL
);


--
-- Name: eco_app; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eco_app (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    app_id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    current_version text DEFAULT ''::text NOT NULL,
    created_by bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: eco_app_install; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eco_app_install (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    app_row_id bigint NOT NULL,
    user_id bigint NOT NULL,
    version text NOT NULL,
    installed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: eco_app_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eco_app_version (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    app_row_id bigint NOT NULL,
    version text NOT NULL,
    manifest text NOT NULL,
    high_risk boolean DEFAULT false NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    published_by bigint DEFAULT 0 NOT NULL,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: eco_expert; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eco_expert (
    id bigint NOT NULL,
    tenant_id bigint DEFAULT 1 NOT NULL,
    expert_id text NOT NULL,
    version text DEFAULT '1.0.0'::text NOT NULL,
    display text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    source smallint DEFAULT 2 NOT NULL,
    owner_user_id bigint DEFAULT 0 NOT NULL,
    manifest text NOT NULL,
    status smallint DEFAULT 1 NOT NULL,
    created_by bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: eco_plugin; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eco_plugin (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    plugin_id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    category text DEFAULT ''::text NOT NULL,
    policy smallint DEFAULT 3 NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    current_version text DEFAULT ''::text NOT NULL,
    manifest text DEFAULT ''::text NOT NULL,
    created_by bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_user_id bigint DEFAULT 0 NOT NULL
);


--
-- Name: eco_plugin_install; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eco_plugin_install (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    pkg_id bigint NOT NULL,
    user_id bigint NOT NULL,
    version text NOT NULL,
    installed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: eco_plugin_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eco_plugin_version (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    pkg_id bigint NOT NULL,
    version text NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    manifest text DEFAULT ''::text NOT NULL,
    package bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: eco_rollout; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eco_rollout (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    app_row_id bigint NOT NULL,
    version_row_id bigint NOT NULL,
    canary_pct smallint DEFAULT 100 NOT NULL,
    whitelist text DEFAULT '[]'::text NOT NULL,
    updated_by bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT eco_rollout_canary_pct_check CHECK (((canary_pct >= 0) AND (canary_pct <= 100)))
);


--
-- Name: eco_skill; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eco_skill (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    skill_id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    policy smallint DEFAULT 2 NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    current_version text DEFAULT ''::text NOT NULL,
    manifest text NOT NULL,
    created_by bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: eco_skill_install; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eco_skill_install (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    skill_row_id bigint NOT NULL,
    user_id bigint NOT NULL,
    version text NOT NULL,
    installed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: file; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    owner_id bigint NOT NULL,
    name text NOT NULL,
    ext text DEFAULT ''::text NOT NULL,
    size bigint NOT NULL,
    content_type text DEFAULT 'application/octet-stream'::text NOT NULL,
    sha256 text NOT NULL,
    width integer DEFAULT 0 NOT NULL,
    height integer DEFAULT 0 NOT NULL,
    source text DEFAULT 'upload'::text NOT NULL,
    conv_id bigint,
    scan_status smallint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    msg_seq bigint DEFAULT 0 NOT NULL,
    recalled boolean DEFAULT false NOT NULL
);


--
-- Name: group_setting; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_setting (
    conv_id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    join_mode smallint DEFAULT 1 NOT NULL,
    invite_policy smallint DEFAULT 1 NOT NULL,
    mention_all_policy smallint DEFAULT 2 NOT NULL,
    mute_all_until timestamp with time zone,
    history_visible boolean DEFAULT true NOT NULL,
    announcement text,
    announcement_ts timestamp with time zone
);


--
-- Name: kb_chunk; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kb_chunk (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    doc_id bigint NOT NULL,
    space_id bigint NOT NULL,
    seq integer NOT NULL,
    heading_path text,
    text text NOT NULL,
    token_count integer DEFAULT 0 NOT NULL,
    embedding public.vector(1024),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    embed_epoch integer DEFAULT 1 NOT NULL
);


--
-- Name: kb_doc; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kb_doc (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    space_id bigint NOT NULL,
    node_id bigint,
    title text NOT NULL,
    source_type text NOT NULL,
    source_ref text,
    ext text DEFAULT ''::text NOT NULL,
    size bigint DEFAULT 0 NOT NULL,
    status text NOT NULL,
    error_msg text,
    version integer DEFAULT 1 NOT NULL,
    content text,
    created_by bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    view_count bigint DEFAULT 0 NOT NULL
);


--
-- Name: kb_doc_view; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kb_doc_view (
    tenant_id bigint NOT NULL,
    doc_id bigint NOT NULL,
    user_id bigint NOT NULL,
    view_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: kb_node; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kb_node (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    space_id bigint NOT NULL,
    parent_id bigint,
    node_type text DEFAULT 'dir'::text NOT NULL,
    name text NOT NULL,
    path text DEFAULT ''::text NOT NULL,
    sort integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: kb_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kb_settings (
    tenant_id bigint NOT NULL,
    embed_epoch integer DEFAULT 1 NOT NULL,
    embed_model text DEFAULT ''::text NOT NULL,
    embed_dims integer DEFAULT 1024 NOT NULL,
    rebuild_status text DEFAULT 'idle'::text NOT NULL,
    rebuild_done integer DEFAULT 0 NOT NULL,
    rebuild_total integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: kb_space; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kb_space (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    space_type text NOT NULL,
    name text NOT NULL,
    owner_id bigint NOT NULL,
    dept_id bigint,
    quota_bytes bigint DEFAULT '5368709120'::bigint NOT NULL,
    used_bytes bigint DEFAULT 0 NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mail_alias; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mail_alias (
    id bigint NOT NULL,
    tenant_id bigint DEFAULT 1 NOT NULL,
    alias_address text NOT NULL,
    kind smallint DEFAULT 1 NOT NULL,
    target_mailbox_id bigint,
    members jsonb DEFAULT '[]'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_by bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mail_app_password; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mail_app_password (
    id bigint NOT NULL,
    tenant_id bigint DEFAULT 1 NOT NULL,
    user_id bigint NOT NULL,
    name text NOT NULL,
    hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone
);


--
-- Name: mail_domain; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mail_domain (
    id bigint NOT NULL,
    tenant_id bigint DEFAULT 1 NOT NULL,
    domain text NOT NULL,
    mode smallint DEFAULT 1 NOT NULL,
    dkim_key_ref text,
    dns_status jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mail_folder_meta; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mail_folder_meta (
    id bigint NOT NULL,
    tenant_id bigint DEFAULT 1 NOT NULL,
    mailbox_id bigint NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    uidvalidity bigint DEFAULT 1 NOT NULL,
    uid_next bigint DEFAULT 1 NOT NULL,
    sync_cursor text,
    total_count integer DEFAULT 0 NOT NULL,
    unread_count integer DEFAULT 0 NOT NULL
);


--
-- Name: mail_message; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mail_message (
    id bigint NOT NULL,
    tenant_id bigint DEFAULT 1 NOT NULL,
    mailbox_id bigint NOT NULL,
    folder_id bigint NOT NULL,
    message_id text NOT NULL,
    in_reply_to text,
    from_addr text NOT NULL,
    to_addrs jsonb DEFAULT '[]'::jsonb NOT NULL,
    cc_addrs jsonb DEFAULT '[]'::jsonb NOT NULL,
    bcc_addrs jsonb DEFAULT '[]'::jsonb NOT NULL,
    subject text DEFAULT ''::text NOT NULL,
    snippet text DEFAULT ''::text NOT NULL,
    body text,
    has_attachment boolean DEFAULT false NOT NULL,
    attachments jsonb DEFAULT '[]'::jsonb NOT NULL,
    flags smallint DEFAULT 0 NOT NULL,
    size bigint DEFAULT 0 NOT NULL,
    body_state smallint DEFAULT 2 NOT NULL,
    body_obj_key text,
    send_at timestamp with time zone,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    fts tsvector
);


--
-- Name: mail_rule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mail_rule (
    id bigint NOT NULL,
    tenant_id bigint DEFAULT 1 NOT NULL,
    user_id bigint NOT NULL,
    kind smallint DEFAULT 1 NOT NULL,
    conditions jsonb DEFAULT '{}'::jsonb NOT NULL,
    action smallint DEFAULT 1 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mailbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mailbox (
    id bigint NOT NULL,
    tenant_id bigint DEFAULT 1 NOT NULL,
    domain_id bigint NOT NULL,
    address text NOT NULL,
    type smallint DEFAULT 1 NOT NULL,
    owner_user_id bigint,
    govern_dept_id bigint,
    quota_bytes bigint DEFAULT '5368709120'::bigint NOT NULL,
    used_bytes bigint DEFAULT 0 NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    status smallint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    suspended_at timestamp with time zone
);


--
-- Name: message; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    conv_id bigint NOT NULL,
    seq bigint NOT NULL,
    client_msg_id text NOT NULL,
    sender_id bigint NOT NULL,
    type text NOT NULL,
    body jsonb,
    mentions jsonb,
    reply_to_seq bigint,
    ext jsonb,
    status smallint DEFAULT 1 NOT NULL,
    edited_at timestamp with time zone,
    edit_history jsonb,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    edit_version smallint DEFAULT 1 NOT NULL
)
PARTITION BY RANGE (created_at);


--
-- Name: message_default; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_default (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    conv_id bigint NOT NULL,
    seq bigint NOT NULL,
    client_msg_id text NOT NULL,
    sender_id bigint NOT NULL,
    type text NOT NULL,
    body jsonb,
    mentions jsonb,
    reply_to_seq bigint,
    ext jsonb,
    status smallint DEFAULT 1 NOT NULL,
    edited_at timestamp with time zone,
    edit_history jsonb,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    edit_version smallint DEFAULT 1 NOT NULL
);


--
-- Name: message_favorite; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_favorite (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    user_id bigint NOT NULL,
    msg_id bigint NOT NULL,
    conv_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: message_receipt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_receipt (
    conv_id bigint NOT NULL,
    user_id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    delivered_seq bigint DEFAULT 0 NOT NULL,
    read_seq bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: oidc_access_token; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oidc_access_token (
    id text NOT NULL,
    tenant_id bigint NOT NULL,
    user_id bigint NOT NULL,
    client_id text NOT NULL,
    scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
    audience jsonb DEFAULT '[]'::jsonb NOT NULL,
    amr jsonb DEFAULT '[]'::jsonb NOT NULL,
    auth_time timestamp with time zone,
    refresh_id bigint,
    expires_at timestamp with time zone NOT NULL,
    revoked boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: oidc_auth_request; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oidc_auth_request (
    id text NOT NULL,
    tenant_id bigint NOT NULL,
    client_id text NOT NULL,
    user_id bigint,
    did text DEFAULT ''::text NOT NULL,
    scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
    nonce text DEFAULT ''::text NOT NULL,
    state text DEFAULT ''::text NOT NULL,
    code_challenge text DEFAULT ''::text NOT NULL,
    code_challenge_m text DEFAULT ''::text NOT NULL,
    code_hash text,
    confirm_code text DEFAULT ''::text NOT NULL,
    snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    auth_time timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_at timestamp with time zone,
    consumed_at timestamp with time zone
);


--
-- Name: oidc_client; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oidc_client (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    client_id text NOT NULL,
    client_secret_hash text DEFAULT ''::text NOT NULL,
    name text NOT NULL,
    logo_file_id bigint,
    redirect_uris jsonb DEFAULT '[]'::jsonb NOT NULL,
    scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
    grant_types jsonb DEFAULT '["authorization_code", "refresh_token"]'::jsonb NOT NULL,
    access_ttl_sec integer DEFAULT 900 NOT NULL,
    refresh_ttl_sec integer DEFAULT 2592000 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: oidc_grant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oidc_grant (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    user_id bigint NOT NULL,
    client_id text NOT NULL,
    scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: oidc_refresh_token; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oidc_refresh_token (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    grant_id bigint,
    user_id bigint NOT NULL,
    client_id text NOT NULL,
    token_hash text NOT NULL,
    claims jsonb DEFAULT '{}'::jsonb NOT NULL,
    rotated_from bigint,
    status text DEFAULT 'active'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: oidc_web_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oidc_web_session (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    user_id bigint NOT NULL,
    did text DEFAULT ''::text NOT NULL,
    token_hash text NOT NULL,
    sliding_expires_at timestamp with time zone NOT NULL,
    user_agent text DEFAULT ''::text NOT NULL,
    ip text DEFAULT ''::text NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: refresh_token; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refresh_token (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    user_id bigint NOT NULL,
    device_id bigint NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    rotated_from bigint,
    status smallint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: resource_acl; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_acl (
    id bigint NOT NULL,
    tenant_id bigint DEFAULT 1 NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    grant_type smallint NOT NULL,
    grant_target bigint DEFAULT 0 NOT NULL,
    perm smallint NOT NULL,
    granted_by bigint DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    name text NOT NULL,
    description text,
    permissions jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_builtin boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sensitive_word; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensitive_word (
    id bigint NOT NULL,
    tenant_id bigint DEFAULT 1 NOT NULL,
    word text NOT NULL,
    mode smallint DEFAULT 1 NOT NULL,
    category text,
    enabled boolean DEFAULT true NOT NULL,
    created_by bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sensitive_word_mode_check CHECK ((mode = ANY (ARRAY[1, 2, 3])))
);


--
-- Name: sticker; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sticker (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    set_id bigint NOT NULL,
    file_id bigint NOT NULL,
    name text,
    sort integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sticker_set; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sticker_set (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    name text NOT NULL,
    cover_file_id bigint,
    owner_id bigint,
    status smallint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tenant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant (
    id bigint NOT NULL,
    name text NOT NULL,
    status smallint DEFAULT 1 NOT NULL,
    plan text DEFAULT 'free'::text NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: transfer_record; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transfer_record (
    id bigint NOT NULL,
    tenant_id bigint DEFAULT 1 NOT NULL,
    user_id bigint NOT NULL,
    file_id bigint,
    upload_id text,
    direction smallint NOT NULL,
    state text NOT NULL,
    bytes_transferred bigint DEFAULT 0 NOT NULL,
    total_bytes bigint DEFAULT 0 NOT NULL,
    error_code integer,
    target_path text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_conv_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_conv_state (
    user_id bigint NOT NULL,
    conv_id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    mute boolean DEFAULT false NOT NULL,
    draft text DEFAULT ''::text NOT NULL,
    read_seq bigint DEFAULT 0 NOT NULL,
    acked_seq bigint DEFAULT 0 NOT NULL,
    unread_badge integer DEFAULT 0 NOT NULL,
    hidden boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_dept; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_dept (
    user_id bigint NOT NULL,
    dept_id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    is_primary boolean DEFAULT false NOT NULL
);


--
-- Name: user_notification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_notification (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    user_id bigint NOT NULL,
    kind text NOT NULL,
    conv_id bigint,
    msg_id bigint,
    seq bigint,
    title text DEFAULT ''::text NOT NULL,
    digest text DEFAULT ''::text NOT NULL,
    count integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone
);


--
-- Name: user_notify_pref; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_notify_pref (
    user_id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    msg_notify boolean DEFAULT true NOT NULL,
    mention_notify boolean DEFAULT true NOT NULL,
    dnd_range text DEFAULT 'off'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_role (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    user_id bigint NOT NULL,
    role_id bigint NOT NULL,
    scope_type smallint DEFAULT 1 NOT NULL,
    scope_dept_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id bigint NOT NULL,
    tenant_id bigint NOT NULL,
    type smallint DEFAULT 1 NOT NULL,
    employee_no text NOT NULL,
    display_name text NOT NULL,
    avatar_file_id bigint,
    email text,
    phone text,
    password_hash text,
    status smallint DEFAULT 1 NOT NULL,
    mfa_secret_enc text,
    joined_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    must_change_password boolean DEFAULT false NOT NULL
);


--
-- Name: message_default; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message ATTACH PARTITION public.message_default DEFAULT;


--
-- Name: admin_audit_action admin_audit_action_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_action
    ADD CONSTRAINT admin_audit_action_pkey PRIMARY KEY (id);


--
-- Name: admin_notice admin_notice_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notice
    ADD CONSTRAINT admin_notice_pkey PRIMARY KEY (id);


--
-- Name: agent_session_backup agent_session_backup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_session_backup
    ADD CONSTRAINT agent_session_backup_pkey PRIMARY KEY (id);


--
-- Name: agent_tool_policy agent_tool_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_policy
    ADD CONSTRAINT agent_tool_policy_pkey PRIMARY KEY (id);


--
-- Name: ai_provider ai_provider_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_provider
    ADD CONSTRAINT ai_provider_pkey PRIMARY KEY (id);


--
-- Name: ai_route_rule ai_route_rule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_route_rule
    ADD CONSTRAINT ai_route_rule_pkey PRIMARY KEY (id);


--
-- Name: ai_usage_hourly ai_usage_hourly_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage_hourly
    ADD CONSTRAINT ai_usage_hourly_pkey PRIMARY KEY (id);


--
-- Name: conversation_apply conversation_apply_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_apply
    ADD CONSTRAINT conversation_apply_pkey PRIMARY KEY (id);


--
-- Name: conversation_member conversation_member_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_member
    ADD CONSTRAINT conversation_member_pkey PRIMARY KEY (id);


--
-- Name: conversation conversation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation
    ADD CONSTRAINT conversation_pkey PRIMARY KEY (id);


--
-- Name: dept dept_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dept
    ADD CONSTRAINT dept_pkey PRIMARY KEY (id);


--
-- Name: device device_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device
    ADD CONSTRAINT device_pkey PRIMARY KEY (id);


--
-- Name: eco_app_install eco_app_install_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eco_app_install
    ADD CONSTRAINT eco_app_install_pkey PRIMARY KEY (id);


--
-- Name: eco_app eco_app_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eco_app
    ADD CONSTRAINT eco_app_pkey PRIMARY KEY (id);


--
-- Name: eco_app_version eco_app_version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eco_app_version
    ADD CONSTRAINT eco_app_version_pkey PRIMARY KEY (id);


--
-- Name: eco_expert eco_expert_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eco_expert
    ADD CONSTRAINT eco_expert_pkey PRIMARY KEY (id);


--
-- Name: eco_plugin_install eco_plugin_install_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eco_plugin_install
    ADD CONSTRAINT eco_plugin_install_pkey PRIMARY KEY (id);


--
-- Name: eco_plugin eco_plugin_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eco_plugin
    ADD CONSTRAINT eco_plugin_pkey PRIMARY KEY (id);


--
-- Name: eco_plugin_version eco_plugin_version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eco_plugin_version
    ADD CONSTRAINT eco_plugin_version_pkey PRIMARY KEY (id);


--
-- Name: eco_rollout eco_rollout_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eco_rollout
    ADD CONSTRAINT eco_rollout_pkey PRIMARY KEY (id);


--
-- Name: eco_skill_install eco_skill_install_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eco_skill_install
    ADD CONSTRAINT eco_skill_install_pkey PRIMARY KEY (id);


--
-- Name: eco_skill eco_skill_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eco_skill
    ADD CONSTRAINT eco_skill_pkey PRIMARY KEY (id);


--
-- Name: file file_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file
    ADD CONSTRAINT file_pkey PRIMARY KEY (id);


--
-- Name: group_setting group_setting_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_setting
    ADD CONSTRAINT group_setting_pkey PRIMARY KEY (conv_id);


--
-- Name: kb_chunk kb_chunk_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_chunk
    ADD CONSTRAINT kb_chunk_pkey PRIMARY KEY (id);


--
-- Name: kb_chunk kb_chunk_tenant_id_doc_id_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_chunk
    ADD CONSTRAINT kb_chunk_tenant_id_doc_id_seq_key UNIQUE (tenant_id, doc_id, seq);


--
-- Name: kb_doc kb_doc_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_doc
    ADD CONSTRAINT kb_doc_pkey PRIMARY KEY (id);


--
-- Name: kb_doc_view kb_doc_view_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_doc_view
    ADD CONSTRAINT kb_doc_view_pkey PRIMARY KEY (doc_id, user_id, view_date);


--
-- Name: kb_node kb_node_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_node
    ADD CONSTRAINT kb_node_pkey PRIMARY KEY (id);


--
-- Name: kb_settings kb_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_settings
    ADD CONSTRAINT kb_settings_pkey PRIMARY KEY (tenant_id);


--
-- Name: kb_space kb_space_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_space
    ADD CONSTRAINT kb_space_pkey PRIMARY KEY (id);


--
-- Name: mail_alias mail_alias_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_alias
    ADD CONSTRAINT mail_alias_pkey PRIMARY KEY (id);


--
-- Name: mail_app_password mail_app_password_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_app_password
    ADD CONSTRAINT mail_app_password_pkey PRIMARY KEY (id);


--
-- Name: mail_domain mail_domain_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_domain
    ADD CONSTRAINT mail_domain_pkey PRIMARY KEY (id);


--
-- Name: mail_folder_meta mail_folder_meta_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_folder_meta
    ADD CONSTRAINT mail_folder_meta_pkey PRIMARY KEY (id);


--
-- Name: mail_message mail_message_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_message
    ADD CONSTRAINT mail_message_pkey PRIMARY KEY (id);


--
-- Name: mail_rule mail_rule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_rule
    ADD CONSTRAINT mail_rule_pkey PRIMARY KEY (id);


--
-- Name: mailbox mailbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailbox
    ADD CONSTRAINT mailbox_pkey PRIMARY KEY (id);


--
-- Name: message message_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message
    ADD CONSTRAINT message_pkey PRIMARY KEY (id, created_at);


--
-- Name: message_default message_default_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_default
    ADD CONSTRAINT message_default_pkey PRIMARY KEY (id, created_at);


--
-- Name: message_favorite message_favorite_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_favorite
    ADD CONSTRAINT message_favorite_pkey PRIMARY KEY (id);


--
-- Name: message_favorite message_favorite_user_id_msg_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_favorite
    ADD CONSTRAINT message_favorite_user_id_msg_id_key UNIQUE (user_id, msg_id);


--
-- Name: message_receipt message_receipt_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_receipt
    ADD CONSTRAINT message_receipt_pkey PRIMARY KEY (conv_id, user_id);


--
-- Name: oidc_access_token oidc_access_token_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_access_token
    ADD CONSTRAINT oidc_access_token_pkey PRIMARY KEY (id);


--
-- Name: oidc_auth_request oidc_auth_request_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_auth_request
    ADD CONSTRAINT oidc_auth_request_pkey PRIMARY KEY (id);


--
-- Name: oidc_client oidc_client_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_client
    ADD CONSTRAINT oidc_client_pkey PRIMARY KEY (id);


--
-- Name: oidc_grant oidc_grant_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_grant
    ADD CONSTRAINT oidc_grant_pkey PRIMARY KEY (id);


--
-- Name: oidc_refresh_token oidc_refresh_token_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_refresh_token
    ADD CONSTRAINT oidc_refresh_token_pkey PRIMARY KEY (id);


--
-- Name: oidc_web_session oidc_web_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_web_session
    ADD CONSTRAINT oidc_web_session_pkey PRIMARY KEY (id);


--
-- Name: refresh_token refresh_token_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_token
    ADD CONSTRAINT refresh_token_pkey PRIMARY KEY (id);


--
-- Name: resource_acl resource_acl_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_acl
    ADD CONSTRAINT resource_acl_pkey PRIMARY KEY (id);


--
-- Name: role role_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role
    ADD CONSTRAINT role_pkey PRIMARY KEY (id);


--
-- Name: sensitive_word sensitive_word_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensitive_word
    ADD CONSTRAINT sensitive_word_pkey PRIMARY KEY (id);


--
-- Name: sensitive_word sensitive_word_tenant_id_word_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensitive_word
    ADD CONSTRAINT sensitive_word_tenant_id_word_key UNIQUE (tenant_id, word);


--
-- Name: sticker sticker_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sticker
    ADD CONSTRAINT sticker_pkey PRIMARY KEY (id);


--
-- Name: sticker_set sticker_set_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sticker_set
    ADD CONSTRAINT sticker_set_pkey PRIMARY KEY (id);


--
-- Name: tenant tenant_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant
    ADD CONSTRAINT tenant_pkey PRIMARY KEY (id);


--
-- Name: transfer_record transfer_record_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transfer_record
    ADD CONSTRAINT transfer_record_pkey PRIMARY KEY (id);


--
-- Name: agent_tool_policy uk_agent_tool_policy; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tool_policy
    ADD CONSTRAINT uk_agent_tool_policy UNIQUE (tenant_id, subject);


--
-- Name: conversation_member uk_conv_member; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_member
    ADD CONSTRAINT uk_conv_member UNIQUE (conv_id, user_id);


--
-- Name: device uk_device_user_did; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device
    ADD CONSTRAINT uk_device_user_did UNIQUE (user_id, did);


--
-- Name: eco_app uk_eco_app; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eco_app
    ADD CONSTRAINT uk_eco_app UNIQUE (tenant_id, app_id);


--
-- Name: eco_app_install uk_eco_app_install; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eco_app_install
    ADD CONSTRAINT uk_eco_app_install UNIQUE (tenant_id, app_row_id, user_id);


--
-- Name: eco_app_version uk_eco_app_version; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eco_app_version
    ADD CONSTRAINT uk_eco_app_version UNIQUE (tenant_id, app_row_id, version);


--
-- Name: eco_expert uk_eco_expert; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eco_expert
    ADD CONSTRAINT uk_eco_expert UNIQUE (tenant_id, expert_id);


--
-- Name: eco_plugin uk_eco_plugin; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eco_plugin
    ADD CONSTRAINT uk_eco_plugin UNIQUE (tenant_id, plugin_id);


--
-- Name: eco_plugin_install uk_eco_plugin_install; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eco_plugin_install
    ADD CONSTRAINT uk_eco_plugin_install UNIQUE (tenant_id, pkg_id, user_id);


--
-- Name: eco_plugin_version uk_eco_plugin_version; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eco_plugin_version
    ADD CONSTRAINT uk_eco_plugin_version UNIQUE (pkg_id, version);


--
-- Name: eco_rollout uk_eco_rollout; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eco_rollout
    ADD CONSTRAINT uk_eco_rollout UNIQUE (tenant_id, app_row_id);


--
-- Name: eco_skill uk_eco_skill; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eco_skill
    ADD CONSTRAINT uk_eco_skill UNIQUE (tenant_id, skill_id);


--
-- Name: eco_skill_install uk_eco_skill_install; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eco_skill_install
    ADD CONSTRAINT uk_eco_skill_install UNIQUE (tenant_id, skill_row_id, user_id);


--
-- Name: mail_alias uk_mail_alias; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_alias
    ADD CONSTRAINT uk_mail_alias UNIQUE (tenant_id, alias_address);


--
-- Name: mail_domain uk_mail_domain; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_domain
    ADD CONSTRAINT uk_mail_domain UNIQUE (domain);


--
-- Name: mail_folder_meta uk_mail_folder; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_folder_meta
    ADD CONSTRAINT uk_mail_folder UNIQUE (mailbox_id, name);


--
-- Name: mailbox uk_mailbox_tenant_addr; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailbox
    ADD CONSTRAINT uk_mailbox_tenant_addr UNIQUE (tenant_id, address);


--
-- Name: oidc_client uk_oidc_client; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_client
    ADD CONSTRAINT uk_oidc_client UNIQUE (tenant_id, client_id);


--
-- Name: oidc_grant uk_oidc_grant; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_grant
    ADD CONSTRAINT uk_oidc_grant UNIQUE (user_id, client_id);


--
-- Name: oidc_refresh_token uk_oidc_refresh; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_refresh_token
    ADD CONSTRAINT uk_oidc_refresh UNIQUE (token_hash);


--
-- Name: oidc_web_session uk_oidc_web_session; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_web_session
    ADD CONSTRAINT uk_oidc_web_session UNIQUE (token_hash);


--
-- Name: resource_acl uk_resource_acl; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_acl
    ADD CONSTRAINT uk_resource_acl UNIQUE (tenant_id, resource_type, resource_id, grant_type, grant_target);


--
-- Name: user_role uk_user_role; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_role
    ADD CONSTRAINT uk_user_role UNIQUE (user_id, role_id, scope_type, scope_dept_id);


--
-- Name: users uk_users_tenant_empno; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT uk_users_tenant_empno UNIQUE (tenant_id, employee_no);


--
-- Name: user_conv_state user_conv_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_conv_state
    ADD CONSTRAINT user_conv_state_pkey PRIMARY KEY (user_id, conv_id);


--
-- Name: user_dept user_dept_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_dept
    ADD CONSTRAINT user_dept_pkey PRIMARY KEY (user_id, dept_id);


--
-- Name: user_notification user_notification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notification
    ADD CONSTRAINT user_notification_pkey PRIMARY KEY (id);


--
-- Name: user_notify_pref user_notify_pref_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notify_pref
    ADD CONSTRAINT user_notify_pref_pkey PRIMARY KEY (user_id);


--
-- Name: user_role user_role_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_role
    ADD CONSTRAINT user_role_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_admin_audit_operator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_operator ON public.admin_audit_action USING btree (operator_id, id DESC);


--
-- Name: idx_admin_audit_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_tenant_id ON public.admin_audit_action USING btree (tenant_id, id DESC);


--
-- Name: idx_agent_backup_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_backup_user ON public.agent_session_backup USING btree (tenant_id, user_id, created_at DESC);


--
-- Name: idx_ai_provider_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_provider_kind ON public.ai_provider USING btree (kind, status);


--
-- Name: idx_ai_usage_tenant_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_usage_tenant_time ON public.ai_usage_hourly USING btree (tenant_id, hour_bucket DESC);


--
-- Name: idx_apply_conv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_apply_conv ON public.conversation_apply USING btree (conv_id, status);


--
-- Name: idx_conv_member_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conv_member_user ON public.conversation_member USING btree (user_id, status);


--
-- Name: idx_conv_tenant_last_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conv_tenant_last_ts ON public.conversation USING btree (tenant_id, last_msg_ts DESC);


--
-- Name: idx_dept_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dept_path ON public.dept USING btree (path text_pattern_ops);


--
-- Name: idx_dept_tenant_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dept_tenant_parent ON public.dept USING btree (tenant_id, parent_id);


--
-- Name: idx_device_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_device_user ON public.device USING btree (user_id);


--
-- Name: idx_eco_app_install_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eco_app_install_user ON public.eco_app_install USING btree (tenant_id, user_id);


--
-- Name: idx_eco_app_version_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eco_app_version_app ON public.eco_app_version USING btree (tenant_id, app_row_id);


--
-- Name: idx_eco_expert_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eco_expert_scope ON public.eco_expert USING btree (tenant_id, source, status);


--
-- Name: idx_eco_plugin_install_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eco_plugin_install_user ON public.eco_plugin_install USING btree (tenant_id, user_id);


--
-- Name: idx_eco_plugin_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eco_plugin_owner ON public.eco_plugin USING btree (tenant_id, owner_user_id);


--
-- Name: idx_eco_plugin_version_pkg; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eco_plugin_version_pkg ON public.eco_plugin_version USING btree (pkg_id);


--
-- Name: idx_eco_rollout_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eco_rollout_app ON public.eco_rollout USING btree (tenant_id, app_row_id);


--
-- Name: idx_eco_skill_install_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eco_skill_install_user ON public.eco_skill_install USING btree (tenant_id, user_id);


--
-- Name: idx_fav_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fav_user ON public.message_favorite USING btree (user_id, created_at DESC);


--
-- Name: idx_file_conv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_file_conv ON public.file USING btree (tenant_id, conv_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_file_conv_msg; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_file_conv_msg ON public.file USING btree (conv_id, msg_seq) WHERE (deleted_at IS NULL);


--
-- Name: idx_file_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_file_owner ON public.file USING btree (tenant_id, owner_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_kb_chunk_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kb_chunk_hnsw ON public.kb_chunk USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: idx_kb_chunk_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kb_chunk_space ON public.kb_chunk USING btree (tenant_id, space_id, doc_id);


--
-- Name: idx_kb_doc_space; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kb_doc_space ON public.kb_doc USING btree (tenant_id, space_id, COALESCE(node_id, (0)::bigint), created_at DESC);


--
-- Name: idx_kb_doc_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kb_doc_status ON public.kb_doc USING btree (tenant_id, space_id, status, updated_at DESC);


--
-- Name: idx_kb_doc_view_agg; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kb_doc_view_agg ON public.kb_doc_view USING btree (tenant_id, doc_id, view_date);


--
-- Name: idx_kb_node_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kb_node_parent ON public.kb_node USING btree (tenant_id, space_id, parent_id);


--
-- Name: idx_kb_space_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kb_space_type ON public.kb_space USING btree (tenant_id, space_type);


--
-- Name: idx_mail_app_pwd_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_app_pwd_user ON public.mail_app_password USING btree (user_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_mail_msg_folder_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_msg_folder_time ON public.mail_message USING btree (folder_id, received_at DESC);


--
-- Name: idx_mail_rule_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mail_rule_user ON public.mail_rule USING btree (user_id);


--
-- Name: idx_mailbox_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mailbox_owner ON public.mailbox USING btree (owner_user_id) WHERE (owner_user_id IS NOT NULL);


--
-- Name: idx_message_conv_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_conv_client_id ON ONLY public.message USING btree (conv_id, client_msg_id);


--
-- Name: idx_message_conv_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_conv_seq ON ONLY public.message USING btree (conv_id, seq);


--
-- Name: idx_message_tenant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_tenant_created ON ONLY public.message USING btree (tenant_id, created_at);


--
-- Name: idx_notice_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notice_tenant ON public.admin_notice USING btree (tenant_id, created_at DESC);


--
-- Name: idx_oidc_access_refresh; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oidc_access_refresh ON public.oidc_access_token USING btree (refresh_id);


--
-- Name: idx_oidc_auth_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oidc_auth_code ON public.oidc_auth_request USING btree (code_hash);


--
-- Name: idx_oidc_web_session_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oidc_web_session_user ON public.oidc_web_session USING btree (user_id, status);


--
-- Name: idx_refresh_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_user_status ON public.refresh_token USING btree (user_id, status);


--
-- Name: idx_resource_acl_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_resource_acl_resource ON public.resource_acl USING btree (tenant_id, resource_type, resource_id);


--
-- Name: idx_resource_acl_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_resource_acl_target ON public.resource_acl USING btree (tenant_id, grant_type, grant_target);


--
-- Name: idx_sensitive_word_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sensitive_word_tenant ON public.sensitive_word USING btree (tenant_id, enabled);


--
-- Name: idx_sticker_set_items; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sticker_set_items ON public.sticker USING btree (set_id);


--
-- Name: idx_sticker_set_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sticker_set_owner ON public.sticker_set USING btree (owner_id);


--
-- Name: idx_sticker_set_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sticker_set_tenant ON public.sticker_set USING btree (tenant_id);


--
-- Name: idx_transfer_tenant_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transfer_tenant_user ON public.transfer_record USING btree (tenant_id, user_id, created_at DESC);


--
-- Name: idx_transfer_upload; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transfer_upload ON public.transfer_record USING btree (upload_id) WHERE (upload_id IS NOT NULL);


--
-- Name: idx_user_conv_state_conv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_conv_state_conv ON public.user_conv_state USING btree (conv_id);


--
-- Name: idx_user_notification_user_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_notification_user_kind ON public.user_notification USING btree (user_id, kind, id DESC);


--
-- Name: idx_user_notification_user_read; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_notification_user_read ON public.user_notification USING btree (user_id, read_at);


--
-- Name: idx_user_notify_pref_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_notify_pref_tenant ON public.user_notify_pref USING btree (tenant_id);


--
-- Name: idx_user_role_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_role_user ON public.user_role USING btree (user_id);


--
-- Name: idx_users_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_tenant ON public.users USING btree (tenant_id);


--
-- Name: message_default_conv_id_client_msg_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_default_conv_id_client_msg_id_idx ON public.message_default USING btree (conv_id, client_msg_id);


--
-- Name: message_default_conv_id_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_default_conv_id_seq_idx ON public.message_default USING btree (conv_id, seq);


--
-- Name: message_default_tenant_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_default_tenant_id_created_at_idx ON public.message_default USING btree (tenant_id, created_at);


--
-- Name: uk_ai_provider_owner_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uk_ai_provider_owner_name ON public.ai_provider USING btree (tenant_id, COALESCE(owner_user_id, (0)::bigint), lower(name));


--
-- Name: uk_ai_route_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uk_ai_route_active ON public.ai_route_rule USING btree (tenant_id, tier, version) WHERE (status = 'active'::text);


--
-- Name: uk_ai_usage_hourly; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uk_ai_usage_hourly ON public.ai_usage_hourly USING btree (tenant_id, hour_bucket, user_id, svc_subject, session_id, scene, tier, provider_id);


--
-- Name: uk_apply_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uk_apply_pending ON public.conversation_apply USING btree (conv_id, user_id) WHERE (status = 1);


--
-- Name: uk_mail_msg_mailbox_mid; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uk_mail_msg_mailbox_mid ON public.mail_message USING btree (mailbox_id, message_id);


--
-- Name: uk_refresh_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uk_refresh_hash ON public.refresh_token USING btree (token_hash);


--
-- Name: uk_role_tenant_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uk_role_tenant_name ON public.role USING btree (tenant_id, name);


--
-- Name: uk_sticker_set_file; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uk_sticker_set_file ON public.sticker USING btree (set_id, file_id);


--
-- Name: uq_agent_backup_idem; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_agent_backup_idem ON public.agent_session_backup USING btree (user_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uq_file_tenant_sha; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_file_tenant_sha ON public.file USING btree (tenant_id, sha256) WHERE (deleted_at IS NULL);


--
-- Name: uq_kb_node_sibling; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_kb_node_sibling ON public.kb_node USING btree (tenant_id, space_id, COALESCE(parent_id, (0)::bigint), name) WHERE (status = 'active'::text);


--
-- Name: uq_kb_space_company; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_kb_space_company ON public.kb_space USING btree (tenant_id) WHERE (space_type = 'company'::text);


--
-- Name: uq_kb_space_personal; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_kb_space_personal ON public.kb_space USING btree (tenant_id, owner_id) WHERE (space_type = 'personal'::text);


--
-- Name: message_default_conv_id_client_msg_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_message_conv_client_id ATTACH PARTITION public.message_default_conv_id_client_msg_id_idx;


--
-- Name: message_default_conv_id_seq_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_message_conv_seq ATTACH PARTITION public.message_default_conv_id_seq_idx;


--
-- Name: message_default_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.message_pkey ATTACH PARTITION public.message_default_pkey;


--
-- Name: message_default_tenant_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_message_tenant_created ATTACH PARTITION public.message_default_tenant_id_created_at_idx;


--
-- Name: mail_folder_meta mail_folder_meta_mailbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_folder_meta
    ADD CONSTRAINT mail_folder_meta_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES public.mailbox(id);


--
-- Name: mail_message mail_message_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_message
    ADD CONSTRAINT mail_message_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.mail_folder_meta(id);


--
-- Name: mail_message mail_message_mailbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_message
    ADD CONSTRAINT mail_message_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES public.mailbox(id);


--
-- Name: mailbox mailbox_domain_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mailbox
    ADD CONSTRAINT mailbox_domain_id_fkey FOREIGN KEY (domain_id) REFERENCES public.mail_domain(id);


--
-- Name: admin_audit_action; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_audit_action ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_session_backup; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_session_backup ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_tool_policy; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_tool_policy ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversation ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation_apply; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversation_apply ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation_member; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversation_member ENABLE ROW LEVEL SECURITY;

--
-- Name: dept; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dept ENABLE ROW LEVEL SECURITY;

--
-- Name: device; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.device ENABLE ROW LEVEL SECURITY;

--
-- Name: eco_app; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.eco_app ENABLE ROW LEVEL SECURITY;

--
-- Name: eco_app_install; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.eco_app_install ENABLE ROW LEVEL SECURITY;

--
-- Name: eco_app_version; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.eco_app_version ENABLE ROW LEVEL SECURITY;

--
-- Name: eco_plugin; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.eco_plugin ENABLE ROW LEVEL SECURITY;

--
-- Name: eco_plugin_install; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.eco_plugin_install ENABLE ROW LEVEL SECURITY;

--
-- Name: eco_plugin_version; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.eco_plugin_version ENABLE ROW LEVEL SECURITY;

--
-- Name: eco_rollout; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.eco_rollout ENABLE ROW LEVEL SECURITY;

--
-- Name: eco_skill; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.eco_skill ENABLE ROW LEVEL SECURITY;

--
-- Name: eco_skill_install; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.eco_skill_install ENABLE ROW LEVEL SECURITY;

--
-- Name: file; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.file ENABLE ROW LEVEL SECURITY;

--
-- Name: group_setting; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.group_setting ENABLE ROW LEVEL SECURITY;

--
-- Name: kb_chunk; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kb_chunk ENABLE ROW LEVEL SECURITY;

--
-- Name: kb_doc; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kb_doc ENABLE ROW LEVEL SECURITY;

--
-- Name: kb_doc_view; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kb_doc_view ENABLE ROW LEVEL SECURITY;

--
-- Name: kb_node; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kb_node ENABLE ROW LEVEL SECURITY;

--
-- Name: kb_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kb_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: kb_space; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kb_space ENABLE ROW LEVEL SECURITY;

--
-- Name: message; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.message ENABLE ROW LEVEL SECURITY;

--
-- Name: message_default; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.message_default ENABLE ROW LEVEL SECURITY;

--
-- Name: message_favorite; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.message_favorite ENABLE ROW LEVEL SECURITY;

--
-- Name: message_receipt; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.message_receipt ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_audit_action p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.admin_audit_action USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: agent_session_backup p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.agent_session_backup USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: agent_tool_policy p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.agent_tool_policy USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: conversation p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.conversation USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: conversation_apply p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.conversation_apply USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: conversation_member p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.conversation_member USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: dept p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.dept USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: device p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.device USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: eco_app p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.eco_app USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: eco_app_install p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.eco_app_install USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: eco_app_version p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.eco_app_version USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: eco_plugin p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.eco_plugin USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: eco_plugin_install p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.eco_plugin_install USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: eco_plugin_version p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.eco_plugin_version USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: eco_rollout p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.eco_rollout USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: eco_skill p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.eco_skill USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: eco_skill_install p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.eco_skill_install USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: file p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.file USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: group_setting p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.group_setting USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: kb_chunk p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.kb_chunk USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: kb_doc p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.kb_doc USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: kb_doc_view p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.kb_doc_view USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: kb_node p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.kb_node USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: kb_settings p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.kb_settings USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: kb_space p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.kb_space USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: message p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.message USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: message_default p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.message_default USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: message_favorite p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.message_favorite USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: message_receipt p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.message_receipt USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: refresh_token p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.refresh_token USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: role p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.role USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: sensitive_word p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.sensitive_word USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: sticker p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.sticker USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: sticker_set p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.sticker_set USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: user_conv_state p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.user_conv_state USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: user_dept p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.user_dept USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: user_notification p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.user_notification USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: user_notify_pref p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.user_notify_pref USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: user_role p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.user_role USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: users p_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_tenant ON public.users USING ((tenant_id = (current_setting('app.tenant'::text, true))::bigint));


--
-- Name: refresh_token; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.refresh_token ENABLE ROW LEVEL SECURITY;

--
-- Name: role; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.role ENABLE ROW LEVEL SECURITY;

--
-- Name: sensitive_word; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sensitive_word ENABLE ROW LEVEL SECURITY;

--
-- Name: sticker; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sticker ENABLE ROW LEVEL SECURITY;

--
-- Name: sticker_set; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sticker_set ENABLE ROW LEVEL SECURITY;

--
-- Name: user_conv_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_conv_state ENABLE ROW LEVEL SECURITY;

--
-- Name: user_dept; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_dept ENABLE ROW LEVEL SECURITY;

--
-- Name: user_notification; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_notification ENABLE ROW LEVEL SECURITY;

--
-- Name: user_notify_pref; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_notify_pref ENABLE ROW LEVEL SECURITY;

--
-- Name: user_role; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_role ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

COMMIT;
