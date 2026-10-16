import { as } from "./harness.mjs";

// A PostgREST-like double of a Supabase client over PGlite, for route tests
// that need real SQL (ADR 008's OAuth flow). Runs every call as `role`, with
// auth.uid() = `user` for "authenticated". Supports the query shapes the
// routes use: from().select().eq/in/is/order/range/limit, maybeSingle,
// insert, and rpc() with argument types read from the catalog (jsonb
// arguments are sent as JSON). Calls are serialized: PGlite has one
// connection and as() switches roles around each statement.
export function supabaseDouble(db, { role = "service_role", user = null } = {}) {
  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn);
    queue = next.catch(() => undefined);
    return next;
  };
  const sql = (text, params = []) => serial(() => as(db, role, user, text, params));
  const argTypes = new Map();
  async function types(name) {
    if (!argTypes.has(name)) {
      const { rows } = await db.query(`select unnest(proargnames) n, unnest(proargtypes::regtype[]::text[]) t
        from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`, [name]);
      argTypes.set(name, new Map(rows.map((r) => [r.n, r.t])));
    }
    return argTypes.get(name);
  }
  const client = {
    auth: { getUser: async () => ({ data: { user: user ? { id: user } : null }, error: null }) },
    from(table) {
      const where = [];
      const params = [];
      let columns = "*";
      const order = [];
      let tail = "";
      const builder = {
        select: (c) => ((columns = c), builder),
        eq: (c, v) => (params.push(v), where.push(`${c} = $${params.length}`), builder),
        in: (c, v) => (params.push(v), where.push(`${c} = any($${params.length})`), builder),
        is: (c, v) => (where.push(`${c} is ${v === null ? "null" : v ? "true" : "false"}`), builder),
        order: (c, o = {}) => (order.push(`${c} ${o.ascending === false ? "desc" : "asc"}`), builder),
        range: (from, to) => ((tail = ` limit ${Number(to) - Number(from) + 1} offset ${Number(from)}`), builder.run()),
        limit: (count) => ((tail = ` limit ${Number(count)}`), builder),
        returns: () => builder,
        async run() {
          const text = `select ${columns} from public.${table}${where.length ? ` where ${where.join(" and ")}` : ""}` +
            `${order.length ? ` order by ${order.join(", ")}` : ""}${tail}`;
          try {
            return { data: await sql(text, params), error: null };
          } catch (error) {
            return { data: null, error };
          }
        },
        then: (resolve, reject) => builder.run().then(resolve, reject),
        maybeSingle: async () => {
          const r = await builder.run();
          return r.error ? r : { data: r.data[0] ?? null, error: null };
        },
        async insert(row) {
          const keys = Object.keys(row);
          try {
            await sql(`insert into public.${table} (${keys.join(", ")})
              select ${keys.join(", ")} from jsonb_populate_record(null::public.${table}, $1::jsonb)`, [JSON.stringify(row)]);
            return { error: null };
          } catch (error) {
            return { error };
          }
        },
      };
      return builder;
    },
    async rpc(name, args = {}) {
      const t = await types(name);
      const keys = Object.keys(args);
      const text = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}::${t.get(k) ?? "text"}`).join(", ")}) as r`;
      const values = keys.map((k) => (t.get(k) === "jsonb" && args[k] !== null ? JSON.stringify(args[k]) : args[k]));
      try {
        return { data: (await sql(text, values))[0].r, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  };
  return client;
}
