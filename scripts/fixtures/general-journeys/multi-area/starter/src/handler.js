export function handle(query) {
  return { pageSize: query.pageSize ?? 20 };
}
