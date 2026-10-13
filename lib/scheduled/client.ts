export type ScheduledConnection = {
  jiraSite: string;
  jiraEmail: string;
  jiraHint: string;
  githubHint: string;
  jiraConnected: boolean;
  githubConnected: boolean;
};

export async function sendScheduled(path: string, method = "GET", body?: unknown) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
