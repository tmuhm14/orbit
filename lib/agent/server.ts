import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  textDoc,
  type BucketId,
  type ItemKind,
  type LinkErrorCode,
  type Note,
} from "../notes";
import {
  organizeTask,
  runAgent,
  triageTask,
  type AgentNoteDetail,
  type AgentProgress,
  type AgentStore,
  type NoteChanges,
  type StoreRefusal,
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
  "id,workspace_id,trigger,mode,instruction,provider,model,status,summary,error,created_at,finished_at,events,parent_run_id";
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
  revision: number;
  kind: ItemKind;
  project_id: string | null;
};

/** Keeps a search term to words so it can't alter the PostgREST filter. */
const searchTerm = (query: string) =>
  query.replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();

type ApplyResult =
  | { status: "applied" | "unchanged"; revision: number }
  | { status: "conflict"; currentRevision: number }
  | { status: "not_found" | "run_not_active" | "kind_not_allowed" }
  | { status: "invalid"; code: LinkErrorCode };

/** The note values an agent change would set, from the row it was based on. */
function changedValues(row: NoteRow, changes: NoteChanges) {
  const after: Record<string, unknown> = {};
  const set = (column: keyof NoteRow, value: unknown) => {
    if (JSON.stringify(row[column]) !== JSON.stringify(value)) after[column] = value;
  };
  if (changes.title !== undefined) set("title", changes.title);
  if (changes.bucket !== undefined) set("bucket", changes.bucket);
  if (changes.kind !== undefined) set("kind", changes.kind);
  if (changes.projectId !== undefined) set("project_id", changes.projectId);
  if (changes.tags !== undefined) set("tags", changes.tags);
  if (changes.completed !== undefined)
    set(
      "completed_at",
      changes.completed ? (row.completed_at ?? new Date().toISOString()) : null,
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
  return after;
}

/**
 * Notes for one user and workspace, through the admin client (capture runs
 * have no browser session). Reads filter on both ids. Writes go through
 * agent_apply_note_change / agent_create_note, which take the user and
 * workspace from the run row and record each change in agent_actions in the
 * same transaction (ADR 002 §4). A change applies only at the revision the
 * agent last read; on a conflict the store re-reads once and recomputes.
 * Revisions are never shown to the model.
 */
export function supabaseAgentStore(
  admin: SupabaseClient,
  scope: { userId: string; workspaceId: string; runId: string },
): AgentStore {
  // Revision of each note as the model last saw it in this run.
  const seen = new Map<string, number>();
  const notes = () =>
    admin
      .from("notes")
      .select(
        "id,title,bucket,tags,source,plain_text,content,origin,created_at,completed_at,triage_status,revision,kind,project_id",
      )
      .eq("user_id", scope.userId)
      .eq("workspace_id", scope.workspaceId);
  const detail = (row: NoteRow): AgentNoteDetail => ({
    id: row.id,
    title: row.title,
    bucket: row.bucket,
    kind: row.kind ?? "note",
    projectId: row.project_id ?? null,
    tags: row.tags,
    source: row.source,
    createdAt: row.created_at,
    completed: !!row.completed_at,
    pendingTriage: row.triage_status === "pending",
    text: row.plain_text,
    origin: row.origin,
  });
  /**
   * Links resolve only within this run's workspace (ADR 001 §3a); the
   * composite key and trigger refuse anything else anyway.
   */
  const isProject = async (id: string) => {
    const { data } = await admin
      .from("notes")
      .select("id")
      .eq("user_id", scope.userId)
      .eq("workspace_id", scope.workspaceId)
      .eq("id", id)
      .eq("kind", "project")
      .maybeSingle<{ id: string }>();
    return !!data;
  };
  const refuse = (refused: StoreRefusal) => ({ refused });
  const apply = async (
    row: NoteRow,
    expected: number,
    after: Record<string, unknown>,
    reason: string,
  ) => {
    const { data, error } = await admin.rpc("agent_apply_note_change", {
      p_run_id: scope.runId,
      p_note_id: row.id,
      p_expected_revision: expected,
      p_after: after,
      p_reason: reason,
    });
    if (error || !data) throw new Error("Could not update note");
    return data as ApplyResult;
  };
  return {
    async list(filter) {
      let query = notes();
      if (filter.bucket) query = query.eq("bucket", filter.bucket);
      if (filter.kind) query = query.eq("kind", filter.kind);
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
      return data.map(({ plain_text, revision, ...row }) => {
        seen.set(row.id, revision);
        const { text: _text, origin: _origin, ...summary } = detail({
          ...row,
          plain_text,
          revision,
        });
        return { ...summary, snippet: plain_text.slice(0, 240) };
      });
    },
    async get(id) {
      const { data } = await notes().eq("id", id).maybeSingle<NoteRow>();
      if (!data) return null;
      seen.set(data.id, data.revision);
      return detail(data);
    },
    async update(id, changes: NoteChanges, reason) {
      if (changes.projectId && !(await isProject(changes.projectId)))
        return refuse("project_not_found");
      // First attempt: the revision the model saw (or this read, if it never
      // read the note). On a conflict, re-read once and recompute.
      let expected = seen.get(id);
      for (let attempt = 0; attempt < 2; attempt++) {
        const { data: row } = await notes().eq("id", id).maybeSingle<NoteRow>();
        if (!row) return false;
        const base = expected ?? row.revision;
        const after = changedValues(row, changes);
        if (!Object.keys(after).length) {
          seen.set(id, row.revision);
          return true;
        }
        const result =
          base === row.revision
            ? await apply(row, base, after, reason)
            : ({ status: "conflict", currentRevision: row.revision } as const);
        if (result.status === "applied" || result.status === "unchanged") {
          seen.set(id, result.revision);
          return true;
        }
        if (result.status === "not_found") return false;
        if (result.status === "run_not_active")
          throw new Error("Agent run is no longer active");
        // The server decides when the agent may change a kind (ADR 001 §3a).
        if (result.status === "kind_not_allowed") return refuse("kind_not_allowed");
        if (result.status === "invalid") return refuse(result.code);
        expected = undefined;
      }
      // Changed again while recomputing. Nothing was written (ADR 002 §4).
      return refuse("conflict");
    },
    async create(note, reason) {
      if (note.projectId && !(await isProject(note.projectId)))
        return refuse("project_not_found");
      const { data, error } = await admin.rpc("agent_create_note", {
        p_run_id: scope.runId,
        p_note: {
          title: note.title,
          content: textDoc(note.body),
          plain_text: note.body,
          bucket: note.bucket,
          tags: [...new Set([...note.tags, "agent"])],
          ...(note.kind ? { kind: note.kind } : {}),
          ...(note.projectId ? { project_id: note.projectId } : {}),
        },
        p_reason: reason,
      });
      const result = data as
        | { status: "created"; id: string; revision: number }
        | { status: "invalid"; code: LinkErrorCode }
        | { status: "run_not_active" }
        | null;
      if (!error && result?.status === "invalid") return refuse(result.code);
      if (error || result?.status !== "created")
        throw new Error("Could not create note");
      seen.set(result.id, result.revision);
      return result.id;
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
  parentRunId?: string;
  previousContext?: string;
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
      parent_run_id: request.parentRunId || null,
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
    const events: AgentProgress[] = [];
    const result = await runAgent({
      provider: createProvider(
        settings.provider,
        settings.apiKey,
        settings.model,
      ),
      store: supabaseAgentStore(admin, { ...request, runId }),
      workspaceName: workspace.name,
      onProgress: async (event) => {
        events.push(event);
        const { error } = await admin.from("agent_runs")
          .update({ events: events.slice(-200) })
          .eq("id", runId).eq("user_id", request.userId).eq("status", "running");
        if (error) throw new Error("Could not save progress");
      },
      task:
        request.mode === "triage"
          ? triageTask(request.noteIds)
          : organizeTask(request.previousContext
              ? `${request.previousContext}\n\nFollow-up request: ${request.instruction ?? "Continue"}`
              : request.instruction),
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
