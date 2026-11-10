export async function workspaceFetch(input:RequestInfo | URL, init?:RequestInit) {
  const response = await globalThis.fetch(input,init);
  if (response.status===401) window.dispatchEvent(new Event('a11y-auth-required'));
  return response;
}
