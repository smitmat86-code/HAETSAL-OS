export const onRequest: PagesFunction<{ WORKER_URL: string }> = async (context) => {
  const target = new URL(context.request.url)
  target.protocol = new URL(context.env.WORKER_URL).protocol
  target.host = new URL(context.env.WORKER_URL).host

  const workerRequest = new Request(target.toString(), context.request)
  return fetch(workerRequest)
}
