/** A module harness exporting its factory only as `default` (the adapter does nothing). */
export default (init) => ({ id: `default-only-${init.name}`, probe: async () => ({ ok: true }), open: async () => ({}) });
