export type DailyTask = {
  timezone: string;
  delivery_hour: number;
  cadence: "daily" | "weekdays";
};

const formatter = (timezone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });

export function localParts(instant: Date, timezone: string) {
  const parts = Object.fromEntries(
    formatter(timezone).formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
  };
}

export function localDate(instant: Date, timezone: string) {
  const { year, month, day } = localParts(instant, timezone);
  return [year, month, day].map((value, index) =>
    String(value).padStart(index ? 2 : 4, "0"),
  ).join("-");
}

export function previousDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

/** UTC instant corresponding to midnight in a named timezone, including DST. */
export function localMidnightUtc(date: string, timezone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const wanted = Date.UTC(year, month - 1, day);
  let guess = wanted;
  for (let attempt = 0; attempt < 4; attempt++) {
    const actual = localParts(new Date(guess), timezone);
    const shown = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour);
    const difference = wanted - shown;
    if (!difference) return new Date(guess).toISOString();
    guess += difference;
  }
  return new Date(guess).toISOString();
}

export function reportWindow(reportDate: string, timezone: string) {
  const [year, month, day] = reportDate.split("-").map(Number);
  const following = new Date(Date.UTC(year, month - 1, day + 1))
    .toISOString().slice(0, 10);
  return {
    start: localMidnightUtc(reportDate, timezone),
    end: localMidnightUtc(following, timezone),
  };
}

/** Starts two hours ahead of delivery, leaving time for cron jitter and API work. */
export function dueReportDate(task: DailyTask, now: Date): string | null {
  const local = localParts(now, task.timezone);
  if (local.hour !== task.delivery_hour - 2) return null;
  const today = localDate(now, task.timezone);
  const [year, month, day] = today.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (task.cadence === "weekdays" && (weekday === 0 || weekday === 6))
    return null;
  return previousDate(today);
}
