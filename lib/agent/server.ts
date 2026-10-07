import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { textDoc, type BucketId, type Note } from "../notes";
import {
  organizeTask,
  runAgent,
  triageTask,
  type AgentNoteDetail,
  type AgentStore,
  type NoteChanges,
} from "./agent";
import {
  ProviderError,
  createProvider,
  isProviderId,
  type ProviderId,
} from "./providers";
import { decryptSecret, parseEncryptionKey } from "./secret";

/** 32-byte key that encrypts stored model API keys; null when unset or malformed. */
export const agentEncryptionKey = () =>
  parseEncryptionKey(process.env.AGENT_ENCRYPTION_KEY);

export type AgentSettings = {
  provider: ProviderId;
  model: string;
  keyHint: string;
  autoTriage: boolean;
};
export type AgentMode = "triage" | "organize";
export const RUN_COLUMNS =
  "id,workspace_id,trigger,mode,instruction,provider,model,status,summary,error,created_at,finished_at";
/** Runs still "running" after this long were cut off by the platform. */
export const RUN_TIMEOUT_MS = 6 * 60_000;

type SettingsRow = {
  provider: string;
  model: string;
  api_key_ciphertext: string;
  key_hint: string;
  auto_triage: boolean;
};

export async function loadAgentSettings(
  admin: SupabaseClient,
  userId: string,
): Promise<(AgentSettings & { apiKey: string | null }) | null> {
  const { data } = await admin
    .from("agent_settings")
    .select("provider,model,api_key_ciphertext,key_hint,auto_triage")
    .eq("user_id", userId)
    .maybeSingle<SettingsRow>();
  if (!data || !isProviderId(data.provider)) return null;
  const key = agentEncryptionKey();
  return {
    provider: data.provider,
    model: data.model,
    keyHint: data.key_hint,
    autoTriage: data.auto_triage,
    apiKey: key ? decryptSecret(data.api_key_ciphertext, key) : null,
  };
}

type NoteRow = {
  id: string;
  title: string;
  bucket: BucketId;
  tags: string[];
  source: string;
  plain_text: string;
  content: Note["content"];
  origin: Record<string, unknown> | null;
  created_at: string;
  completed_at: string | null;
  triage_status: string;
};

/** Keeps a search term to words so it can't alter the PostgREST filter. */
const searchTerm = (query: string) =>
  query.replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();

/**
 * Notes for one user and workspace, through the admin client (capture runs
 * have no browser session). Every query filters on both ids, and every change
 * is recorded in agent_actions with the values it replaced.
 */
export function supabaseAgentStore(
  admin: SupabaseClient,
  scope: { userId: string; workspaceId: string; runId: string },
): AgentStore {
  const notes = () =>
    admin
      .from("notes")
      .select(
        "id,title,bucket,tags,source,plain_text,content,origin,created_at,completed_at,triage_status",
      )
      .eq("user_id", scope.userId)
      .eq("workspace_id", scope.workspaceId);
  const record = (
    noteId: string,
    kind: "update" | "create",
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
    reason: string,
  ) =>
    admin.from("agent_actions").insert({
      run_id: scope.runId,
      user_id: scope.userId,
      note_id: noteId,
      kind,
      before,
      after,
      reason: reason || null,
    });
  const detail = (row: NoteRow): AgentNoteDetail => ({
    id: row.id,
    title: row.title,
    bucket: row.bucket,
    tags: row.tags,
    source: row.source,
    createdAt: row.created_at,
    completed: !!row.completed_at,
    pendingTriage: row.triage_status === "pending",
    text: row.plain_text,
    origin: row.origin,
  });
  return {
    async list(filter) {
      let query = notes();
      if (filter.bucket) query = query.eq("bucket", filter.bucket);
      if (filter.tag) query = query.contains("tags", [filter.tag]);
      if (!filter.includeCompleted) query = query.is("completed_at", null);
      if (filter.pendingOnly) query = query.eq("triage_status", "pending");
      const term = filter.query && searchTerm(filter.query);
      if (term)
        query = query.or(`title.ilike.%${term}%,plain_text.ilike.%${term}%`);
      const { data, error } = await query
        .order("created_at", { ascending: false })
        .limit(filter.limit)
        .returns<NoteRow[]>();
      if (error) throw new Error("Could not list notes");
      return data.map(({ plain_text, ...row }) => {
        const { text: _text, origin: _origin, ...summary } = detail({
          ...row,
          plain_text,
        });
        return { ...summary, snippet: plain_text.slice(0, 240) };
      });
    },
    async get(id) {
      const { data } = await notes().eq("id", id).maybeSingle<NoteRow>();
      return data ? detail(data) : null;
    },
    async update(id, changes: NoteChanges, reason) {
      const { data: row } = await notes().eq("id", id).maybeSingle<NoteRow>();
      if (!row) return false;
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const set = (column: keyof NoteRow, value: unknown) => {
        if (JSON.stringify(row[column]) === JSON.stringify(value)) return;
        before[column] = row[column];
        after[column] = value;
      };
      if (changes.title !== undefined) set("title", changes.title);
      if (changes.bucket !== undefined) set("bucket", changes.bucket);
      if (changes.tags !== undefined) set("tags", changes.tags);
      if (changes.completed !== undefined)
        set(
          "completed_at",
          changes.completed
            ? (row.completed_at ?? new Date().toISOString())
            : null,
        );
      if (changes.appendText) {
        set("content", {
          ...row.content,
          content: [
            ...(row.content.content ?? []),
            ...(textDoc(changes.appendText).content ?? []),
          ],
        });
        set(
          "plain_text",
          row.plain_text
            ? `${row.plain_text}\n${changes.appendText}`
            : changes.appendText,
        );
      }
      if (row.triage_status === "pending") set("triage_status", "done");
      if (!Object.keys(after).length) return true;
      const { error } = await admin
        .from("notes")
        .update({ ...after, updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("user_id", scope.userId)
        .eq("workspace_id", scope.workspaceId);
      if (error) throw new Error("Could not update note");
      await record(id, "update", before, after, reason);
      return true;
    },
    async create(note, reason) {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const doc = textDoc(note.body);
      const row = {
        title: note.title,
        content: doc,
        plain_text: note.body,
        bucket: note.bucket,
        tags: [...new Set([...note.tags, "agent"])],
      };
      const { error } = await admin.from("notes").insert({
        id,
        user_id: scope.userId,
        workspace_id: scope.workspaceId,
        ...row,
        created_at: now,
        updated_at: now,
      });
      if (error) throw new Error("Could not create note");
      await record(id, "create", null, row, reason);
      return id;
    },
  };
}

type RunRequest = {
  userId: string;
  workspaceId: string;
  trigger: "capture" | "manual";
  mode: AgentMode;
  instruction?: string;
  noteIds?: string[];
};

/**
 * Checks the workspace allows the agent and a usable key is saved, then
 * records a running run. Returns an error message the user can act on.
 */
export async function createRun(
  admin: SupabaseClient,
  request: RunRequest,
): Promise<{ runId: string } | { error: string }> {
  const { data: workspace } = await admin
    .from("workspaces")
    .select("agent_enabled")
    .eq("id", request.workspaceId)
    .eq("user_id", request.userId)
    .maybeSingle<{ agent_enabled: boolean }>();
  if (!workspace) return { error: "Workspace not found" };
  if (!workspace.agent_enabled)
    return { error: "The agent is turned off for this workspace" };
  const settings = await loadAgentSettings(admin, request.userId);
  if (!settings) return { error: "Add a model API key first" };
  if (!settings.apiKey)
    return { error: "The saved API key can't be read. Enter it again." };
  const { data, error } = await admin
    .from("agent_runs")
    .insert({
      user_id: request.userId,
      workspace_id: request.workspaceId,
      trigger: request.trigger,
      mode: request.mode,
      instruction: request.instruction || null,
      provider: settings.provider,
      model: settings.model,
    })
    .select("id")
    .single<{ id: string }>();
  if (error) return { error: "Couldn't start the agent" };
  return { runId: data.id };
}

/** Runs the agent and records the outcome. Never throws. */
export async function executeRun(
  admin: SupabaseClient,
  runId: string,
  request: RunRequest,
) {
  const finish = (fields: Record<string, unknown>) =>
    admin
      .from("agent_runs")
      .update({ ...fields, finished_at: new Date().toISOString() })
      .eq("id", runId);
  try {
    const settings = await loadAgentSettings(admin, request.userId);
    const { data: workspace } = await admin
      .from("workspaces")
      .select("name")
      .eq("id", request.workspaceId)
      .eq("user_id", request.userId)
      .single<{ name: string }>();
    if (!settings?.apiKey || !workspace) throw new Error("Run setup missing");
    const result = await runAgent({
      provider: createProvider(
        settings.provider,
        settings.apiKey,
        settings.model,
      ),
      store: supabaseAgentStore(admin, { ...request, runId }),
      workspaceName: workspace.name,
      task:
        request.mode === "triage"
          ? triageTask(request.noteIds)
          : organizeTask(request.instruction),
    });
    // Captures the agent looked at but left alone are still triaged.
    if (request.noteIds?.length)
      await admin
        .from("notes")
        .update({ triage_status: "done" })
        .in("id", request.noteIds)
        .eq("user_id", request.userId)
        .eq("triage_status", "pending");
    await finish({ status: "done", summary: result.summary.slice(0, 4000) });
  } catch (error) {
    // Log only the run id and error type; messages may quote note content.
    console.error("agent run failed", {
      runId,
      type: error instanceof Error ? error.name : typeof error,
    });
    await finish({
      status: "failed",
      error:
        error instanceof ProviderError
          ? error.message
          : "The agent stopped unexpectedly",
    });
  }
}

/** Triages fresh captures when the account and workspace have opted in. */
export async function triageCaptures(
  admin: SupabaseClient,
  capture: { userId: string; workspaceId: string; noteIds: string[] },
) {
  if (!capture.noteIds.length) return;
  const settings = await loadAgentSettings(admin, capture.userId);
  if (!settings?.autoTriage) return;
  const request = { ...capture, trigger: "capture", mode: "triage" } as const;
  const run = await createRun(admin, request);
  if ("runId" in run) await executeRun(admin, run.runId, request);
}
