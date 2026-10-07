import { routeUser, json } from "@/lib/supabase/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  agentEncryptionKey,
  loadAgentSettings,
  type AgentSettings,
} from "@/lib/agent/server";
import {
  PROVIDERS,
  ProviderError,
  createProvider,
  isProviderId,
} from "@/lib/agent/providers";
import { encryptSecret, keyHint } from "@/lib/agent/secret";

const publicSettings = (s: AgentSettings): AgentSettings => ({
  provider: s.provider,
  model: s.model,
  keyHint: s.keyHint,
  autoTriage: s.autoTriage,
});

async function models(provider: AgentSettings["provider"], apiKey: string) {
  try {
    return await createProvider(provider, apiKey, "").listModels();
  } catch {
    return [];
  }
}

/** The account's provider, model, and key hint. The key itself never leaves the server. */
export async function GET(request: Request) {
  const auth = await routeUser(request);
  if ("error" in auth) return auth.error;
  const admin = createAdminClient();
  if (!admin || !agentEncryptionKey())
    return json({ configured: false, settings: null, models: [] });
  const settings = await loadAgentSettings(admin, auth.user.id);
  return json({
    configured: true,
    settings: settings && publicSettings(settings),
    models: settings?.apiKey
      ? await models(settings.provider, settings.apiKey)
      : [],
  });
}

/** Saves the provider and model, checking a new key against the provider first. */
export async function PUT(request: Request) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const admin = createAdminClient();
  const encryptionKey = agentEncryptionKey();
  if (!admin || !encryptionKey)
    return json({ error: "The agent isn't configured on this server" }, 503);
  const body = await request.json().catch(() => ({}));
  const { provider, apiKey, autoTriage } = body;
  if (!isProviderId(provider)) return json({ error: "Unknown provider" }, 400);
  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : PROVIDERS[provider].defaultModel;
  if (model.length > 100 || typeof autoTriage !== "boolean")
    return json({ error: "Invalid settings" }, 400);

  const existing = await loadAgentSettings(admin, auth.user.id);
  let key: string;
  let available: string[];
  if (typeof apiKey === "string" && apiKey.trim()) {
    key = apiKey.trim();
    if (key.length < 10 || key.length > 500)
      return json({ error: "That doesn't look like an API key" }, 400);
    try {
      available = await createProvider(provider, key, model).listModels();
    } catch (error) {
      return json(
        {
          error:
            error instanceof ProviderError
              ? error.message
              : "Couldn't check the key",
        },
        400,
      );
    }
  } else if (existing?.apiKey && existing.provider === provider) {
    key = existing.apiKey;
    available = await models(provider, key);
  } else {
    return json({ error: `Enter your ${PROVIDERS[provider].name} API key` }, 400);
  }

  const settings: AgentSettings = {
    provider,
    model,
    keyHint: keyHint(key),
    autoTriage,
  };
  const { error } = await admin.from("agent_settings").upsert({
    user_id: auth.user.id,
    provider,
    model,
    api_key_ciphertext: encryptSecret(key, encryptionKey),
    key_hint: settings.keyHint,
    auto_triage: autoTriage,
    updated_at: new Date().toISOString(),
  });
  if (error) return json({ error: "Couldn't save the settings" }, 500);
  return json({ settings, models: available });
}

export async function DELETE(request: Request) {
  const auth = await routeUser(request, { mutating: true });
  if ("error" in auth) return auth.error;
  const admin = createAdminClient();
  if (!admin) return json({ error: "Not configured" }, 503);
  const { error } = await admin
    .from("agent_settings")
    .delete()
    .eq("user_id", auth.user.id);
  if (error) return json({ error: "Couldn't remove the key" }, 500);
  return json({ settings: null });
}
