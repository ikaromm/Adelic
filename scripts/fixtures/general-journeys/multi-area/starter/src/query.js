export function normalizeQuery(query) {
  return { ...query, pageSize: query.pageSize ?? 20 };
}
