import { as } from "./harness.mjs";

// A small PostgREST-like double of the Supabase admin client over PGlite:
// from().select().eq/in/lt/order/limit, maybeSingle, returns, and rpc(), all
// run as service_role so table grants and RPC parameter names are exercised.
// PGlite has one connection and as() switches roles around each statement,
// so every call is serialized. `rpcLog` records RPC names in order.
export function adminDouble(db) {
  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn);
    queue = next.catch(() => undefined);
    return next;
  };
  const sql = (text, params = []) => serial(() => as(db, "service_role", null, text, params));
  const rpcLog = [];
  const admin = {
    rpcLog,
    sql,
    from(table) {
      const where = [];
      const params = [];
      let columns = "*";
      let order = "";
      let limit = "";
      const builder = {
        select: (c) => ((columns = c), builder),
        eq: (c, v) => (params.push(v), where.push(`${c} = $${params.length}`), builder),
        in: (c, v) => (params.push(v), where.push(`${c} = any($${params.length})`), builder),
        lt: (c, v) => (params.push(v), where.push(`${c} < $${params.length}`), builder),
        order: (c, o = {}) => ((order = ` order by ${c} ${o.ascending === false ? "desc" : "asc"}`), builder),
        limit: (count) => ((limit = ` limit ${Number(count)}`), builder),
        returns: () => builder,
        async run() {
          const text = `select ${columns} from public.${table}${where.length ? ` where ${where.join(" and ")}` : ""}${order}${limit}`;
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
      };
      return builder;
    },
    async rpc(name, args = {}) {
      const keys = Object.keys(args);
      const text = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
      const values = keys.map((k) =>
        args[k] !== null && typeof args[k] === "object" && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : args[k]);
      rpcLog.push(name);
      try {
        return { data: (await sql(text, values))[0].r, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  };
  return admin;
}
